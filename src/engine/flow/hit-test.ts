/**
 * Flow-level hit testing — lines and caret positions (Word-style).
 */

import type { TextLine } from './types';
import { getRunBounds } from './metrics';
import { segmentAtIndex } from './reflow';

/** Hit-test: find the TextLine under a PDF coordinate. */
export function hitTestTextLine(
  pdfX: number,
  pdfY: number,
  lines: TextLine[],
): TextLine | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const pad = Math.max(3, line.fontSize * 0.15);
    const left = line.x - pad;
    const right = line.rightEdge + pad;
    const bottom = line.y - pad;
    const top = line.y + line.height + pad;

    if (pdfX >= left && pdfX <= right && pdfY >= bottom && pdfY <= top) {
      return line;
    }
  }
  return null;
}

/** Find nearest line within maxDistance PDF units. */
export function findNearestTextLine(
  pdfX: number,
  pdfY: number,
  lines: TextLine[],
  maxDistance: number = 15,
): TextLine | null {
  let best: TextLine | null = null;
  let bestDist = maxDistance;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const left = line.x;
    const right = line.rightEdge;
    const bottom = line.y;
    const top = line.y + line.height;

    const dx = pdfX < left ? left - pdfX : pdfX > right ? pdfX - right : 0;
    const dy = pdfY < bottom ? bottom - pdfY : pdfY > top ? pdfY - top : 0;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < bestDist) {
      bestDist = dist;
      best = line;
    }
  }

  return best;
}

/**
 * Map PDF x coordinate to character index within a line.
 * Uses glyph midpoint boundaries; advances by unicode length (not glyph count).
 */
export function caretIndexFromLineX(pdfX: number, line: TextLine): number {
  if (line.runs.length === 0) return 0;

  let charOffset = 0;
  let bestIndex = 0;
  let bestDist = Infinity;

  for (let r = 0; r < line.runs.length; r++) {
    const run = line.runs[r];
    for (let g = 0; g < run.glyphs.length; g++) {
      const glyph = run.glyphs[g];
      const mid = glyph.tRm.e + glyph.width / 2;
      const dist = Math.abs(pdfX - mid);
      // A glyph carries as many characters as its Unicode: 0 for the trailing
      // glyphs of an /ActualText cluster, several for a conjunct or ligature.
      const glyphChars = (glyph.unicode || '').length;
      if (dist < bestDist) {
        bestDist = dist;
        bestIndex = pdfX < mid ? charOffset : charOffset + glyphChars;
      }
      charOffset += glyphChars;
    }
    // If glyphs under-count vs run.text (merged/missing), clamp using run text length
    const runEnd = line.runs.slice(0, r).reduce((n, rr) => n + rr.text.length, 0) + run.text.length;
    if (charOffset < runEnd) charOffset = runEnd;
  }

  if (pdfX > line.rightEdge) return line.text.length;
  return Math.max(0, Math.min(bestIndex, line.text.length));
}

/** Get PDF x for caret at character index within a line. */
export function lineXFromCaretIndex(line: TextLine, charIndex: number): number {
  if (charIndex <= 0) {
    const first = line.runs[0];
    if (first?.glyphs.length) return first.glyphs[0].tRm.e;
    return line.x;
  }
  if (charIndex >= line.text.length) {
    const lastRun = line.runs[line.runs.length - 1];
    if (lastRun?.glyphs.length) {
      const g = lastRun.glyphs[lastRun.glyphs.length - 1];
      return g.tRm.e + g.width;
    }
    return line.rightEdge;
  }

  // Walk glyphs by the characters they carry (a Devanagari cluster may be one
  // glyph with several characters, or several glyphs with one /ActualText).
  let offset = 0;
  let clusterRight = -Infinity;
  let afterCluster = false;
  for (let r = 0; r < line.runs.length; r++) {
    const run = line.runs[r];
    let pos = offset;
    for (let g = 0; g < run.glyphs.length; g++) {
      const glyph = run.glyphs[g];
      const len = (glyph.unicode || '').length;
      if (len === 0) {
        clusterRight = Math.max(clusterRight, glyph.tRm.e + glyph.width);
        continue;
      }
      if (afterCluster || pos === charIndex) return glyph.tRm.e;
      if (charIndex > pos && charIndex < pos + len) return glyph.tRm.e + glyph.width;
      pos += len;
      clusterRight = glyph.tRm.e + glyph.width;
      if (pos === charIndex) afterCluster = true;
    }
    offset += run.text.length;
  }
  if (afterCluster && clusterRight > -Infinity) return clusterRight;

  const seg = segmentAtIndex(line, charIndex);
  if (seg) {
    const bounds = getRunBounds(seg.run);
    return bounds.right;
  }
  return line.x;
}
