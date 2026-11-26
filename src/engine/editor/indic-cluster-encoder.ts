/**
 * Re-encode edited complex-script text with glyphs the page already uses.
 *
 * Shaped Devanagari can't be encoded character by character: a printed word is
 * a sequence of glyph clusters (conjuncts, reph, pre-base ि) and subset or
 * Type3 fonts (Chromium prints Hindi as Type3) hold only the glyphs that page
 * needed, with no shaping tables. But the page itself records which glyphs draw
 * each cluster: every /ActualText span (and every 1:1 ToUnicode glyph) is a
 * cluster → glyph-sequence sample. New text whose clusters all occur on the
 * page is rebuilt from those exact glyphs, fonts and relative offsets, and each
 * cluster is wrapped in its own /ActualText so the text layer stays logical.
 */

import type { CSInstruction } from '../content/operator-lexer';
import type { TextRun } from '../content/interpreter';
import type { FontData } from '../fonts/font-parser';
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber } from '../types';
import { isComplexScriptCodePoint } from '../render/glyph-outlines';

interface ClusterGlyph {
  fontName: string;
  code: number;
  /** Offset from the cluster origin, page units */
  dx: number;
  dy: number;
  /** Advance width, page units */
  width: number;
}

interface GlyphCluster {
  text: string;
  glyphs: ClusterGlyph[];
  /** Cluster origin to the end of its last advance, page units */
  advance: number;
  /** Effective (page) font size */
  size: number;
}

export type ClusterInventory = Map<string, GlyphCluster[]>;

/** True when text holds a script that needs shaping (Indic, Arabic, …). */
export function hasComplexScriptText(text: string): boolean {
  for (const ch of text) if (isComplexScriptCodePoint(ch.codePointAt(0) ?? 0)) return true;
  return false;
}

function effectiveSize(t: { b: number; c: number; d: number; a: number }): number {
  return Math.sqrt(t.c * t.c + t.d * t.d) || Math.abs(t.a);
}

/** Every cluster drawn on the page, keyed by its Unicode text. */
export function buildClusterInventory(runs: TextRun[]): ClusterInventory {
  const inventory: ClusterInventory = new Map();
  type Raw = { text: string; glyphs: { fontName: string; g: TextRun['glyphs'][number] }[] };
  const raws: Raw[] = [];
  let open: Raw | null = null;

  for (const run of runs) {
    for (const g of run.glyphs) {
      if (g.actualText && g.unicode === '') {
        if (open) open.glyphs.push({ fontName: run.fontName, g });
        continue;
      }
      if (!g.unicode) {
        open = null;
        continue;
      }
      open = { text: g.unicode, glyphs: [{ fontName: run.fontName, g }] };
      raws.push(open);
      // A 1:1 glyph never continues; only /ActualText spans collect followers.
      if (!g.actualText) open = null;
    }
  }

  for (const raw of raws) {
    // Upright, unrotated text only.
    if (raw.glyphs.some(({ g }) => Math.abs(g.tRm.b) > 1e-3 || Math.abs(g.tRm.c) > 1e-3)) continue;
    const size = effectiveSize(raw.glyphs[0].g.tRm);
    if (!(size > 0)) continue;
    let origin = Infinity;
    let right = -Infinity;
    let base = raw.glyphs[0].g;
    for (const { g } of raw.glyphs) {
      origin = Math.min(origin, g.tRm.e);
      right = Math.max(right, g.tRm.e + g.width);
      if (g.width > base.width) base = g;
    }
    const cluster: GlyphCluster = {
      text: raw.text,
      size,
      advance: right - origin,
      glyphs: raw.glyphs.map(({ fontName, g }) => ({
        fontName,
        code: g.charCode,
        dx: g.tRm.e - origin,
        dy: g.tRm.f - base.tRm.f,
        width: g.width,
      })),
    };
    const list = inventory.get(raw.text);
    if (list) list.push(cluster);
    else inventory.set(raw.text, [cluster]);
  }
  return inventory;
}

/**
 * Split `text` into clusters found in the inventory at `size` (greedy longest
 * match), preferring samples drawn with `preferredFonts`. Spaces need no sample.
 * Returns null when any part of the text has no sample.
 */
function segment(
  text: string,
  inventory: ClusterInventory,
  size: number,
  preferredFonts: Set<string>,
): (GlyphCluster | ' ')[] | null {
  let maxKey = 1;
  for (const key of inventory.keys()) maxKey = Math.max(maxKey, key.length);

  const pick = (key: string): GlyphCluster | null => {
    const samples = inventory.get(key)?.filter(c => Math.abs(c.size - size) <= size * 0.02);
    if (!samples?.length) return null;
    const score = (c: GlyphCluster) => c.glyphs.filter(g => preferredFonts.has(g.fontName)).length / c.glyphs.length;
    return samples.reduce((best, c) => (score(c) > score(best) ? c : best));
  };

  const out: (GlyphCluster | ' ')[] = [];
  let i = 0;
  while (i < text.length) {
    let found: GlyphCluster | null = null;
    let len = Math.min(maxKey, text.length - i);
    for (; len > 0 && !found; len--) {
      // Never end a match before a combining mark or at a ZWJ. (A sample may
      // end in a virama: Chromium draws half forms like "न्" as clusters.)
      const end = i + len;
      if (end < text.length && (/\p{M}/u.test(text[end]) || text[end] === '‍' || text[end - 1] === '‍')) continue;
      found = pick(text.slice(i, end));
      if (found) i = end;
    }
    if (found) {
      out.push(found);
      continue;
    }
    if (text[i] === ' ' || text[i] === ' ') {
      out.push(' ');
      i++;
      continue;
    }
    return null;
  }
  return out;
}

/** Space advance for clustered text (em fraction of the page font size). */
const SPACE_EM = 0.25;

/**
 * Width (page units) `encodeTextFromClusters` gives `text` at page font size
 * `size`, or null when it can't encode it.
 */
export function measureTextFromClusters(
  text: string,
  inventory: ClusterInventory,
  size: number,
  preferredFonts: Set<string> = new Set(),
): number | null {
  const pieces = segment(text, inventory, size, preferredFonts);
  if (!pieces) return null;
  return pieces.reduce((w, p) => w + (p === ' ' ? size * SPACE_EM : p.advance), 0);
}

function utf16Hex(text: string): string {
  let hex = 'FEFF';
  for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return hex;
}

function op(operator: string, operands: CSInstruction['operands'] = []): CSInstruction {
  return { operator, operands, offset: 0 };
}

export interface ClusterEncodeContext {
  /** Tf size in effect for the edited run */
  fontSize: number;
  /** Text matrix × CTM of the edited run (page scale and orientation) */
  matrix: { a: number; d: number };
  /** Page fonts by resource name (composite fonts take 2-byte codes) */
  fonts: Map<string, FontData>;
  /** Fonts used on the edited line, preferred when several samples exist */
  preferredFonts: Set<string>;
}

/**
 * Text-showing operators that draw `text` from page clusters at the current
 * text position (they replace the run's first show operator), or null when a
 * cluster of `text` never occurs on the page at this size.
 */
export function encodeTextFromClusters(
  text: string,
  inventory: ClusterInventory,
  ctx: ClusterEncodeContext,
): CSInstruction[] | null {
  const size = Math.abs(ctx.fontSize * ctx.matrix.d) || Math.abs(ctx.fontSize * ctx.matrix.a);
  const pieces = segment(text, inventory, size, ctx.preferredFonts);
  if (!pieces) return null;

  // Page units → TJ thousandths of text space, and → Ts text-rise units.
  const toTJ = 1000 / (ctx.fontSize * Math.abs(ctx.matrix.a || 1));
  const toRise = 1 / (ctx.matrix.d || 1);
  const spaceAdvance = size * SPACE_EM;

  const ops: CSInstruction[] = [];
  let currentFont = '';
  let pen = 0; // where the text position is, page units from the run start
  let origin = 0; // where the next cluster starts

  for (const piece of pieces) {
    if (piece === ' ') {
      origin += spaceAdvance;
      continue;
    }
    const span = piece.glyphs.length > 1 || [...piece.text].length > 1;
    if (span) {
      ops.push(op('BDC', [new PDFName('Span'), new PDFDict([['ActualText', new PDFHexString(utf16Hex(piece.text))]])]));
    }
    for (const g of piece.glyphs) {
      const font = ctx.fonts.get(g.fontName);
      if (g.fontName !== currentFont) {
        ops.push(op('Tf', [new PDFName(g.fontName), new PDFNumber(ctx.fontSize)]));
        currentFont = g.fontName;
      }
      const hex = g.code.toString(16).padStart(font?.isComposite ? 4 : 2, '0');
      const shift = origin + g.dx - pen;
      const kern = Math.round(-shift * toTJ * 1000) / 1000;
      const items = Math.abs(kern) > 0.01 ? [new PDFNumber(kern), new PDFHexString(hex)] : [new PDFHexString(hex)];
      const rise = Math.abs(g.dy) > 1e-3 ? Math.round(g.dy * toRise * 1000) / 1000 : 0;
      if (rise) ops.push(op('Ts', [new PDFNumber(rise)]));
      ops.push(op('TJ', [new PDFArray(items)]));
      if (rise) ops.push(op('Ts', [new PDFNumber(0)]));
      pen = origin + g.dx + g.width;
    }
    if (span) ops.push(op('EMC'));
    origin += piece.advance;
  }
  return ops;
}
