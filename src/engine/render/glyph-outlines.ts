/**
 * Glyph-outline text drawing for embedded TrueType CID fonts in complex scripts.
 *
 * The default text path re-shapes each run's Unicode with a browser font
 * (`fillText`). That is fine for Latin, but Devanagari and other complex
 * scripts are printed as *shaped* glyph IDs — conjuncts, reph, pre-base ि —
 * whose Unicode is lossy or only available via /ActualText. Re-shaping that
 * text with a substitute font squeezes clusters into the PDF's glyph slots and
 * misplaces marks. Drawing the embedded glyph outlines by glyph ID at their
 * exact PDF positions is what Acrobat / pdf.js do, and is exact.
 */

import type { FontData } from '../fonts/font-parser';
import { getGlyphOutline, type TTFFont } from '../fonts/truetype-parser';

type TRm = { a: number; b: number; c: number; d: number; e: number; f: number };

/**
 * Scripts that need shaping (reordering, conjuncts, contextual forms):
 * Hebrew/Arabic/Syriac/Thaana/NKo, Indic, Thai/Lao/Tibetan, Myanmar, Khmer,
 * and the Hebrew/Arabic presentation forms.
 */
export function isComplexScriptCodePoint(cp: number): boolean {
  return (
    (cp >= 0x0590 && cp <= 0x08ff) ||
    (cp >= 0x0900 && cp <= 0x0fff) ||
    (cp >= 0x1000 && cp <= 0x109f) ||
    (cp >= 0x1780 && cp <= 0x17ff) ||
    (cp >= 0xa8e0 && cp <= 0xa8ff) || // Devanagari Extended
    (cp >= 0xfb1d && cp <= 0xfdff) ||
    (cp >= 0xfe70 && cp <= 0xfeff)
  );
}

function hasComplexScript(text: string): boolean {
  for (const ch of text) {
    if (isComplexScriptCodePoint(ch.codePointAt(0) ?? 0)) return true;
  }
  return false;
}

const outlineFontCache = new WeakMap<FontData, boolean>();

/**
 * True when this font's glyphs should be drawn from the embedded outlines:
 * a Type0 font with an Identity CMap over an embedded TrueType (glyf) program
 * whose text is in a complex script.
 */
export function usesGlyphOutlines(fontData: FontData | undefined): fontData is FontData & { ttfFont: TTFFont } {
  if (!fontData) return false;
  const cached = outlineFontCache.get(fontData);
  if (cached !== undefined) return cached;

  let result = false;
  const ttf = fontData.ttfFont;
  if (
    fontData.isComposite &&
    ttf &&
    ttf.tables.has('glyf') &&
    ttf.tables.has('loca') &&
    /^Identity-[HV]$/.test(fontData.encoding)
  ) {
    for (const text of fontData.toUnicode.values()) {
      if (hasComplexScript(text)) {
        result = true;
        break;
      }
    }
  }
  outlineFontCache.set(fontData, result);
  return result;
}

/** Glyph ID for a character code of an Identity-encoded CIDFontType2. */
export function outlineGlyphId(fontData: FontData, charCode: number): number {
  const map = fontData.cidToGid;
  if (map) return charCode < map.length ? map[charCode] : 0;
  return charCode;
}

/**
 * Fill one glyph outline. `tRm` maps text space (1 unit = 1 em) to the canvas'
 * current user space; `e`/`f` override its translation.
 * Returns false when the font has no outline for the glyph.
 */
export function drawOutlineGlyph(
  ctx: CanvasRenderingContext2D,
  ttf: TTFFont,
  glyphId: number,
  tRm: TRm,
  e: number,
  f: number,
): boolean {
  if (glyphId <= 0 || glyphId >= ttf.numGlyphs) return false;
  const outline = getGlyphOutline(ttf, glyphId);
  if (!outline) return false;
  if (outline.commands.length === 0) return true; // blank glyph (space)

  const k = 1 / (ttf.unitsPerEm || 1000);
  ctx.save();
  ctx.transform(tRm.a * k, tRm.b * k, tRm.c * k, tRm.d * k, e, f);
  ctx.beginPath();
  for (const cmd of outline.commands) {
    const a = cmd.args;
    switch (cmd.type) {
      case 'M': ctx.moveTo(a[0], a[1]); break;
      case 'L': ctx.lineTo(a[0], a[1]); break;
      case 'Q': ctx.quadraticCurveTo(a[0], a[1], a[2], a[3]); break;
      case 'C': ctx.bezierCurveTo(a[0], a[1], a[2], a[3], a[4], a[5]); break;
      case 'Z': ctx.closePath(); break;
    }
  }
  ctx.fill('nonzero');
  ctx.restore();
  return true;
}
