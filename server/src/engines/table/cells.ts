import { createId } from '../../utils/id.js';
import { bboxFromPoints, type BoundingBox } from '../common/geometry.js';
import type { RawPage } from '../parser/raw-model.js';
import type { SemanticNode, SemanticRun } from '../semantic/types.js';
import type { ICellFiller, ICellMerger, TableEngineInput } from './algorithms/types.js';
import type { LogicalCell, TableCandidate, TableGrid } from './types.js';

export class CellFiller implements ICellFiller {
  readonly name = 'CellFiller';

  fill(
    grid: TableGrid,
    candidate: TableCandidate,
    input: TableEngineInput,
  ): LogicalCell[] {
    const colCount = grid.xs.length - 1;
    const rowCount = grid.ys.length - 1;
    if (colCount < 1 || rowCount < 1) return [];

    // ys are bottom-up in PDF; row 0 = top visually = highest y band
    const rowBands = buildRowBands(grid.ys);
    const cells: LogicalCell[] = [];
    const tableId = 'pending'; // filled by engine

    const buckets = new Map<string, SemanticNode[]>();
    for (let r = 0; r < rowCount; r++) {
      for (let c = 0; c < colCount; c++) {
        buckets.set(`${r},${c}`, []);
      }
    }

    const words = ruledRowWords(grid, candidate, input);
    if (words) {
      for (const w of words) {
        const col = findIndex(grid.xs, w.bbox!.x + w.bbox!.width / 2);
        const row = findRowIndex(rowBands, w.bbox!.y + w.bbox!.height / 2);
        if (col < 0 || row < 0) continue;
        buckets.get(`${row},${col}`)?.push(w);
      }
    }

    for (const id of words ? [] : candidate.nodeIds) {
      const node = input.semantic.nodes[id];
      if (!node?.bbox) continue;
      const cx = node.bbox.x + node.bbox.width / 2;
      const cy = node.bbox.y + node.bbox.height / 2;
      const col = findIndex(grid.xs, cx);
      const row = findRowIndex(rowBands, cy);
      if (col < 0 || row < 0) continue;
      buckets.get(`${row},${col}`)?.push(node);
    }

    for (let r = 0; r < rowCount; r++) {
      for (let c = 0; c < colCount; c++) {
        const nodes = buckets.get(`${r},${c}`) ?? [];
        nodes.sort((a, b) => a.readingOrderIndex - b.readingOrderIndex);
        const bbox = cellBBox(grid, r, c, rowBands);
        const text = nodes
          .map((n) => ('text' in n ? String(n.text ?? '') : ''))
          .filter(Boolean)
          .join(' ')
          .trim();
        const allRuns: SemanticRun[] = nodes.flatMap((n) =>
          'runs' in n && Array.isArray(n.runs) ? n.runs : [],
        );
        // Word-split cells carry one run per word; keep a single styled run.
        const runs = words && allRuns[0] ? [{ ...allRuns[0], text }] : allRuns;
        const contentBBox = nodes.some((n) => n.bbox)
          ? bboxFromPoints(
              nodes.flatMap((n) =>
                n.bbox
                  ? [
                      { x: n.bbox.x, y: n.bbox.y },
                      { x: n.bbox.x + n.bbox.width, y: n.bbox.y + n.bbox.height },
                    ]
                  : [],
              ),
            )
          : undefined;

        cells.push({
          id: createId('tcell'),
          parentId: tableId,
          childIds: [],
          rowIndex: r,
          colIndex: c,
          rowSpan: 1,
          colSpan: 1,
          bbox,
          contentBBox,
          text,
          runs,
          alignment: inferAlign(nodes, bbox),
          padding: { top: 2, right: 2, bottom: 2, left: 2 },
          contentNodeIds: [...new Set(nodes.map((n) => n.id))],
          confidence: nodes.length ? 0.85 : 0.4,
        });
      }
    }

    return cells;
  }
}

export class CellMerger implements ICellMerger {
  readonly name = 'CellMerger';

  merge(cells: LogicalCell[], grid: TableGrid): LogicalCell[] {
    const colCount = grid.xs.length - 1;
    const rowCount = grid.ys.length - 1;
    const byKey = new Map(cells.map((c) => [`${c.rowIndex},${c.colIndex}`, c]));
    const absorbed = new Set<string>();

    // Horizontal merges: empty neighbors to the right of a filled cell that
    // visually spans (content extent reaches into the empty slot) or, in
    // bordered mode, when no vertical separator sits between the slots.
    for (let r = 0; r < rowCount; r++) {
      for (let c = 0; c < colCount; c++) {
        const cell = byKey.get(`${r},${c}`);
        if (!cell || absorbed.has(cell.id) || !cell.text.trim()) continue;

        const contentRight = contentRightEdge(cell);
        let span = 1;
        while (c + span < colCount) {
          const next = byKey.get(`${r},${c + span}`);
          if (!next || absorbed.has(next.id) || next.text.trim()) break;

          const nextMid = next.bbox.x + next.bbox.width * 0.35;
          const reaches = contentRight >= nextMid;
          const noVSep =
            grid.kind === 'bordered' &&
            !hasVerticalLineNear(grid, grid.xs[c + span]!);

          if (!reaches && !noVSep && contentRight < next.bbox.x) break;

          absorbed.add(next.id);
          span++;
        }
        if (span > 1) {
          cell.colSpan = span;
          cell.bbox = {
            x: grid.xs[c]!,
            y: cell.bbox.y,
            width: grid.xs[c + span]! - grid.xs[c]!,
            height: cell.bbox.height,
          };
          cell.confidence = Math.min(0.95, cell.confidence + 0.05);
        }
      }
    }

    // Vertical merges: empty cell below
    for (let c = 0; c < colCount; c++) {
      for (let r = 0; r < rowCount; r++) {
        const cell = byKey.get(`${r},${c}`);
        if (!cell || absorbed.has(cell.id) || !cell.text) continue;
        let span = 1;
        while (r + span < rowCount) {
          const next = byKey.get(`${r + span},${c}`);
          if (!next || absorbed.has(next.id) || next.text.trim()) break;
          absorbed.add(next.id);
          span++;
        }
        if (span > 1) {
          cell.rowSpan = span;
          cell.confidence = Math.min(0.95, cell.confidence + 0.05);
        }
      }
    }

    return cells.filter((c) => !absorbed.has(c.id));
  }
}

/**
 * When a text node runs across a ruled column line (a whole table row read as
 * one line), split it back into cells using the parser's word positions.
 * Words are wrapped as paragraph-shaped nodes carrying the row's run style.
 */
function ruledRowWords(
  grid: TableGrid,
  candidate: TableCandidate,
  input: TableEngineInput,
): SemanticNode[] | null {
  if (grid.kind === 'borderless') return null;
  const inner = grid.xs.slice(1, -1);
  const nodes = candidate.nodeIds
    .map((id) => input.semantic.nodes[id])
    .filter((n): n is SemanticNode => !!n?.bbox);
  const spans = nodes.some((n) =>
    inner.some((x) => n.bbox!.x < x - 2 && n.bbox!.x + n.bbox!.width > x + 2),
  );
  if (!spans) return null;
  const page = input.raw.pages.find((p) => p.index === candidate.pageIndex);
  if (!page) return null;
  const pageWords = page.words.length > 0 ? page.words : wordsFromCharacters(page.characters);

  const out: SemanticNode[] = [];
  for (const w of pageWords) {
    const cx = w.bbox.x + w.bbox.width / 2;
    const cy = w.bbox.y + w.bbox.height / 2;
    const b = candidate.bbox;
    if (cx < b.x || cx > b.x + b.width || cy < b.y || cy > b.y + b.height) continue;
    if (!w.text.trim()) continue;
    const onLine = (n: SemanticNode) => cy >= n.bbox!.y - 1 && cy <= n.bbox!.y + n.bbox!.height + 1;
    const source =
      nodes.find((n) => onLine(n) && cx >= n.bbox!.x - 1 && cx <= n.bbox!.x + n.bbox!.width + 1) ??
      nodes.find(onLine);
    const style = source && 'runs' in source && Array.isArray(source.runs) ? source.runs[0] : undefined;
    out.push({
      id: source?.id ?? w.id,
      type: 'paragraph',
      parentId: null,
      childIds: [],
      // Top-to-bottom, then left-to-right, so words join in reading order.
      readingOrderIndex: -w.bbox.y * 10_000 + w.bbox.x,
      confidence: 0.85,
      pageIndex: candidate.pageIndex,
      bbox: w.bbox,
      sourceBlockIds: source?.sourceBlockIds ?? [],
      text: w.text,
      runs: [{ ...(style ?? {}), id: createId('srun'), text: w.text }],
    } as SemanticNode);
  }
  return out.length > 0 ? out : null;
}

/** Group characters into words at spaces, line changes and wide gaps. */
function wordsFromCharacters(
  chars: RawPage['characters'],
): Array<{ id: string; text: string; bbox: BoundingBox }> {
  const words: Array<{ id: string; text: string; bbox: BoundingBox }> = [];
  let cur: { id: string; text: string; bbox: BoundingBox } | null = null;
  for (const ch of chars) {
    const text = ch.unicode ?? '';
    if (!text.trim()) {
      cur = null;
      continue;
    }
    const b = ch.bbox;
    if (
      cur &&
      Math.abs(cur.bbox.y - b.y) <= ch.fontSize * 0.3 &&
      b.x - (cur.bbox.x + cur.bbox.width) <= ch.fontSize * 0.25 &&
      b.x >= cur.bbox.x
    ) {
      const right = Math.max(cur.bbox.x + cur.bbox.width, b.x + b.width);
      const top = Math.max(cur.bbox.y + cur.bbox.height, b.y + b.height);
      cur.bbox = { x: cur.bbox.x, y: Math.min(cur.bbox.y, b.y), width: 0, height: 0 };
      cur.bbox.width = right - cur.bbox.x;
      cur.bbox.height = top - cur.bbox.y;
      cur.text += text;
    } else {
      cur = { id: ch.id, text, bbox: { ...b } };
      words.push(cur);
    }
  }
  return words;
}

function buildRowBands(ys: number[]): Array<{ lo: number; hi: number }> {
  // ys ascending (bottom to top in PDF). Row 0 = top = last band
  const sorted = [...ys].sort((a, b) => a - b);
  const bands: Array<{ lo: number; hi: number }> = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    bands.push({ lo: sorted[i]!, hi: sorted[i + 1]! });
  }
  // Reverse so index 0 is top
  return bands.reverse();
}

function findIndex(edges: number[], value: number): number {
  for (let i = 0; i < edges.length - 1; i++) {
    if (value >= edges[i]! - 0.5 && value < edges[i + 1]! + 0.5) return i;
  }
  // Clamp to nearest
  if (value < edges[0]!) return 0;
  if (value >= edges[edges.length - 1]!) return Math.max(0, edges.length - 2);
  return -1;
}

function findRowIndex(bands: Array<{ lo: number; hi: number }>, y: number): number {
  for (let i = 0; i < bands.length; i++) {
    if (y >= bands[i]!.lo - 0.5 && y < bands[i]!.hi + 0.5) return i;
  }
  return -1;
}

function cellBBox(
  grid: TableGrid,
  row: number,
  col: number,
  rowBands: Array<{ lo: number; hi: number }>,
): BoundingBox {
  const band = rowBands[row]!;
  return {
    x: grid.xs[col]!,
    y: band.lo,
    width: grid.xs[col + 1]! - grid.xs[col]!,
    height: band.hi - band.lo,
  };
}

function contentRightEdge(cell: LogicalCell): number {
  if (cell.contentBBox) {
    return cell.contentBBox.x + cell.contentBBox.width;
  }
  if (cell.text) {
    const fs = cell.runs[0]?.fontSize ?? 12;
    return cell.bbox.x + cell.text.length * fs * 0.55;
  }
  return cell.bbox.x;
}

function hasVerticalLineNear(grid: TableGrid, x: number): boolean {
  return grid.lines.some(
    (l) => l.orientation === 'v' && Math.abs(l.position - x) < 2,
  );
}

function inferAlign(
  nodes: SemanticNode[],
  cell: BoundingBox,
): LogicalCell['alignment'] {
  if (nodes.length === 0) return 'left';
  let left = 0;
  let center = 0;
  let right = 0;
  for (const n of nodes) {
    if (!n.bbox) continue;
    const mid = n.bbox.x + n.bbox.width / 2;
    const cellMid = cell.x + cell.width / 2;
    if (Math.abs(mid - cellMid) < cell.width * 0.15) center++;
    else if (n.bbox.x + n.bbox.width > cell.x + cell.width * 0.7) right++;
    else left++;
  }
  if (center >= left && center >= right) return 'center';
  if (right > left) return 'right';
  return 'left';
}
