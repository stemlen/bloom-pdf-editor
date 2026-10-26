/**
 * Justification vs tab detection — distinguish body-text justification
 * from left/right column layouts (e.g. title + dates on same baseline).
 *
 * Core issue: PDF justification is often encoded as TJ displacements *inside*
 * a single text run. Detecting only inter-run gaps misses that, so flow-draw
 * never fires and rivers of whitespace remain on canvas.
 */

import type { TextRun } from '../content/interpreter';
import type { TextLine } from './types';
import { averageCharWidth, gapBetweenRuns, getRunBounds } from './metrics';

const BULLET_CHARS = /^[\u2022\u2023\u25E6\u2043\u2219\u00B7\u25CF\u25CB•∙]$/;

/**
 * Detect a tab-style gap splitting left content from right-aligned content.
 * Returns the index of the last run in the left column, or -1 if none.
 */
export function detectTabSplitIndex(runs: TextRun[], fontSize: number): number {
  const splits = detectColumnSplitIndices(runs, fontSize);
  // Legacy single-tab: prefer the largest asymmetric gap when only one stands out
  if (splits.length === 0) return -1;
  if (splits.length === 1) return splits[0];

  const gaps: Array<{ index: number; size: number }> = [];
  for (let i = 0; i < runs.length - 1; i++) {
    gaps.push({ index: i, size: gapBetweenRuns(runs[i], runs[i + 1]) });
  }
  gaps.sort((a, b) => b.size - a.size);
  const largest = gaps[0];
  const second = gaps.length > 1 ? gaps[1].size : 0;
  if (largest.size > second * 2.5) return largest.index;
  // Multi-column table: no single "tab" — callers should use detectColumnSplitIndices
  return -1;
}

/**
 * Detect ALL column-separator gaps on a baseline (PDF tables / multi-cell rows).
 * Returns sorted indices of the last run in each left-hand cell (split after these).
 *
 * Unlike detectTabSplitIndex (one asymmetric tab), this keeps equal-sized
 * inter-column gaps — e.g. Course | Year | Institution | Remarks.
 */
export function detectColumnSplitIndices(runs: TextRun[], fontSize: number): number[] {
  if (runs.length < 2) return [];

  const avgCharW = runs.reduce((s, r) => s + averageCharWidth(r), 0) / Math.max(1, runs.length);
  // Word spaces are typically < ~2.5× font size; column gutters are larger.
  // Table cells / multi-column rows have gutters >= max(fontSize * 1.2, avgCharW * 2.4, 9).
  const columnMin = Math.max(fontSize * 1.2, avgCharW * 2.4, 9);

  // Tight tables (narrow cells, numbers in their own text objects) can have
  // gutters under that limit. A gap of most of an em with no space glyph on
  // either side is still not a word space, so it splits too.
  const tightMin = Math.max(fontSize * 0.8, avgCharW * 1.6, 6);
  const isSpace = (ch: string | undefined) => ch === ' ' || ch === '\u00A0';

  const splits: number[] = [];
  for (let i = 0; i < runs.length - 1; i++) {
    const gap = gapBetweenRuns(runs[i], runs[i + 1]);
    if (gap >= columnMin) {
      splits.push(i);
      continue;
    }
    const leftEnd = runs[i].glyphs[runs[i].glyphs.length - 1]?.unicode;
    const rightStart = runs[i + 1].glyphs[0]?.unicode;
    if (gap >= tightMin && !isSpace(leftEnd) && !isSpace(rightStart)) splits.push(i);
  }
  return splits;
}

/**
 * Measure true inter-word gaps from glyph positions.
 * Uses space glyphs when present; otherwise gaps in the word-space band
 * between non-space glyphs. Skips tiny kerning and huge tab gaps.
 */
export function measureWordGaps(line: TextLine): number[] {
  type G = { x: number; width: number; unicode: string };
  const glyphs: G[] = [];
  for (let r = 0; r < line.runs.length; r++) {
    const run = line.runs[r];
    for (let g = 0; g < run.glyphs.length; g++) {
      const gl = run.glyphs[g];
      glyphs.push({ x: gl.tRm.e, width: gl.width, unicode: gl.unicode });
    }
  }
  if (glyphs.length < 2) return [];
  glyphs.sort((a, b) => a.x - b.x);

  const fs = line.fontSize || 12;
  const minWord = Math.max(fs * 0.12, 1.5);
  const maxWord = fs * 3.5; // above this is tab/column, not a word space
  const gaps: number[] = [];

  let i = 0;
  while (i < glyphs.length) {
    // skip leading spaces / bullets for gap measurement start
    if (glyphs[i].unicode === ' ' || glyphs[i].unicode === '\u00A0' || BULLET_CHARS.test(glyphs[i].unicode)) {
      i++;
      continue;
    }
    // end of current word
    let end = i;
    while (
      end + 1 < glyphs.length &&
      glyphs[end + 1].unicode !== ' ' &&
      glyphs[end + 1].unicode !== '\u00A0' &&
      !BULLET_CHARS.test(glyphs[end + 1].unicode)
    ) {
      const gap = glyphs[end + 1].x - (glyphs[end].x + glyphs[end].width);
      // Large gap without a space glyph still ends the word (TJ word spacing)
      if (gap > minWord) break;
      end++;
    }

    // find next word start
    let j = end + 1;
    while (
      j < glyphs.length &&
      (glyphs[j].unicode === ' ' || glyphs[j].unicode === '\u00A0' || BULLET_CHARS.test(glyphs[j].unicode))
    ) {
      j++;
    }
    if (j >= glyphs.length) break;

    const gap = glyphs[j].x - (glyphs[end].x + glyphs[end].width);
    if (gap >= minWord && gap <= maxWord) {
      gaps.push(gap);
    }
    i = j;
  }

  return gaps;
}

/**
 * True for dense body-text lines with multiple expanded inter-word gaps.
 * Uses glyph-level gaps so TJ-justified single runs are detected too.
 */
export function detectJustifiedBodyText(
  runs: TextRun[],
  fontSize: number,
  text: string,
  tabSplitIndex: number,
): boolean {
  if (tabSplitIndex >= 0) return false;

  const wordCount = text.trim().split(/\s+/).filter(w => w.length > 0).length;
  if (wordCount < 4) return false;

  // Prefer glyph-level measurement (catches TJ-inside-run justification)
  const probe: TextLine = {
    id: '',
    runs,
    text,
    segments: [],
    baseline: 0,
    x: 0, y: 0, width: 0, height: 0,
    leftMargin: 0, rightEdge: 0,
    fontSize,
    isJustified: false,
    tabSplitIndex: -1,
  };
  const glyphGaps = measureWordGaps(probe);
  if (glyphGaps.length >= 2) {
    const median = [...glyphGaps].sort((a, b) => a - b)[Math.floor(glyphGaps.length / 2)];
    const max = Math.max(...glyphGaps);
    // Uneven word spaces → treated as justified (needs evening).
    // Raised thresholds: only flag lines with genuinely extreme gap disparity.
    if (max > median * 2.2 && max > fontSize * 0.65) return true;
  }

  // Fallback: inter-run gaps (legacy)
  if (runs.length < 2) return false;
  const avgCharW = runs.reduce((s, r) => s + averageCharWidth(r), 0) / runs.length;
  const naturalThreshold = Math.max(fontSize * 0.5, avgCharW * 1.8);
  let largeGaps = 0;
  for (let i = 0; i < runs.length - 1; i++) {
    if (gapBetweenRuns(runs[i], runs[i + 1]) > naturalThreshold) largeGaps++;
  }
  return largeGaps >= 2;
}

/** Whether flow-based redraw should replace raw PDF positions for this line. */
export function shouldUseFlowDraw(line: TextLine): boolean {
  if (line.tabSplitIndex >= 0) return false;

  // Structured title lines (project headings, etc.) must keep native gaps —
  // evening them collapses spaces after ")" / around "|" / before icons.
  if (looksLikeStructuredTitleLine(line)) return false;

  // Contact / header chrome — icons, emails, phones, URLs
  if (looksLikeContactOrHeaderLine(line)) return false;

  const wordCount = line.text.trim().split(/\s+/).filter(w => w.length > 0).length;
  if (wordCount < 4) return false;

  const targetWidth = line.rightEdge - line.leftMargin;
  if (targetWidth <= 0) return false;

  let naturalWidth = 0;
  for (let r = 0; r < line.runs.length; r++) {
    naturalWidth += getRunBounds(line.runs[r]).width;
  }

  // Mostly empty → tab/header, not body prose
  if (naturalWidth / targetWidth < 0.55) return false;

  const gaps = measureWordGaps(line);
  if (gaps.length < 2) return false;

  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const max = sorted[sorted.length - 1];
  const min = sorted[0];
  if (median <= 0) return false;

  const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  const variance = gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length;
  const cv = Math.sqrt(variance) / mean;

  // If the max gap is small (under 0.4 × fontSize), the variation is just
  // normal kerning / font-metric noise — not a visible whitespace river.
  if (max < line.fontSize * 0.4) return false;

  // Prefer bullet body lines — that's where TJ rivers show up
  const startsWithBullet = /^[\u2022\u2023\u25E6\u2043\u2219\u00B7\u25CF\u25CB•∙]/.test(line.text.trim());

  // Activate when gaps are noticeably uneven — raised thresholds to avoid
  // re-spacing lines that already look correct at native positions.
  const uneven = cv >= 0.50 || max > median * 2.0 || (min > 0 && max / min >= 2.8);
  if (!uneven && !(line.isJustified && cv >= 0.35)) return false;

  // Non-bullet lines need stronger evidence (avoid project/skills headings)
  if (!startsWithBullet && !line.isJustified && cv < 0.6) return false;
  // Even bullet lines need real unevenness, not just slight variance
  if (startsWithBullet && cv < 0.40) return false;

  return true;
}

/** Project titles, link rows, pipe-separated meta — not prose to reflow. */
function looksLikeStructuredTitleLine(line: TextLine): boolean {
  const text = line.text;
  if (text.includes('|')) return true;
  for (let i = 0; i < line.runs.length; i++) {
    if (line.runs[i].isUnderline) return true;
  }
  // Certificate / form rows: "NAME : VALUE", "INSTITUTE NAME: …"
  if (/^[A-Z][A-Z0-9\s.'’]{1,28}\s*:/.test(text.trim())) return true;
  // "Open Source)" followed by tech stack without being a bullet
  if (/\(Open Source\)/i.test(text) && !/^[\u2022\u2023\u25E6\u2043\u2219\u00B7\u25CF\u25CB•∙]/.test(text.trim())) {
    return true;
  }
  return false;
}

/** Resume contact rows and short large headers must keep native glyph positions. */
function looksLikeContactOrHeaderLine(line: TextLine): boolean {
  const text = line.text;
  if (/https?:\/\/|www\.|linkedin\.com|github\.com|mailto:/i.test(text)) return true;
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)) return true;
  if (/\+?\d[\d\s().-]{8,}\d/.test(text)) return true;
  if (/\b(portfolio|linkedin|github|phone|email|mobile)\b/i.test(text)) return true;

  // Short large display lines (names) — never evening
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 4 && line.fontSize >= 16) return true;

  // Many tiny runs (icon font glyphs + labels) → contact chrome
  if (line.runs.length >= 5 && words.length <= 12) {
    const tinyRuns = line.runs.filter(r => r.text.trim().length <= 2).length;
    if (tinyRuns >= 3) return true;
  }

  return false;
}
