import type { BoundingBox } from '../common/geometry.js';
import type { RawVector } from '../parser/raw-model.js';
import type { SemanticNode } from '../semantic/types.js';
import type { IGridBuilder, TableEngineInput } from './algorithms/types.js';
import type { GridLine, TableCandidate, TableGrid } from './types.js';

/**
 * Build table grids via bordered vector lines or borderless projections.
 */
export class GridBuilder implements IGridBuilder {
  readonly name = 'GridBuilder';

  build(candidate: TableCandidate, input: TableEngineInput): TableGrid | null {
    const bordered = tryBorderedGrid(candidate, input);
    if (bordered && bordered.xs.length >= 3 && bordered.ys.length >= 3) {
      return bordered;
    }

    const borderless = tryBorderlessGrid(candidate, input);
    if (borderless && borderless.xs.length >= 3 && borderless.ys.length >= 3) {
      // Prefer bordered if both exist but bordered was weak
      if (bordered && candidate.hasVectorBorders) {
        return {
          ...bordered,
          kind: 'mixed',
          confidence: Math.max(bordered.confidence, borderless.confidence),
        };
      }
      return borderless;
    }

    return bordered ?? borderless;
  }
}

function tryBorderedGrid(
  candidate: TableCandidate,
  input: TableEngineInput,
): TableGrid | null {
  const page = input.raw.pages.find((p) => p.index === candidate.pageIndex);
  if (!page) return null;

  const lines: GridLine[] = [];
  for (const v of page.vectors) {
    if (!intersects(v.bbox, expand(candidate.bbox, 4))) continue;
    lines.push(...vectorToLines(v));
  }

  if (lines.length < 2) return null;

  const vLines = lines.filter((l) => l.orientation === 'v');
  const hLines = lines.filter((l) => l.orientation === 'h');
  const xs = snap(vLines.map((l) => l.position), 3);
  const ys = snap(hLines.map((l) => l.position), 3);

  // Ensure outer bbox edges are included
  ensureEdge(xs, candidate.bbox.x, candidate.bbox.x + candidate.bbox.width);
  ensureEdge(ys, candidate.bbox.y, candidate.bbox.y + candidate.bbox.height);

  if (xs.length < 3 || ys.length < 3) return null;

  return {
    xs: xs.sort((a, b) => a - b),
    ys: ys.sort((a, b) => a - b),
    kind: 'bordered',
    lines,
    confidence: 0.85,
  };
}

function tryBorderlessGrid(
  candidate: TableCandidate,
  input: TableEngineInput,
): TableGrid | null {
  const nodes = candidate.nodeIds
    .map((id) => input.semantic.nodes[id])
    .filter((n): n is SemanticNode => !!n?.bbox);

  if (nodes.length < 4) return null;

  const centersX = nodes.map((n) => n.bbox!.x + n.bbox!.width / 2);
  const centersY = nodes.map((n) => n.bbox!.y + n.bbox!.height / 2);
  const tol = medianFont(nodes) * 0.55;

  const colCenters = snap(centersX, tol);
  const rowCenters = snap(centersY, tol);
  if (colCenters.length < 2 || rowCenters.length < 2) return null;

  // Build separators midway between centers, plus outer edges
  const xs = boundariesFromCenters(colCenters, candidate.bbox.x, candidate.bbox.x + candidate.bbox.width);
  const ys = boundariesFromCenters(rowCenters, candidate.bbox.y, candidate.bbox.y + candidate.bbox.height);

  if (xs.length < 3 || ys.length < 3) return null;

  return {
    xs,
    ys,
    kind: 'borderless',
    lines: [],
    confidence: 0.7,
  };
}

function boundariesFromCenters(centers: number[], min: number, max: number): number[] {
  const c = [...centers].sort((a, b) => a - b);
  const bounds = [min];
  for (let i = 0; i < c.length - 1; i++) {
    bounds.push((c[i]! + c[i + 1]!) / 2);
  }
  bounds.push(max);
  return snap(bounds, 2);
}

/**
 * Path commands may be in the path's local space (with the CTM in
 * `transform`) or already in page space. Use whichever matches the bbox.
 */
function pageSpaceCommands(v: RawVector): RawVector['pathCommands'] {
  const [a, b, c, d, e, f] = v.transform ?? [1, 0, 0, 1, 0, 0];
  if (a === 1 && b === 0 && c === 0 && d === 1 && e === 0 && f === 0) return v.pathCommands;
  const box = v.bbox;
  const inBox = (x: number, y: number) =>
    x >= box.x - 2 && x <= box.x + box.width + 2 && y >= box.y - 2 && y <= box.y + box.height + 2;
  const pts = v.pathCommands.flatMap((cmd) =>
    'x' in cmd && 'y' in cmd ? [[cmd.x as number, cmd.y as number] as const] : [],
  );
  if (pts.every(([x, y]) => inBox(x, y))) return v.pathCommands;
  // Rotated or skewed paths are not ruling lines; only axis-aligned CTMs map cleanly.
  if (b !== 0 || c !== 0) return [];
  return v.pathCommands.map((cmd) => {
    if (cmd.op === 're') {
      return { ...cmd, x: a * cmd.x + e, y: d * cmd.y + f, w: a * cmd.w, h: d * cmd.h };
    }
    if ('x' in cmd && 'y' in cmd) {
      return { ...cmd, x: a * (cmd.x as number) + e, y: d * (cmd.y as number) + f };
    }
    return cmd;
  }) as RawVector['pathCommands'];
}

export function vectorToLines(v: RawVector): GridLine[] {
  const out: GridLine[] = [];
  let cx = 0;
  let cy = 0;
  for (const cmd of pageSpaceCommands(v)) {
    if (cmd.op === 'm') {
      cx = cmd.x;
      cy = cmd.y;
    } else if (cmd.op === 'l') {
      const dx = Math.abs(cmd.x - cx);
      const dy = Math.abs(cmd.y - cy);
      if (dx < 1 && dy > 4) {
        out.push({
          orientation: 'v',
          position: cx,
          start: Math.min(cy, cmd.y),
          end: Math.max(cy, cmd.y),
          strokeWidth: v.strokeWidth,
        });
      } else if (dy < 1 && dx > 4) {
        out.push({
          orientation: 'h',
          position: cy,
          start: Math.min(cx, cmd.x),
          end: Math.max(cx, cmd.x),
          strokeWidth: v.strokeWidth,
        });
      }
      cx = cmd.x;
      cy = cmd.y;
    } else if (cmd.op === 're') {
      const x0 = Math.min(cmd.x, cmd.x + cmd.w);
      const y0 = Math.min(cmd.y, cmd.y + cmd.h);
      const x1 = Math.max(cmd.x, cmd.x + cmd.w);
      const y1 = Math.max(cmd.y, cmd.y + cmd.h);
      out.push(
        { orientation: 'v', position: x0, start: y0, end: y1, strokeWidth: v.strokeWidth },
        { orientation: 'v', position: x1, start: y0, end: y1, strokeWidth: v.strokeWidth },
        { orientation: 'h', position: y0, start: x0, end: x1, strokeWidth: v.strokeWidth },
        { orientation: 'h', position: y1, start: x0, end: x1, strokeWidth: v.strokeWidth },
      );
    }
  }
  return out;
}

function snap(values: number[], tol: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) {
    if (out.length === 0 || Math.abs(out[out.length - 1]! - v) > tol) out.push(v);
    else out[out.length - 1] = (out[out.length - 1]! + v) / 2;
  }
  return out;
}

function ensureEdge(arr: number[], a: number, b: number): void {
  if (!arr.some((x) => Math.abs(x - a) < 4)) arr.push(a);
  if (!arr.some((x) => Math.abs(x - b) < 4)) arr.push(b);
}

function expand(b: BoundingBox, pad: number): BoundingBox {
  return {
    x: b.x - pad,
    y: b.y - pad,
    width: b.width + pad * 2,
    height: b.height + pad * 2,
  };
}

function intersects(a: BoundingBox, b: BoundingBox): boolean {
  return !(
    a.x + a.width < b.x ||
    b.x + b.width < a.x ||
    a.y + a.height < b.y ||
    b.y + b.height < a.y
  );
}

function medianFont(nodes: SemanticNode[]): number {
  const sizes: number[] = [];
  for (const n of nodes) {
    if ('runs' in n && n.runs[0]?.fontSize) sizes.push(n.runs[0].fontSize);
  }
  if (sizes.length === 0) return 12;
  sizes.sort((a, b) => a - b);
  return sizes[Math.floor(sizes.length / 2)]!;
}
