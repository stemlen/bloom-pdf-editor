import type { DrawnPath } from './types';

export interface CssRect { x: number; y: number; width: number; height: number }

function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-8) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Bounding box of a drawn path in canvas CSS pixels, including stroke width. */
export function drawnPathBounds(path: DrawnPath): CssRect | null {
  const pts = (path.kind ?? 'freehand') !== 'freehand' && path.start && path.end
    ? [path.start, path.end]
    : path.points;
  if (pts.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  const pad = path.size / 2;
  return { x: minX - pad, y: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 };
}

/** Topmost drawn path within `tolerance` CSS px of (x, y), for the Select tool (BE-307). */
export function hitTestDrawnPath(paths: DrawnPath[], x: number, y: number, tolerance = 4): DrawnPath | null {
  for (let i = paths.length - 1; i >= 0; i--) {
    const path = paths[i];
    const reach = path.size / 2 + tolerance;
    const kind = path.kind ?? 'freehand';
    if (kind !== 'freehand' && path.start && path.end) {
      const { start: a, end: b } = path;
      if (kind === 'line' || kind === 'arrow') {
        if (distToSegment(x, y, a.x, a.y, b.x, b.y) <= reach) return path;
        continue;
      }
      const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
      const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
      if (kind === 'rectangle') {
        const inOuter = x >= minX - reach && x <= maxX + reach && y >= minY - reach && y <= maxY + reach;
        const inInner = x > minX + reach && x < maxX - reach && y > minY + reach && y < maxY - reach;
        if (inOuter && !inInner) return path;
        continue;
      }
      // Ellipse: compare the normalised radius with 1, within the stroke reach.
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      const rx = Math.max((maxX - minX) / 2, 0.5), ry = Math.max((maxY - minY) / 2, 0.5);
      const r = Math.hypot((x - cx) / rx, (y - cy) / ry);
      if (Math.abs(r - 1) * Math.min(rx, ry) <= reach) return path;
      continue;
    }
    const pts = path.points;
    if (pts.length === 1 && Math.hypot(x - pts[0].x, y - pts[0].y) <= reach) return path;
    for (let j = 1; j < pts.length; j++) {
      if (distToSegment(x, y, pts[j - 1].x, pts[j - 1].y, pts[j].x, pts[j].y) <= reach) return path;
    }
  }
  return null;
}
