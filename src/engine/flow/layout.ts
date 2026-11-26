/**
 * Paragraph layout — wrap overflow carefully so edits don't destroy neighboring lines.
 *
 * Critical rules (Acrobat-safe):
 * 1. Prefer editing only the current line.
 * 2. Never merge overflow text into the next line's existing content.
 * 3. Only push subsequent lines down when wrap creates NEW lines that fit
 *    in empty paragraph slots — never overwrite headings below.
 * 4. Use greedy wrap (predictable); Knuth-Plass is for preview only.
 */

import type { TextRun } from '../content/interpreter';
import type { DocumentFlow, Paragraph, TextLine } from './types';
import { greedyWrap } from './line-break';
import {
  estimateTextWidth,
  estimateTextWidthWithOverrides,
  getRunBounds,
  visualFontSize,
  type FontSizeOverrideRange,
} from './metrics';
import { distributeTextToSegments } from './reflow';

export interface LineTextEdit {
  line: TextLine;
  newText: string;
}

export interface RunShift {
  run: TextRun;
  dx: number;
  dy: number;
}

export interface LayoutPlan {
  lineEdits: LineTextEdit[];
  shifts: RunShift[];
  /** Wrapped lines for live preview (may be a single line). */
  previewLines: string[];
}

export function findParagraphForLine(flow: DocumentFlow, line: TextLine): Paragraph | null {
  for (let i = 0; i < flow.paragraphs.length; i++) {
    const para = flow.paragraphs[i];
    for (let j = 0; j < para.lines.length; j++) {
      if (para.lines[j].id === line.id) return para;
    }
  }
  return null;
}

export function computeLineHeight(line: TextLine): number {
  return Math.max(line.height, line.fontSize * 1.2, 12);
}

function lineMeasureWidth(line: TextLine): (segment: string) => number {
  const run = line.runs[0];
  if (!run) return (s: string) => s.length * line.fontSize * 0.5;
  return (s: string) => estimateTextWidth(s, run);
}

function mergeShifts(shifts: RunShift[]): RunShift[] {
  const map = new Map<TextRun, { dx: number; dy: number }>();
  for (let i = 0; i < shifts.length; i++) {
    const s = shifts[i];
    const prev = map.get(s.run) ?? { dx: 0, dy: 0 };
    prev.dx += s.dx;
    prev.dy += s.dy;
    map.set(s.run, prev);
  }

  const merged: RunShift[] = [];
  map.forEach((delta, run) => {
    if (Math.abs(delta.dx) > 0.01 || Math.abs(delta.dy) > 0.01) {
      merged.push({ run, dx: delta.dx, dy: delta.dy });
    }
  });
  return merged;
}

/** Shift trailing runs when an earlier segment grows or shrinks. */
export function computeHorizontalShifts(line: TextLine, newText: string): RunShift[] {
  if (line.segments.length <= 1) return [];
  return computeHorizontalShiftsFromEdits(line, distributeTextToSegments(line, newText));
}

/**
 * Recompute each segment's dx from a left-to-right chain:
 *   nextX = prevX + newWidth(prev) + originalGap
 * Cumulative delta shifts (old approach) under-estimate growth on condensed
 * resume fonts / Helvetica fallback, so trailing styled runs pile onto the
 * edited mid-line text.
 */
export function computeHorizontalShiftsFromEdits(
  line: TextLine,
  segmentEdits: { run: TextRun; newText: string }[],
  /**
   * Pending fontSize ranges in NEW line-text coordinates. Inserts typed at a
   * larger size must reserve that width now — estimating at the old run size
   * leaves trailers short and the enlarged glyphs pile onto neighbors.
   */
  fontSizeOverrides?: FontSizeOverrideRange[],
  /**
   * Exact width (page units) of a segment's new text when it is known —
   * shaped text re-drawn from page glyph clusters. Null → estimate.
   */
  measure?: (text: string, run: TextRun) => number | null,
): RunShift[] {
  if (line.segments.length <= 1) return [];

  const shifts: RunShift[] = [];
  let cursor = getRunBounds(line.segments[0].run).left;
  // Match text-editor SPACE_TJ_EM — subset fonts need ~0.28em per Space.
  const spaceEm = 0.28;
  let spaceGrowthSeen = false;
  let newLinePos = 0;
  const hasFsOverrides = !!(fontSizeOverrides && fontSizeOverrides.length > 0);

  for (let i = 0; i < line.segments.length; i++) {
    const seg = line.segments[i];
    const run = seg.run;
    const edit = segmentEdits.find(e => e.run === run) ?? segmentEdits[i];
    const newText = edit?.newText ?? seg.text;
    const bounds = getRunBounds(run);
    const oldW = Math.max(bounds.width, estimateTextWidth(seg.text, run), 0.01);
    const estimated = hasFsOverrides
      ? estimateTextWidthWithOverrides(newText, run, newLinePos, fontSizeOverrides)
      : estimateTextWidth(newText, run);
    const fs = visualFontSize(run);
    const growing = newText.length > seg.text.length;
    const deltaChars = newText.length - seg.text.length;
    const oldSpaces = (seg.text.match(/\s/g) || []).length;
    const newSpaces = (newText.match(/\s/g) || []).length;
    const deltaSpaces = newSpaces - oldSpaces;
    const deltaLetters = deltaChars - deltaSpaces;
    const hasNewSpaces = growing && deltaSpaces > 0;
    if (hasNewSpaces) spaceGrowthSeen = true;
    const unchanged = newText === seg.text;

    let gap = 0;
    let nextLeft: number | null = null;
    if (i < line.segments.length - 1) {
      nextLeft = getRunBounds(line.segments[i + 1].run).left;
      gap = nextLeft - bounds.right;
      // Adjacent/overlapping PDF runs are common (kerning). Inventing a positive
      // gutter here cascades dx across unchanged prefix segments and spreads the
      // whole line when a later segment grows (e.g. mid-word spaces).
      if (gap < 0) gap = 0;
    }

    // Unchanged runs keep measured width (re-estimating invented gutters), but
    // must still chain-shift when a prior segment grew — otherwise trailers
    // stay at the old X and overlap the expanded text (spaces / inserts).
    if (unchanged) {
      let dx = cursor - bounds.left;
      if (spaceGrowthSeen && dx < 0) dx = 0;
      if (Math.abs(dx) > 0.01) {
        shifts.push({ run, dx, dy: 0 });
      }
      // Preserve native run-to-run spacing instead of bounds.width + gap, which
      // drifts when glyph bounds don't abut cleanly.
      cursor = nextLeft != null ? nextLeft + dx : bounds.left + dx + bounds.width;
      newLinePos += newText.length;
      continue;
    }

    // Length-ratio scaling treats spaces like letters and invents rivers.
    // Whenever spaces were inserted, trust the space-aware estimate only.
    // Pending larger fontSize: trust the override estimate (includes size ratio).
    const scaled = oldW * (newText.length / Math.max(1, seg.text.length));
    const exact = !hasFsOverrides && measure ? measure(newText, run) : null;
    let newW: number;
    if (exact != null) {
      newW = exact;
    } else if (hasFsOverrides && growing) {
      newW = Math.max(estimated, oldW);
    } else if (hasNewSpaces) {
      const spaceFloor =
        oldW
        + Math.max(0, deltaLetters) * fs * 0.35
        + Math.max(0, deltaSpaces) * fs * spaceEm;
      newW = Math.max(estimated, spaceFloor);
    } else if (growing) {
      const deltaFloor = oldW + Math.max(0, deltaLetters) * fs * 0.4;
      const emCap = newText.length * fs * 0.52;
      const proportional = Math.max(estimated, scaled);
      newW = Math.max(deltaFloor, Math.min(proportional, emCap));
    } else {
      newW = Math.max(estimated, 0);
    }

    let dx = cursor - bounds.left;
    // After space inserts, never pull trailing runs left — measured old bounds
    // often ignore TJ space advances, so dx goes negative and gaps vanish.
    if (spaceGrowthSeen && dx < 0) dx = 0;
    if (Math.abs(dx) > 0.01) {
      shifts.push({ run, dx, dy: 0 });
    }

    cursor += newW + gap;
    newLinePos += newText.length;
  }

  return mergeShifts(shifts);
}

/**
 * Safe line measure width: prefer the visual line width, fall back to
 * rightEdge − leftMargin, never use a tiny paragraph.width*0.5 that
 * falsely wraps headings.
 */
function resolveMaxWidth(editedLine: TextLine, paragraph: Paragraph | null): number {
  const fromLine = editedLine.rightEdge - editedLine.leftMargin;
  const fromWidth = editedLine.width;
  const fromPara = paragraph ? paragraph.width : 0;
  // Use the largest plausible measure so we don't wrap prematurely
  const w = Math.max(fromLine, fromWidth, fromPara * 0.85, editedLine.fontSize * 8);
  // Guard against absurdly small widths
  return Math.max(w, editedLine.fontSize * 4);
}

/**
 * Build a layout plan for editing one line.
 *
 * Position-preserving v1: ALWAYS commit only the edited line.
 * Never cascade into neighbors (that destroyed resume headings).
 * Preview may still show wrap for the overlay.
 */
export function computeLayoutPlan(
  paragraph: Paragraph,
  editedLine: TextLine,
  newText: string,
): LayoutPlan {
  const maxWidth = resolveMaxWidth(editedLine, paragraph);
  const measure = lineMeasureWidth(editedLine);
  const natural = measure(newText);
  const previewLines =
    natural <= maxWidth * 1.05 ? [newText] : greedyWrap(newText, maxWidth, measure);

  return {
    lineEdits: [{ line: editedLine, newText }],
    shifts: computeHorizontalShifts(editedLine, newText),
    previewLines,
  };
}

/** Preview layout for the edit overlay without touching the PDF. */
export function computeEditPreview(
  flow: DocumentFlow | undefined,
  line: TextLine,
  newText: string,
): string[] {
  const maxWidth = resolveMaxWidth(line, flow ? findParagraphForLine(flow, line) : null);
  const measure = lineMeasureWidth(line);
  if (measure(newText) <= maxWidth * 1.05) return [newText];
  return greedyWrap(newText, maxWidth, measure);
}
