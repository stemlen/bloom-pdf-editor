/**
 * Flow-aware text editing — commit full-line edits across styled runs.
 */

import { interpretPage } from '../content/interpreter';
import type { TextRun } from '../content/interpreter';
import type { PDFObject, PDFPageInfo } from '../types';
import {
  applyTextEdits,
  applyRunPositionShifts,
  type EditResult,
  type TextEdit,
  type RunPositionShift,
} from '../editor/text-editor';
import { distributeTextChangeToSegments, distributeTextToSegments } from './reflow';
import {
  computeLayoutPlan,
  computeHorizontalShifts,
  computeHorizontalShiftsFromEdits,
  findParagraphForLine,
  type LayoutPlan,
} from './layout';
import {
  estimateTextWidth,
  estimateTextWidthWithOverrides,
  getRunBounds,
  visualFontSize,
} from './metrics';
import { detectTablesOnPage, findCellForLine } from './table-detect';
import { buildClusterInventory, hasComplexScriptText, measureTextFromClusters } from '../editor/indic-cluster-encoder';
import type { DocumentFlow, TextLine } from './types';

/** Normalize bullets/dashes so "• " still matches rewritten "- ". */
function normalizeEditText(text: string): string {
  return text
    .replace(/^[\u2022\u2023\u25E6\u2043\u2219\u00B7\u25CF\u25CB•∙]\s*/, '- ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolve post-edit runs for each segment. Prefer left-to-right same-baseline
 * peers when counts match — text match alone fails when "•" becomes "-".
 */
function resolveFreshSegmentRuns(
  runs: TextRun[],
  segmentEdits: { run: TextRun; newText: string }[],
  baseline: number,
  fontSize: number,
): TextRun[] | null {
  const tol = Math.max(2, fontSize * 0.35);
  const peers = runs
    .filter(r => {
      if ((r.sourceInstructionIndices ?? []).length === 0) return false;
      const bl = r.glyphs.length > 0 ? r.glyphs[0].tRm.f : r.y;
      return Math.abs(bl - baseline) <= tol;
    })
    .sort((a, b) => a.x - b.x || a.y - b.y);

  if (peers.length === segmentEdits.length) {
    return peers;
  }

  // Fallback: greedy text match with bullet normalization
  const used = new Set<TextRun>();
  const fresh: TextRun[] = [];
  for (let i = 0; i < segmentEdits.length; i++) {
    const want = normalizeEditText(segmentEdits[i].newText);
    let best: TextRun | null = null;
    let bestScore = -1;
    for (let p = 0; p < peers.length; p++) {
      const run = peers[p];
      if (used.has(run)) continue;
      const got = normalizeEditText(run.text);
      let score = 0;
      if (got === want) score = 100;
      else if (want.length > 0 && got.includes(want.slice(0, Math.min(10, want.length)))) score = 50;
      else if (want.length > 2 && got.slice(0, 6) === want.slice(0, 6)) score = 25;
      if (score > bestScore) {
        bestScore = score;
        best = run;
      }
    }
    if (!best || bestScore < 25) return null;
    used.add(best);
    fresh.push(best);
  }
  return fresh;
}

/**
 * After estimate-based shifts + text rewrite, re-measure real glyph widths and
 * nudge trailing runs so rivers/overlaps from width-estimate error disappear.
 */
function isKernedPerGlyphLine(line: TextLine): boolean {
  if (line.segments.length < 4) return false;
  let negGaps = 0;
  for (let i = 0; i < line.segments.length - 1; i++) {
    const a = getRunBounds(line.segments[i].run);
    const b = getRunBounds(line.segments[i + 1].run);
    if (b.left < a.right - 0.5) negGaps++;
  }
  return negGaps >= Math.ceil((line.segments.length - 1) * 0.5);
}

function correctResidualRunGaps(
  contentBytes: Uint8Array,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  line: TextLine,
  segmentEdits: { run: TextRun; newText: string }[],
  /**
   * Pre-edit line whose inter-run gaps define PDF spacing. Using the post-edit
   * line here reuses estimate-inflated rivers and then stacks font-growth push
   * on top.
   */
  gapSourceLine?: TextLine,
): { bytes: Uint8Array; corrections: RunPositionShift[] } {
  if (segmentEdits.length < 2) {
    return { bytes: contentBytes, corrections: [] };
  }

  // Type3 score-card lines: one glyph per run with heavy negative kerning.
  // After a Helvetica mid-line fallback, fresh-run matching + residual packing
  // yanks trailers to the wrong X. Skip for both in-engine and page.tsx callers.
  const gapProbe = gapSourceLine ?? line;
  if (isKernedPerGlyphLine(gapProbe) || isKernedPerGlyphLine(line)) {
    return { bytes: contentBytes, corrections: [] };
  }

  const interpreted = interpretPage(contentBytes, page, objects);
  const fresh = resolveFreshSegmentRuns(
    interpreted.textRuns,
    segmentEdits,
    line.baseline,
    line.fontSize,
  );
  if (!fresh) {
    return { bytes: contentBytes, corrections: [] };
  }

  const gapLine = gapSourceLine ?? line;
  const corrections: RunPositionShift[] = [];
  let cursor = getRunBounds(fresh[0]).left;
  const fs = Math.max(line.fontSize, 8);

  for (let i = 0; i < fresh.length; i++) {
    const bounds = getRunBounds(fresh[i]);
    const dx = cursor - bounds.left;
    if (Math.abs(dx) > 0.5) {
      corrections.push({ run: fresh[i], dx, dy: 0 });
    }

    let gap = fs * 0.12;
    if (i < gapLine.segments.length - 1) {
      const ob = getRunBounds(gapLine.segments[i].run);
      const nb = getRunBounds(gapLine.segments[i + 1].run);
      // Preserve negative gaps (kerning / overlapping Type3 per-glyph runs).
      gap = nb.left - ob.right;
    }
    const estW = estimateTextWidth(segmentEdits[i]?.newText ?? fresh[i].text, fresh[i]);
    const w = Math.max(bounds.width, estW);
    cursor += w + gap;
  }


  if (corrections.length === 0) {
    return { bytes: contentBytes, corrections };
  }
  return {
    bytes: applyRunPositionShifts(contentBytes, corrections),
    corrections,
  };
}

/**
 * Width growth of the edited line itself. Needed when title|tags have already
 * been split into separate flow cells — segment shifts are empty (segCount=1)
 * but peers on the same baseline still need to move.
 */
function estimateLineGrowthDx(
  line: TextLine,
  oldText: string,
  newText: string,
  fontSizeOverrides?: Array<{ start: number; end: number; fontSize: number }>,
): number {
  if (newText.length <= oldText.length) return 0;
  const run = line.segments[0]?.run ?? line.runs[0];
  if (!run) return 0;

  const oldW = Math.max(line.width, estimateTextWidth(oldText, run), 0.01);
  const estimated = fontSizeOverrides?.length
    ? estimateTextWidthWithOverrides(newText, run, 0, fontSizeOverrides)
    : estimateTextWidth(newText, run);
  const fs = visualFontSize(run);
  const deltaChars = newText.length - oldText.length;
  const deltaSpaces =
    (newText.match(/\s/g) || []).length - (oldText.match(/\s/g) || []).length;
  const deltaLetters = deltaChars - deltaSpaces;
  if (fontSizeOverrides?.length) {
    return Math.max(0, estimated - oldW);
  }
  if (deltaSpaces > 0) {
    const spaceFloor =
      oldW
      + Math.max(0, deltaLetters) * fs * 0.35
      + Math.max(0, deltaSpaces) * fs * 0.28;
    return Math.max(0, Math.max(estimated, spaceFloor) - oldW);
  }
  const scaled = oldW * (newText.length / Math.max(1, oldText.length));
  const deltaFloor = oldW + Math.max(0, deltaLetters) * fs * 0.55;
  const emCap = newText.length * fs * 0.72;
  const proportional = Math.max(estimated, scaled);
  const newW = Math.max(deltaFloor, Math.min(proportional, emCap), estimated);
  return Math.max(0, newW - oldW);
}

function buildLayoutPlan(
  flow: DocumentFlow | undefined,
  line: TextLine,
  newText: string,
): LayoutPlan {
  if (flow) {
    const paragraph = findParagraphForLine(flow, line);
    if (paragraph) {
      return computeLayoutPlan(paragraph, line, newText);
    }
  }

  return {
    lineEdits: [{ line, newText }],
    shifts: computeHorizontalShifts(line, newText),
    previewLines: [newText],
  };
}

/**
 * Nudge same-baseline peer runs when a line grows.
 * - Table cells are independent columns and NEVER shift peer cells.
 * - Independent columns/boxes with large gutters (> 3.5× font size or 45px)
 *   only shift if the grown text physically collides / overlaps with them.
 * - Subtitle / inline fragments on the same line shift to preserve relative spacing.
 */
function collectPeerShiftsAfter(
  line: TextLine,
  flow: DocumentFlow | undefined,
  peerAfterX: number,
  peerDx: number,
  newRightEdge: number,
): RunPositionShift[] {
  if (!flow?.rawRuns?.length || peerDx < 0.5) return [];

  // Table cells are independent columns with fixed column alignments — never shift peer cells in a table
  if (flow.lines?.length) {
    const tables = detectTablesOnPage(flow.lines);
    if (findCellForLine(tables, line.id)) {
      return [];
    }
  }

  const owned = new Set<TextRun>(line.runs);
  const fs = Math.max(line.fontSize, 8);
  const minGutter = Math.max(fs * 0.3, 4);
  const shifts: RunPositionShift[] = [];

  const peers = flow.rawRuns
    .filter(r => {
      if (owned.has(r)) return false;
      if ((r.sourceInstructionIndices ?? []).length === 0) return false;
      const baseline = r.glyphs.length > 0 ? r.glyphs[0].tRm.f : r.y;
      if (Math.abs(baseline - line.baseline) > Math.max(2, fs * 0.35)) return false;
      return r.x >= peerAfterX - 0.5;
    })
    .sort((a, b) => a.x - b.x);

  let currentRight = newRightEdge;
  let cumDx = 0;

  for (let i = 0; i < peers.length; i++) {
    const run = peers[i];
    const isPunctuationContinuation = /^[\s|•·\-,–—]/.test(run.text);
    const initialGap = run.x - line.rightEdge;
    const isIndependentColumn = !isPunctuationContinuation && initialGap > Math.max(fs * 3.0, 35);

    if (isIndependentColumn) {
      const neededX = currentRight + minGutter;
      if (neededX > run.x + cumDx) {
        cumDx = neededX - run.x;
        shifts.push({ run, dx: cumDx, dy: 0 });
        currentRight = (run.x + cumDx) + run.width;
      } else if (cumDx > 0) {
        shifts.push({ run, dx: cumDx, dy: 0 });
        currentRight = (run.x + cumDx) + run.width;
      } else {
        currentRight = Math.max(currentRight, run.x + run.width);
      }
    } else {
      // Subtitle / inline continuation on the same line
      cumDx = peerDx;
      shifts.push({ run, dx: cumDx, dy: 0 });
      currentRight = (run.x + cumDx) + run.width;
    }
  }

  return shifts;
}

export interface LineTextEditOptions {
  /** Original line text at edit-session start (for caret-aware redistribute). */
  oldText?: string;
  /** Caret index after the edit (matches overlay preview). */
  caretAfter?: number;
  /**
   * Skip measured residual gap correction. Needed when a larger fontSize will
   * be applied next — residual packs to the old-size widths and pulls peers
   * back into the space the size bump still needs.
   */
  skipResidualCorrection?: boolean;
  /**
   * Pending fontSize patches in new-text coordinates so insert width estimates
   * match the size that will be applied on the same commit.
   */
  fontSizeOverrides?: Array<{ start: number; end: number; fontSize: number }>;
}

/**
 * Apply a Word-style line edit with paragraph layout:
 * distributes text across styled runs, wraps overflow, and shifts positions.
 */
/**
 * Close rivers / overlaps using measured glyph bounds after text+style edits.
 * Safe to run once fonts/sizes are final (not before a pending fontSize bump).
 */
export function correctLineResidualGaps(
  contentBytes: Uint8Array,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  line: TextLine,
  options?: { gapSourceLine?: TextLine },
): { bytes: Uint8Array; corrections: RunPositionShift[] } {
  const targetLine = options?.gapSourceLine ?? line;
  if (targetLine.segments.length < 2) {
    return { bytes: contentBytes, corrections: [] };
  }

  // Re-read page to get fresh glyph positions after text replacement
  const fresh = interpretPage(contentBytes, page, objects);
  const baseline = targetLine.baseline;
  const fs = targetLine.fontSize;

  const runs = resolveFreshSegmentRuns(
    fresh.textRuns,
    targetLine.segments.map(s => ({ run: s.run, newText: s.text })),
    baseline,
    fs,
  );
  if (!runs || runs.length < 2) {
    return { bytes: contentBytes, corrections: [] };
  }

  const corrections: RunPositionShift[] = [];
  const spaceEm = 0.28;

  for (let i = 0; i < runs.length - 1; i++) {
    const cur = runs[i];
    const next = runs[i + 1];
    const prevSeg = targetLine.segments[i];
    const nextSeg = targetLine.segments[i + 1];

    if (!prevSeg || !nextSeg) continue;

    const hadSpace = prevSeg.text.endsWith(' ') || nextSeg.text.startsWith(' ');
    const desiredGap = hadSpace ? visualFontSize(cur) * spaceEm : 0;
    const actualGap = next.x - (cur.x + cur.width);
    const residual = desiredGap - actualGap;

    if (Math.abs(residual) > 0.5 && Math.abs(residual) < fs * 2.5) {
      for (let j = i + 1; j < runs.length; j++) {
        corrections.push({ run: runs[j], dx: residual, dy: 0 });
      }
    }
  }

  if (corrections.length === 0) {
    return { bytes: contentBytes, corrections: [] };
  }

  const shiftedBytes = applyRunPositionShifts(contentBytes, corrections);
  return { bytes: shiftedBytes, corrections };
}

export function applyLineTextEdit(
  contentBytes: Uint8Array,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  line: TextLine,
  newText: string,
  flow?: DocumentFlow,
  options?: LineTextEditOptions,
): EditResult {
  const plan = buildLayoutPlan(flow, line, newText);
  const edits: TextEdit[] = [];
  const oldText = options?.oldText ?? line.text;
  const caretAfter = options?.caretAfter ?? newText.length;

  let primarySegmentEdits: ReturnType<typeof distributeTextChangeToSegments> | null = null;
  let primaryLine = line;

  for (let i = 0; i < plan.lineEdits.length; i++) {
    const { line: targetLine, newText: lineText } = plan.lineEdits[i];
    // Prefer caret-aware split (same as the live overlay) so commit matches preview.
    const segmentEdits = i === 0 && (options?.oldText != null || options?.caretAfter != null)
      ? distributeTextChangeToSegments(targetLine, oldText, lineText, caretAfter)
      : distributeTextToSegments(targetLine, lineText);
    if (i === 0) {
      primarySegmentEdits = segmentEdits;
      primaryLine = targetLine;
    }
    for (let j = 0; j < segmentEdits.length; j++) {
      edits.push({
        targetRun: segmentEdits[j].run,
        newText: segmentEdits[j].newText,
      });
    }
  }

  // Shaped (Indic) text is re-drawn from page glyph clusters with a known
  // advance — use it instead of per-character estimates for the trailers.
  let clusterInventory: ReturnType<typeof buildClusterInventory> | null = null;
  const measureShaped = (text: string, run: TextRun): number | null => {
    if (!hasComplexScriptText(text)) return null;
    clusterInventory ??= buildClusterInventory(interpretPage(contentBytes, page, objects).textRuns);
    const size = Math.abs(run.fontSize * (run.textMatrix?.d ?? 1)) || run.fontSize;
    return measureTextFromClusters(text, clusterInventory, size);
  };

  // Shifts must use the same caret-aware split as the text rewrite.
  const editShifts = primarySegmentEdits
    ? computeHorizontalShiftsFromEdits(
      primaryLine,
      primarySegmentEdits,
      options?.fontSizeOverrides,
      measureShaped,
    )
    : plan.shifts;

  let horizShifts = editShifts.filter(s => Math.abs(s.dy) < 0.01 && Math.abs(s.dx) > 0.01);
  const segmentGrowthDx = horizShifts.reduce((m, s) => Math.max(m, s.dx), 0);
  const lineGrowthDx = primaryLine.segments.length <= 1
    ? estimateLineGrowthDx(primaryLine, oldText, newText, options?.fontSizeOverrides)
    : 0;
  const growthDx = Math.max(segmentGrowthDx, lineGrowthDx);
  const dSpaces = (newText.match(/\s/g) || []).length - (oldText.match(/\s/g) || []).length;

  // Calculate new right edge of the edited line
  let newRightEdge = primaryLine.rightEdge + growthDx;
  if (primarySegmentEdits && primaryLine.segments.length > 0) {
    for (let i = 0; i < primaryLine.segments.length; i++) {
      const seg = primaryLine.segments[i];
      const edit = primarySegmentEdits.find(e => e.run === seg.run) ?? primarySegmentEdits[i];
      const text = edit?.newText ?? seg.text;
      const shift = horizShifts.find(s => s.run === seg.run);
      const segX = seg.run.x + (shift?.dx ?? 0);
      const segW = Math.max(estimateTextWidth(text, seg.run), text.length * visualFontSize(seg.run) * 0.55);
      newRightEdge = Math.max(newRightEdge, segX + segW);
    }
  }

  const fsPeer = Math.max(primaryLine.fontSize, 8);
  let peerAfterX = primaryLine.rightEdge - fsPeer * 0.25;
  let peerDx = growthDx;
  if (primarySegmentEdits) {
    for (let i = 0; i < primaryLine.segments.length; i++) {
      const seg = primaryLine.segments[i];
      const edit = primarySegmentEdits.find(e => e.run === seg.run) ?? primarySegmentEdits[i];
      if (edit && edit.newText !== seg.text) {
        peerAfterX = getRunBounds(seg.run).right;
      }
    }
    const trailer = horizShifts
      .filter(s => s.run.x >= peerAfterX - 1)
      .sort((a, b) => a.run.x - b.run.x)[0];
    if (trailer) peerDx = trailer.dx;
  }

  // Skip peers that share content-stream ops with segment trailers already shifted.
  const shiftedOps = new Set<number>();
  for (const s of horizShifts) {
    for (const idx of s.run.sourceInstructionIndices ?? []) shiftedOps.add(idx);
  }
  const peerShifts = collectPeerShiftsAfter(primaryLine, flow, peerAfterX, peerDx, newRightEdge)
    .filter(s => !(s.run.sourceInstructionIndices ?? []).some(idx => shiftedOps.has(idx)));
  if (peerShifts.length > 0) {
    horizShifts = [...horizShifts, ...peerShifts];
  }

  // Second pass: close rivers / overlaps left by width-estimate error (or a
  // first-pass shift that failed to land). Uses measured glyph bounds.
  // Skip when a pending fontSize enlarge will need that slack next.
  // Also skip when spaces were inserted: subset fonts often measure space
  // width ≈ 0, so residual packing pulls trailers back and live gaps vanish
  // on commit (spaces in Tj, but next run still at old X).
  const skipResidualForSpaces = dSpaces > 0;

  // Apply position shifts FIRST while sourceInstructionIndices still match the
  // stream. applyTextEdits inserts erase ops that invalidate those indices, so
  // shifting afterward silently no-ops and trailing runs overlap grown text.
  let bytes = contentBytes;
  if (horizShifts.length > 0) {
    bytes = applyRunPositionShifts(
      bytes,
      horizShifts,
      edits.map(e => e.targetRun),
    );
  }

  const editResult = applyTextEdits(bytes, page, objects, edits);
  bytes = editResult.newContentBytes;

  if (
    !options?.skipResidualCorrection
    && !skipResidualForSpaces
    && primarySegmentEdits
    && primarySegmentEdits.length > 1
  ) {
    const corrected = correctResidualRunGaps(
      bytes,
      page,
      objects,
      primaryLine,
      primarySegmentEdits,
    );
    bytes = corrected.bytes;
  }

  return { ...editResult, newContentBytes: bytes };
}

export { buildLayoutPlan };
