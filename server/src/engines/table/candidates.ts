import { bboxFromPoints, type BoundingBox } from '../common/geometry.js';
import type { SemanticNode } from '../semantic/types.js';
import type { ITableCandidateDetector, TableEngineInput } from './algorithms/types.js';
import { vectorToLines } from './grid.js';
import type { TableCandidate } from './types.js';

// Headings/titles are allowed — short bold header cells are often typed as
// headings by the semantic stage and must still join table lattices.
const SKIP_TYPES = new Set([
  'list',
  'list_item',
  'code_block',
  'image',
  'hyperlink',
  'section',
  'subsection',
  'document',
  'table',
]);

/**
 * Find page regions where text blocks form a regular lattice (≥2×2).
 */
export class TableCandidateDetector implements ITableCandidateDetector {
  readonly name = 'TableCandidateDetector';

  detect(input: TableEngineInput): TableCandidate[] {
    const byPage = new Map<number, SemanticNode[]>();

    for (const id of input.semantic.readingOrder) {
      const node = input.semantic.nodes[id];
      if (!node || !node.bbox) continue;
      if (SKIP_TYPES.has(node.type)) continue;
      if (!('text' in node) || !node.text?.trim()) continue;
      let arr = byPage.get(node.pageIndex);
      if (!arr) {
        arr = [];
        byPage.set(node.pageIndex, arr);
      }
      arr.push(node);
    }

    const out: TableCandidate[] = [];
    for (const [pageIndex, allNodes] of byPage) {
      // Ruled grids are found from their lines first: a row of cells is often
      // one text line, which a centre-lattice cannot split into columns.
      const grids = ruledGridBounds(input, pageIndex);
      const claimed = new Set<string>();
      for (const bbox of grids) {
        const inside = allNodes.filter((n) => centreInside(n.bbox!, bbox));
        if (inside.length < 2) continue;
        for (const n of inside) claimed.add(n.id);
        out.push({
          pageIndex,
          bbox,
          nodeIds: inside.map((n) => n.id),
          score: 0.95,
          hasVectorBorders: true,
        });
      }
      const nodes = allNodes.filter((n) => !claimed.has(n.id));
      if (nodes.length < 4) {
        // Still allow if vectors suggest a grid
        const hasBorders = pageHasTableVectors(input, pageIndex);
        if (!hasBorders) continue;
      }

      const clusters = clusterLattice(nodes);
      for (const cluster of clusters) {
        if (cluster.nodeIds.length < 4) continue;
        if (!hasMultiCellRows(cluster.nodeIds.map((id) => input.semantic.nodes[id]!))) continue;
        const hasVectorBorders = pageHasTableVectors(input, pageIndex, cluster.bbox);
        const score =
          0.4 +
          Math.min(0.4, cluster.regularity) +
          (hasVectorBorders ? 0.2 : 0) +
          Math.min(0.1, cluster.nodeIds.length / 40);

        out.push({
          pageIndex,
          bbox: cluster.bbox,
          nodeIds: cluster.nodeIds,
          score,
          hasVectorBorders,
        });
      }
    }

    return out.sort((a, b) => b.score - a.score);
  }
}

function clusterLattice(nodes: SemanticNode[]): Array<{
  nodeIds: string[];
  bbox: BoundingBox;
  regularity: number;
}> {
  // Greedy: take all text nodes on page that share column/row alignment as one candidate
  // Split into separate tables if there's a large vertical gap
  const sorted = [...nodes].sort(
    (a, b) =>
      (b.bbox!.y + b.bbox!.height) - (a.bbox!.y + a.bbox!.height) ||
      a.bbox!.x - b.bbox!.x,
  );

  const groups: SemanticNode[][] = [];
  let current: SemanticNode[] = [];

  for (const n of sorted) {
    if (current.length === 0) {
      current.push(n);
      continue;
    }
    const prev = current[current.length - 1]!;
    const gap =
      (prev.bbox!.y) - (n.bbox!.y + n.bbox!.height);
    // Large gap → new table candidate
    if (gap > 48) {
      groups.push(current);
      current = [n];
    } else {
      current.push(n);
    }
  }
  if (current.length) groups.push(current);

  return groups
    .map((group) => {
      const xs = snapPositions(group.map((g) => g.bbox!.x + g.bbox!.width / 2), 8);
      const ys = snapPositions(
        group.map((g) => g.bbox!.y + g.bbox!.height / 2),
        8,
      );
      const cols = xs.length;
      const rows = ys.length;
      if (cols < 2 || rows < 2) {
        return null;
      }
      // Regularity: how well nodes fill the grid
      const expected = cols * rows;
      const regularity = Math.min(1, group.length / Math.max(expected * 0.5, 1));
      const bbox = bboxFromPoints(
        group.flatMap((g) => [
          { x: g.bbox!.x, y: g.bbox!.y },
          { x: g.bbox!.x + g.bbox!.width, y: g.bbox!.y + g.bbox!.height },
        ]),
      );
      return {
        nodeIds: group.map((g) => g.id),
        bbox,
        regularity,
      };
    })
    .filter((c): c is NonNullable<typeof c> => c != null);
}

function snapPositions(values: number[], tol: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) {
    if (out.length === 0 || Math.abs(out[out.length - 1]! - v) > tol) {
      out.push(v);
    }
  }
  return out;
}

function pageHasTableVectors(
  input: TableEngineInput,
  pageIndex: number,
  bbox?: BoundingBox,
): boolean {
  const page = input.raw.pages.find((p) => p.index === pageIndex);
  if (!page) return false;
  let lines = 0;
  for (const v of page.vectors) {
    if (bbox && !intersects(v.bbox, bbox)) continue;
    for (const cmd of v.pathCommands) {
      if (cmd.op === 're') lines += 1;
      if (cmd.op === 'l' || cmd.op === 'm') lines += 0.25;
    }
  }
  return lines >= 2;
}

function intersects(a: BoundingBox, b: BoundingBox): boolean {
  return !(
    a.x + a.width < b.x ||
    b.x + b.width < a.x ||
    a.y + a.height < b.y ||
    b.y + b.height < a.y
  );
}

/**
 * A table has rows with more than one cell side by side. A run of stacked
 * single-line headings and paragraphs only looks like a lattice because the
 * lines have different widths, so require at least half the rows to hold two
 * or more nodes.
 */
function hasMultiCellRows(nodes: SemanticNode[]): boolean {
  const rows = new Map<number, number>();
  for (const n of nodes) {
    const cy = n.bbox!.y + n.bbox!.height / 2;
    const key = [...rows.keys()].find((k) => Math.abs(k - cy) <= 4) ?? cy;
    rows.set(key, (rows.get(key) ?? 0) + 1);
  }
  const multi = [...rows.values()].filter((c) => c >= 2).length;
  return multi >= 1 && multi * 2 >= rows.size;
}

function centreInside(b: BoundingBox, outer: BoundingBox): boolean {
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  return cx >= outer.x && cx <= outer.x + outer.width && cy >= outer.y && cy <= outer.y + outer.height;
}

/** Bounds of groups of ruling lines that form a grid of at least 2×2 cells. */
function ruledGridBounds(input: TableEngineInput, pageIndex: number): BoundingBox[] {
  const page = input.raw.pages.find((p) => p.index === pageIndex);
  if (!page) return [];
  const lines = page.vectors.flatMap((v) => vectorToLines(v));
  if (lines.length < 6) return [];

  const boxes = lines.map((l) =>
    l.orientation === 'h'
      ? { x: l.start, y: l.position, width: l.end - l.start, height: 0 }
      : { x: l.position, y: l.start, width: 0, height: l.end - l.start },
  );
  // Union-find over touching lines.
  const parent = boxes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (intersects(grow(boxes[i]!, 2), boxes[j]!)) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, number[]>();
  boxes.forEach((_, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), i]);
  });

  const out: BoundingBox[] = [];
  for (const members of groups.values()) {
    const hs = distinct(members.filter((i) => lines[i]!.orientation === 'h').map((i) => lines[i]!.position));
    const vs = distinct(members.filter((i) => lines[i]!.orientation === 'v').map((i) => lines[i]!.position));
    if (hs.length < 3 || vs.length < 3) continue;
    const bbox = bboxFromPoints(
      members.flatMap((i) => [
        { x: boxes[i]!.x, y: boxes[i]!.y },
        { x: boxes[i]!.x + boxes[i]!.width, y: boxes[i]!.y + boxes[i]!.height },
      ]),
    );
    // A page frame is not a table.
    if (bbox.width > page.width * 0.95 && bbox.height > page.height * 0.9) continue;
    out.push(bbox);
  }
  return out;
}

function distinct(values: number[]): number[] {
  return snapPositions(values, 2);
}

function grow(b: BoundingBox, pad: number): BoundingBox {
  return { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 };
}
