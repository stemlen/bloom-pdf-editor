/**
 * Text metrics — baselines, bounds, advances, and width estimation.
 *
 * Maths used:
 *   - Affine transforms: glyph position = T_rm = T_font × Tm × CTM
 *   - Baseline clustering: |y₁ − y₂| < ε where ε = max(2, 0.35 × fontSize)
 *   - Advance width: Σ (wᵢ/1000 × fontSize) + charSpacing + wordSpacing
 */

import type { TextRun } from '../content/interpreter';

export interface RunBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Visual font size in page units (what the canvas draws).
 * Prefers glyph text-rendering matrix over raw Tf — resumes often use
 * `1 Tf` + scaled Tm, so Tf alone under-reports size.
 */
export function visualFontSize(run: TextRun): number {
  if (run.glyphs.length > 0) {
    const tRm = run.glyphs[0].tRm;
    const fromTrm = Math.sqrt(tRm.c * tRm.c + tRm.d * tRm.d);
    if (fromTrm > 0.5) return fromTrm;
    if (run.glyphs[0].fontSize > 0.5) return run.glyphs[0].fontSize;
  }
  return run.fontSize > 0.5 ? run.fontSize : 12;
}

/** Infer bold/italic from a PDF font resource / BaseFont name. */
export function fontNameStyleFlags(fontName: string): { bold: boolean; italic: boolean } {
  const lower = fontName.replace(/^.*\+/, '').toLowerCase();
  return {
    bold: /bold|black|heavy|extrabold|demibold|semibold/.test(lower),
    italic: /italic|oblique|slanted/.test(lower),
  };
}

/** Resolve style flags using FontData when the resource key alone is opaque (F1, etc.). */
export function resolveRunStyleFlags(
  fontName: string,
  fontData?: { baseFont?: string; standardMetrics?: { isBold: boolean; isItalic: boolean } | null } | null,
): { bold: boolean; italic: boolean } {
  if (fontData?.standardMetrics) {
    return {
      bold: fontData.standardMetrics.isBold,
      italic: fontData.standardMetrics.isItalic,
    };
  }
  if (fontData?.baseFont) return fontNameStyleFlags(fontData.baseFont);
  return fontNameStyleFlags(fontName);
}

/** Median glyph baseline (PDF y coordinate). */
export function computeBaseline(run: TextRun): number {
  if (run.glyphs.length === 0) return run.y;
  const ys = run.glyphs.map(g => g.tRm.f);
  ys.sort((a, b) => a - b);
  return ys[Math.floor(ys.length / 2)];
}

export function getRunBounds(run: TextRun): RunBounds {
  if (run.glyphs.length === 0) {
    const h = run.height || run.fontSize || 12;
    return {
      x: run.x,
      y: run.y,
      width: run.width,
      height: h,
      left: run.x,
      right: run.x + run.width,
      top: run.y + h,
      bottom: run.y,
    };
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  // Use visual size for padding so selection/edit boxes match on-canvas text
  const fontSize = visualFontSize(run);

  for (let g = 0; g < run.glyphs.length; g++) {
    const glyph = run.glyphs[g];
    const gx = glyph.tRm.e;
    const gy = glyph.tRm.f;
    if (gx < minX) minX = gx;
    if (gx + glyph.width > maxX) maxX = gx + glyph.width;
    if (gy < minY) minY = gy;
    if (gy > maxY) maxY = gy;
  }

  return {
    x: minX,
    y: minY - fontSize * 0.2,
    width: maxX - minX,
    height: (maxY - minY) + fontSize * 1.1,
    left: minX,
    right: maxX,
    top: maxY + fontSize * 0.85,
    bottom: minY - fontSize * 0.25,
  };
}

/** Average character width for a run (page units). */
export function averageCharWidth(run: TextRun): number {
  if (run.text.length === 0) return (run.fontSize || 12) * 0.5;
  const bounds = getRunBounds(run);
  return bounds.width / run.text.length;
}

/**
 * Average advance of non-whitespace glyphs. Prose runs that happen to include
 * a trailing space still yield a letter-like average; pure space runs fall back
 * to averageCharWidth.
 */
/**
 * Width units a character takes in shaped (Indic) text: combining marks sit on
 * their base (0) and a consonant after a virama joins it as a conjunct (½).
 */
function shapedUnits(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch) || /\p{M}/u.test(ch) || ch === '\u200D' || ch === '\u200C') continue;
    n += text[i - 1] === '\u094D' ? 0.5 : 1;
  }
  return n;
}

const SHAPED_SCRIPT = /[\u0900-\u0DFF]/;

export function averageLetterWidth(run: TextRun): number {
  // Devanagari & co.: one glyph may carry a whole cluster (or nothing, after
  // /ActualText) — average over shaped letters, not glyphs or code units.
  if (SHAPED_SCRIPT.test(run.text)) {
    const units = shapedUnits(run.text);
    const inked = run.glyphs.filter(g => !/^\s$/.test(g.unicode));
    if (units > 0 && inked.length > 0) {
      return inked.reduce((w, g) => w + g.width, 0) / units;
    }
  }
  const glyphs = run.glyphs.filter(g => g.unicode && !/\s/.test(g.unicode));
  if (glyphs.length > 0) {
    let w = 0;
    for (let i = 0; i < glyphs.length; i++) w += glyphs[i].width;
    return w / glyphs.length;
  }
  const letters = run.text.replace(/\s/g, '');
  if (letters.length > 0 && letters.length < run.text.length) {
    // No glyph widths — approximate by removing spaces from the char average.
    const avg = averageCharWidth(run);
    const fs = visualFontSize(run);
    const spaceW = Math.min(avg * 0.4, fs * 0.33);
    const bounds = getRunBounds(run);
    const spaceCount = run.text.length - letters.length;
    const letterW = Math.max(0, bounds.width - spaceCount * spaceW);
    return letterW / letters.length;
  }
  return averageCharWidth(run);
}

/** Typical space advance for a run (page units). */
export function estimateSpaceWidth(run: TextRun): number {
  const fs = visualFontSize(run);
  const letterAvg = averageLetterWidth(run);
  // Match text-editor TJ space advances (0.28em) for subset/CID resume fonts.
  return Math.min(Math.max(fs * 0.28, letterAvg * 0.28), letterAvg * 0.5, fs * 0.45);
}

/** Gap between two horizontally adjacent runs on the same line. */
export function gapBetweenRuns(left: TextRun, right: TextRun): number {
  const l = getRunBounds(left);
  const r = getRunBounds(right);
  return r.left - l.right;
}

/** Estimate rendered width of a string using run metrics. */
export function estimateTextWidth(text: string, run: TextRun): number {
  if (text.length === 0) return 0;
  const letterAvg = averageLetterWidth(run);
  const spaceW = estimateSpaceWidth(run);
  if (SHAPED_SCRIPT.test(text)) {
    const spaces = (text.match(/\s/g) ?? []).length;
    return shapedUnits(text) * letterAvg + spaces * spaceW;
  }
  let w = 0;
  for (let i = 0; i < text.length; i++) {
    w += /\s/.test(text[i]) ? spaceW : letterAvg;
  }
  return w;
}

export interface FontSizeOverrideRange {
  start: number;
  end: number;
  fontSize: number;
}

/**
 * Estimate width when some characters will render at a different font size
 * (pending style overrides). Scales the run's average advance by fs ratio.
 */
export function estimateTextWidthWithOverrides(
  text: string,
  run: TextRun,
  lineStart: number,
  overrides?: FontSizeOverrideRange[],
): number {
  if (text.length === 0) return 0;
  if (!overrides?.length) return estimateTextWidth(text, run);

  const baseFs = Math.max(0.5, visualFontSize(run));
  const letterAvg = averageLetterWidth(run);
  const spaceW = estimateSpaceWidth(run);
  let w = 0;
  for (let i = 0; i < text.length; i++) {
    const abs = lineStart + i;
    let fs = baseFs;
    for (let o = 0; o < overrides.length; o++) {
      const ov = overrides[o];
      if (abs >= ov.start && abs < ov.end) {
        fs = ov.fontSize;
        break;
      }
    }
    const base = /\s/.test(text[i]) ? spaceW : letterAvg;
    w += base * (fs / baseFs);
  }
  return w;
}
