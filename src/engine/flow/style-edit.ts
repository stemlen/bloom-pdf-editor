/**
 * Style mutation API — safely patch color / size / underline on existing runs.
 *
 * Rules to avoid corrupting PDFs:
 * - Only modify operators already inside the run's BT…ET block
 * - Never invent font resource names that aren't on the page
 * - Never inject synthetic Tm shear (breaks baselines)
 * - Bold/italic only when a sibling Standard14 / resource font exists
 */

import {
  PDFName,
  PDFNumber,
  PDFDict,
  PDFRef,
  PDFString,
  PDFHexString,
  PDFArray,
  type PDFDocumentData,
  type PDFObject,
  type PDFPageInfo,
} from '../types';
import type { TextRun } from '../content/interpreter';
import { getPageContentBytes, resolveRef } from '../parser/parser';
import {
  applyRunPositionShifts,
  buildTJWithSpaceAdvances,
  SPACE_TJ_MAX_CHARS,
  spaceSupplementalTJ,
  compileInstructions,
  encodeTextForFont,
  encodeTextWinAnsi,
  loadFontForName,
  type EditResult,
  type EncodedText,
  type RunPositionShift,
} from '../editor/text-editor';
import { ensureFallbackFont } from '../fonts/font-augmentation';
import { updatePageContent } from '../editor/stream-compiler';
import { parseContentStream, type CSInstruction } from '../content/operator-lexer';
import { interpretPage } from '../content/interpreter';
import { reconstructLines } from './line-reconstruction';
import type { TextLine, StyledSegment } from './types';
import {
  estimateTextWidth,
  getRunBounds,
  fontNameStyleFlags,
  resolveRunStyleFlags,
  visualFontSize,
} from './metrics';
import type { FontData } from '../fonts/font-parser';

export interface TextStylePatch {
  fontSize?: number;
  /** UI / CSS family name (Helvetica, Arial, Times New Roman, …) mapped to Standard 14. */
  fontFamily?: string;
  /** RGB in 0–1 */
  color?: [number, number, number];
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: 'left' | 'center' | 'right';
}

/** Map a UI font family (+ style flags) onto a Standard 14 face name. */
function mapUIFamilyToStandard14(family: string, wantBold: boolean, wantItalic: boolean): string {
  const lower = family.toLowerCase();
  let base: 'Helvetica' | 'Times' | 'Courier' = 'Helvetica';
  if (
    lower.includes('times') || lower.includes('georgia') || lower.includes('garamond')
    || lower.includes('palatino') || lower.includes('cambria') || lower.includes('serif')
  ) {
    base = 'Times';
  } else if (
    lower.includes('courier') || lower.includes('mono') || lower.includes('consolas')
    || lower.includes('lucida console')
  ) {
    base = 'Courier';
  }

  if (base === 'Times') {
    if (wantBold && wantItalic) return 'Times-BoldItalic';
    if (wantBold) return 'Times-Bold';
    if (wantItalic) return 'Times-Italic';
    return 'Times-Roman';
  }
  if (base === 'Courier') {
    if (wantBold && wantItalic) return 'Courier-BoldOblique';
    if (wantBold) return 'Courier-Bold';
    if (wantItalic) return 'Courier-Oblique';
    return 'Courier';
  }
  if (wantBold && wantItalic) return 'Helvetica-BoldOblique';
  if (wantBold) return 'Helvetica-Bold';
  if (wantItalic) return 'Helvetica-Oblique';
  return 'Helvetica';
}

export interface StyleEditResult extends EditResult {
  usedSyntheticItalic?: boolean;
  addedUnderline?: boolean;
  removedUnderline?: boolean;
}

function op(operator: string, operands: PDFObject[] = []): CSInstruction {
  return { operator, operands, offset: 0 };
}

/** Map a line-level [start,end) selection onto per-segment ranges. */
export function mapSelectionToSegments(
  line: TextLine,
  selectionStart: number,
  selectionEnd: number,
): Array<{ segment: StyledSegment; localStart: number; localEnd: number }> {
  const start = Math.max(0, Math.min(selectionStart, line.text.length));
  const end = Math.max(start, Math.min(selectionEnd, line.text.length));
  const hits: Array<{ segment: StyledSegment; localStart: number; localEnd: number }> = [];

  for (const seg of line.segments) {
    const overlapStart = Math.max(start, seg.startIndex);
    const overlapEnd = Math.min(end, seg.endIndex);
    if (overlapStart < overlapEnd) {
      hits.push({
        segment: seg,
        localStart: overlapStart - seg.startIndex,
        localEnd: overlapEnd - seg.startIndex,
      });
    }
  }
  return hits;
}

/**
 * When fontSize grows on a mid-line span, sibling runs keep absolute Tm and
 * pile onto the enlarged glyphs. Shift trailing peers by selectedW×(ratio−1).
 *
 * Peer selection is by CHARACTER INDEX (segments starting at/after selectionEnd),
 * not by x — after caret-aware redistribute the grown span is often one mega-run,
 * so every later word shares that run and an x-fence finds nobody to shift.
 */
function collectFontSizeTrailingShifts(
  line: TextLine,
  selectionStart: number,
  selectionEnd: number,
  newFontSize: number,
): {
  shifts: RunPositionShift[];
  growthDx: number;
  fenceX: number;
  ownedCount: number;
  trailingSegs: number;
} {
  const hits = mapSelectionToSegments(line, selectionStart, selectionEnd);
  if (hits.length === 0) {
    return { shifts: [], growthDx: 0, fenceX: 0, ownedCount: 0, trailingSegs: 0 };
  }

  let growthDx = 0;
  let fenceX = Infinity;
  const owned = new Set<TextRun>();

  for (const h of hits) {
    const run = h.segment.run;
    owned.add(run);
    const oldFs = visualFontSize(run);
    if (oldFs < 0.5) continue;
    const ratio = newFontSize / oldFs;
    if (Math.abs(ratio - 1) < 0.02) continue;

    const localText = run.text.slice(h.localStart, h.localEnd);
    const wGlyph = widthUpToChar(run, h.localEnd) - widthUpToChar(run, h.localStart);
    const wEst = estimateTextWidth(localText, run);
    const selectedW = Math.max(wGlyph, wEst, localText.length * oldFs * 0.45);
    growthDx += selectedW * (ratio - 1);

    const startX = run.x + widthUpToChar(run, h.localStart);
    if (startX < fenceX) fenceX = startX;
  }

  if (fenceX === Infinity || Math.abs(growthDx) < 0.35) {
    return { shifts: [], growthDx: 0, fenceX: 0, ownedCount: owned.size, trailingSegs: 0 };
  }

  const maxGrowth = Math.max(8, (selectionEnd - selectionStart) * newFontSize * 0.7);
  if (growthDx > maxGrowth) growthDx = maxGrowth;

  // Whitespace-only enlargements must not shove the rest of the line.
  const selectedSlice = line.text.slice(selectionStart, selectionEnd);
  if (/^\s*$/.test(selectedSlice)) {
    return { shifts: [], growthDx: 0, fenceX: fenceX, ownedCount: owned.size, trailingSegs: 0 };
  }

  const shifts: RunPositionShift[] = [];
  const seen = new Set<TextRun>();
  let trailingSegs = 0;
  for (const seg of line.segments) {
    if (seg.startIndex < selectionEnd) continue;
    trailingSegs++;
    const run = seg.run;
    if (owned.has(run) || seen.has(run)) continue;
    if ((run.sourceInstructionIndices ?? []).length === 0) continue;
    seen.add(run);
    shifts.push({ run, dx: growthDx, dy: 0 });
  }

  // Fallback: x-fence when redistribute absorbed later words into the owned run
  // (no segment starts at/after selectionEnd).
  if (shifts.length === 0) {
    for (const run of line.runs) {
      if (owned.has(run) || seen.has(run)) continue;
      if ((run.sourceInstructionIndices ?? []).length === 0) continue;
      if (getRunBounds(run).left >= fenceX - 0.5) {
        seen.add(run);
        shifts.push({ run, dx: growthDx, dy: 0 });
      }
    }
  }

  return { shifts, growthDx, fenceX, ownedCount: owned.size, trailingSegs };
}

/**
 * One trailing-shift pass for many mid-line fontSize patches (e.g. typed
 * letters separated by spaces). Sequential per-patch shifts stack on the same
 * peers and invent rivers; skipping all shifts lets oversized glyphs overlap.
 *
 * For each segment after a patch, dx = sum of growth from patches that end
 * at/before that segment — same math as sequential applies, one write.
 */
export function collectBatchedFontSizeTrailingShifts(
  line: TextLine,
  ranges: Array<{ start: number; end: number; fontSize: number }>,
): {
  shifts: RunPositionShift[];
  totalGrowthDx: number;
  rangeCount: number;
} {
  const parts: Array<{
    start: number;
    end: number;
    growthDx: number;
    fenceX: number;
    owned: Set<TextRun>;
  }> = [];

  for (const r of ranges) {
    if (r.end <= r.start || r.fontSize == null) continue;
    if (/^\s*$/.test(line.text.slice(r.start, r.end))) continue;
    const one = collectFontSizeTrailingShifts(line, r.start, r.end, r.fontSize);
    if (one.growthDx < 0.35) continue;
    const owned = new Set<TextRun>();
    for (const h of mapSelectionToSegments(line, r.start, r.end)) {
      owned.add(h.segment.run);
    }
    parts.push({
      start: r.start,
      end: r.end,
      growthDx: one.growthDx,
      fenceX: one.fenceX,
      owned,
    });
  }
  if (parts.length === 0) {
    return { shifts: [], totalGrowthDx: 0, rangeCount: 0 };
  }

  const allOwned = new Set<TextRun>();
  for (const p of parts) {
    for (const r of p.owned) allOwned.add(r);
  }

  const dxByRun = new Map<TextRun, number>();
  const seen = new Set<TextRun>();
  for (const seg of line.segments) {
    const run = seg.run;
    if (seen.has(run) || allOwned.has(run)) continue;
    if ((run.sourceInstructionIndices ?? []).length === 0) continue;
    let dx = 0;
    for (const p of parts) {
      if (seg.startIndex >= p.end) dx += p.growthDx;
    }
    if (dx < 0.35) continue;
    seen.add(run);
    dxByRun.set(run, dx);
  }

  if (dxByRun.size === 0) {
    const total = parts.reduce((s, p) => s + p.growthDx, 0);
    let fenceX = Infinity;
    for (const p of parts) {
      if (p.fenceX < fenceX) fenceX = p.fenceX;
    }
    if (Number.isFinite(fenceX) && total >= 0.35) {
      for (const run of line.runs) {
        if (allOwned.has(run)) continue;
        if ((run.sourceInstructionIndices ?? []).length === 0) continue;
        if (getRunBounds(run).left >= fenceX - 0.5) {
          dxByRun.set(run, total);
        }
      }
    }
  }

  const shifts: RunPositionShift[] = [];
  let totalGrowthDx = 0;
  for (const [run, dx] of dxByRun) {
    shifts.push({ run, dx, dy: 0 });
    totalGrowthDx = Math.max(totalGrowthDx, dx);
  }
  return { shifts, totalGrowthDx, rangeCount: parts.length };
}

/**
 * After Tf grows mid-line glyphs, push every same-line run that still starts
 * under the enlarged span by ONE uniform dx (no cascading re-pack).
 *
 * Only runs that overlap the just-styled selection count as "enlarged".
 * Matching every same-size run on the line (e.g. an earlier 16pt insert)
 * makes interstitial content (spaces between two large words) look like an
 * overlap of a mega-span and shoves the rest of the line by hundreds of units.
 */
function fixLineLocalOverlapsAfterFontSize(
  contentBytes: Uint8Array,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  line: TextLine,
  selectionStart: number,
  selectionEnd: number,
  newFontSize: number,
): { bytes: Uint8Array; fixes: number; totalDx: number; pairs: Array<{ left: string; right: string; dx: number }> } {
  const interpreted = interpretPage(contentBytes, page, objects);
  const freshLines = reconstructLines(interpreted.textRuns);
  const normalize = (t: string) => t.replace(/[\u2013\u2014\u2212]/g, '-');
  const want = normalize(line.text);
  const midSlice = line.text.slice(selectionStart, selectionEnd);
  const baseTol = Math.max(2, line.fontSize * 0.35);
  const sameBaseline = freshLines.filter(
    l => Math.abs(l.baseline - line.baseline) <= baseTol,
  );

  // Intact line, else mid-bearing fragment, else all same-baseline lines.
  // After a mid-line Tf split, column detection often tears the enlarged mid
  // onto a sibling cell — peers must still include the after-fragment.
  const fresh =
    sameBaseline.find(l => l.text === line.text)
    ?? sameBaseline.find(l => normalize(l.text) === want)
    ?? (midSlice.trim()
      ? sameBaseline.find(l => l.text.includes(midSlice.trim()))
      : undefined)
    ?? null;

  const peerSource = fresh ? [fresh] : sameBaseline;
  if (peerSource.length === 0) {
    return { bytes: contentBytes, fixes: 0, totalDx: 0, pairs: [] };
  }

  // Don't repack the line when only spaces were enlarged.
  if (/^\s*$/.test(midSlice)) {
    return { bytes: contentBytes, fixes: 0, totalDx: 0, pairs: [] };
  }

  const peers = peerSource
    .flatMap(l => l.runs)
    .filter(r => (r.sourceInstructionIndices ?? []).length > 0)
    .sort((a, b) => getRunBounds(a).left - getRunBounds(b).left);

  if (peers.length < 2) {
    return { bytes: contentBytes, fixes: 0, totalDx: 0, pairs: [] };
  }

  // Selection-local enlarged runs only (not every same-size run on the line).
  const enlarged: TextRun[] = [];
  const seen = new Set<TextRun>();
  const segLists = fresh ? [fresh.segments] : peerSource.map(l => l.segments);
  for (const segments of segLists) {
    for (const seg of segments) {
      if (fresh) {
        if (seg.endIndex <= selectionStart || seg.startIndex >= selectionEnd) continue;
      } else if (midSlice.trim() && !seg.text.includes(midSlice.trim())
        && !midSlice.includes(seg.text.trim())) {
        // Union path: prefer runs that carry the enlarged slice.
        if (Math.abs(visualFontSize(seg.run) - newFontSize) >= 1.0) continue;
      }
      const run = seg.run;
      if (seen.has(run)) continue;
      if ((run.sourceInstructionIndices ?? []).length === 0) continue;
      if (Math.abs(visualFontSize(run) - newFontSize) < 1.0) {
        seen.add(run);
        enlarged.push(run);
      }
    }
  }
  if (enlarged.length === 0) {
    // Fallback: original line hits → match fresh runs by text + x proximity
    const hits = mapSelectionToSegments(line, selectionStart, selectionEnd);
    for (const h of hits) {
      const hb = getRunBounds(h.segment.run);
      const match = peers.find(r => {
        if (seen.has(r)) return false;
        if (Math.abs(visualFontSize(r) - newFontSize) >= 1.0) return false;
        const b = getRunBounds(r);
        return Math.abs(b.left - hb.left) < Math.max(8, newFontSize)
          || r.text.includes(h.segment.run.text.slice(h.localStart, h.localEnd));
      });
      if (match) {
        seen.add(match);
        enlarged.push(match);
      }
    }
  }
  if (enlarged.length === 0) {
    return { bytes: contentBytes, fixes: 0, totalDx: 0, pairs: [] };
  }

  let grownRight = -Infinity;
  let enlargedLeft = Infinity;
  let enlargedMaxIdx = -1;
  for (const r of enlarged) {
    const b = getRunBounds(r);
    if (b.right > grownRight) grownRight = b.right;
    if (b.left < enlargedLeft) enlargedLeft = b.left;
    for (const idx of r.sourceInstructionIndices ?? []) {
      if (idx > enlargedMaxIdx) enlargedMaxIdx = idx;
    }
  }
  // Mid glyphs sometimes report ~0 advance after a size-only byte-split; floor
  // grownRight so the after-fragment can still clear the typed span.
  const midFloor =
    enlargedLeft
    + Math.max(1, midSlice.replace(/\s/g, '').length) * newFontSize * 0.42;
  if (grownRight < midFloor) grownRight = midFloor;

  if (!Number.isFinite(grownRight)) {
    return { bytes: contentBytes, fixes: 0, totalDx: 0, pairs: [] };
  }

  const minGap = Math.max(
    fresh?.fontSize ?? line.fontSize,
    line.fontSize,
    8,
  ) * 0.1;
  const enlargedSet = new Set(enlarged);
  // Per-peer cascade from a running fence. Stream-after fragments (same BT,
  // consecutive Tj after the enlarged mid) must NOT be position-shifted —
  // applyRunPositionShifts often falls back to absolute Tm at run.x (the
  // before-origin), teleporting "structure" from ~242 back to ~105.
  const selLen = Math.max(1, selectionEnd - selectionStart);
  const softMaxDx = Math.min(selLen * newFontSize * 0.45, newFontSize * 4);
  const shifts: RunPositionShift[] = [];
  const pairs: Array<{ left: string; right: string; dx: number }> = [];
  let fenceRight = grownRight;
  let seenEnlarged = false;
  let totalDx = 0;
  for (let i = 0; i < peers.length; i++) {
    const peer = peers[i];
    if (enlargedSet.has(peer)) {
      seenEnlarged = true;
      fenceRight = Math.max(fenceRight, getRunBounds(peer).right, grownRight);
      continue;
    }
    if (!seenEnlarged) continue;
    const b = getRunBounds(peer);
    const idxs = peer.sourceInstructionIndices ?? [];
    const peerMinIdx = idxs.length > 0 ? Math.min(...idxs) : -1;
    const underSpan = b.left >= enlargedLeft - 0.5 && b.left < grownRight - 0.5;
    const overlapsPrev = b.left < fenceRight - 0.5;
    // After-fragment of a Tf split: sits at/just past mid via Tj advance.
    // Far trailers also have higher instruction indices — only skip the near one.
    const afterFragment =
      peerMinIdx > enlargedMaxIdx
      && b.left <= grownRight + Math.max(minGap, newFontSize * 0.25);
    if (afterFragment) {
      fenceRight = Math.max(fenceRight, b.right, grownRight);
      continue;
    }
    if (!underSpan && !overlapsPrev) {
      fenceRight = Math.max(fenceRight, b.right);
      continue;
    }
    let peerDx = Math.max(
      grownRight + minGap - b.left,
      fenceRight + minGap - b.left,
    );
    if (underSpan && !overlapsPrev && peerDx > softMaxDx) {
      peerDx = softMaxDx;
    }
    if (peerDx > 0.5) {
      shifts.push({ run: peer, dx: peerDx, dy: 0 });
      totalDx += peerDx;
      pairs.push({
        left: `fence@${Math.round(fenceRight * 10) / 10}`,
        right: peer.text.slice(0, 12),
        dx: Math.round(peerDx * 100) / 100,
      });
      fenceRight = b.right + peerDx;
    } else {
      fenceRight = Math.max(fenceRight, b.right);
    }
  }
  if (shifts.length === 0) {
    return { bytes: contentBytes, fixes: 0, totalDx: 0, pairs: [] };
  }

  return {
    bytes: applyRunPositionShifts(contentBytes, shifts, peers),
    fixes: shifts.length,
    totalDx,
    pairs,
  };
}

/** Strip weight/style tokens so we can rebuild a Regular/Bold/Italic face name. */
function stripStyleTokens(name: string): string {
  return name
    .replace(/^.*\+/, '')
    .replace(/,.*$/, '')
    .replace(/[-_]?(BoldOblique|BoldItalic|Bold|Black|Heavy|SemiBold|DemiBold|Italic|Oblique|Regular|Medium|Light)/gi, '')
    .replace(/[-_]+$/g, '') || name.replace(/^.*\+/, '');
}

/** Guess a bold/italic sibling Standard14 (or family) font name. */
export function resolveStyledFontName(
  baseName: string,
  bold?: boolean,
  italic?: boolean,
): string {
  const bare = baseName.replace(/^.*\+/, '').replace(/,.*$/, '');
  const family = stripStyleTokens(bare);
  const wantBold = !!bold;
  const wantItalic = !!italic;

  if (/helvetica/i.test(family) || /^arial$/i.test(family)) {
    if (wantBold && wantItalic) return 'Helvetica-BoldOblique';
    if (wantBold) return 'Helvetica-Bold';
    if (wantItalic) return 'Helvetica-Oblique';
    return 'Helvetica';
  }
  if (/times/i.test(family) || /roman/i.test(family)) {
    if (wantBold && wantItalic) return 'Times-BoldItalic';
    if (wantBold) return 'Times-Bold';
    if (wantItalic) return 'Times-Italic';
    return 'Times-Roman';
  }
  if (/courier/i.test(family)) {
    if (wantBold && wantItalic) return 'Courier-BoldOblique';
    if (wantBold) return 'Courier-Bold';
    if (wantItalic) return 'Courier-Oblique';
    return 'Courier';
  }

  // Generic PostScript-style face name
  if (wantBold && wantItalic) return `${family}-BoldItalic`;
  if (wantBold) return `${family}-Bold`;
  if (wantItalic) return `${family}-Italic`;
  return family || bare;
}

function listPageFonts(
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
): Array<{ key: string; baseFont: string }> {
  const out: Array<{ key: string; baseFont: string }> = [];
  const resourcesObj = page.dict.get('Resources');
  const resources = resourcesObj instanceof PDFRef ? resolveRef(resourcesObj, objects) : resourcesObj;
  if (!(resources instanceof PDFDict)) return out;
  let fontDict = resources.get('Font');
  if (fontDict instanceof PDFRef) fontDict = resolveRef(fontDict, objects);
  if (!(fontDict instanceof PDFDict)) return out;
  for (const [k, v] of fontDict.entries()) {
    let dict = v;
    if (dict instanceof PDFRef) dict = resolveRef(dict, objects);
    const baseFont =
      dict instanceof PDFDict ? (dict.getName('BaseFont') ?? k) : k;
    out.push({ key: k, baseFont });
  }
  return out;
}

/**
 * Prefer an existing page font whose BaseFont matches the desired weight/style
 * and the same family as the current run.
 */
function findSiblingFontKey(
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  currentFontName: string,
  wantBold: boolean,
  wantItalic: boolean,
): string | null {
  const fonts = listPageFonts(page, objects);
  const current = fonts.find(f => f.key === currentFontName.replace(/^\//, ''))
    ?? fonts.find(f => f.baseFont === currentFontName);
  const family = stripStyleTokens(current?.baseFont || currentFontName).toLowerCase();

  let best: string | null = null;
  let bestScore = -1;
  for (const f of fonts) {
    const flags = fontNameStyleFlags(f.baseFont);
    if (flags.bold !== wantBold || flags.italic !== wantItalic) continue;
    const fFamily = stripStyleTokens(f.baseFont).toLowerCase();
    let score = 0;
    if (fFamily === family) score += 10;
    else if (fFamily.includes(family) || family.includes(fFamily)) score += 5;
    else continue;
    if (score > bestScore) {
      bestScore = score;
      best = f.key;
    }
  }
  return best;
}

function ensureStandard14Font(
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  baseFont: string,
): string | null {
  const resourceKey = baseFont.replace(/[^A-Za-z0-9]/g, '').slice(0, 16) || 'FStyled';
  const resourcesObj = page.dict.get('Resources');
  let resources = resourcesObj instanceof PDFRef ? resolveRef(resourcesObj, objects) : resourcesObj;
  if (!(resources instanceof PDFDict)) {
    resources = new PDFDict();
    page.dict.set('Resources', resources);
  }
  let fontDict = resources.get('Font');
  if (fontDict instanceof PDFRef) fontDict = resolveRef(fontDict, objects);
  if (!(fontDict instanceof PDFDict)) {
    fontDict = new PDFDict();
    resources.set('Font', fontDict);
  }
  if (fontDict.has(resourceKey)) return resourceKey;

  const allowed = /^(Helvetica|Times-Roman|Times|Courier)/i.test(baseFont);
  if (!allowed) return null;

  const dict = new PDFDict();
  dict.set('Type', new PDFName('Font'));
  dict.set('Subtype', new PDFName('Type1'));
  dict.set('BaseFont', new PDFName(baseFont));
  fontDict.set(resourceKey, dict);
  return resourceKey;
}

export interface StyleApplyOptions {
  /**
   * When text was just rewritten in the same commit, peers were already shifted
   * for the new glyph widths. Extra fontSize trailing shifts then stack per
   * letter-patch (especially with spaces between them) and invent rivers.
   * Mid-run Tf growth still advances the same-BT tail via Tj; overlap fix
   * catches true collisions.
   */
  skipTrailingFontSizeShifts?: boolean;
  /**
   * Column the line is aligned within. Without it, alignment falls back to
   * symmetric page margins around the line's left edge.
   */
  alignBounds?: { left: number; right: number };
}

/**
 * Apply style to a character range on a line — safe in-BT patches only.
 */
export function applyStyleToSelection(
  contentBytes: Uint8Array,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  line: TextLine,
  selectionStart: number,
  selectionEnd: number,
  style: TextStylePatch,
  options?: StyleApplyOptions,
): StyleEditResult {
  const start = Math.max(0, Math.min(selectionStart, line.text.length));
  const end = Math.max(start, Math.min(selectionEnd, line.text.length));
  // Collapsed ranges are a no-op here — callers must expand to a segment/line first.
  const hits = end > start ? mapSelectionToSegments(line, start, end) : [];
  if (hits.length === 0) {
    return {
      newContentBytes: contentBytes,
      needsFontAugmentation: false,
      missingCharCodes: [],
      usedSyntheticItalic: false,
      addedUnderline: false,
      removedUnderline: false,
    };
  }

  // Merge overlapping local ranges per run so partial bold/italic can split once.
  const byRun = new Map<TextRun, { localStart: number; localEnd: number }>();
  for (const h of hits) {
    const prev = byRun.get(h.segment.run);
    if (!prev) {
      byRun.set(h.segment.run, { localStart: h.localStart, localEnd: h.localEnd });
    } else {
      prev.localStart = Math.min(prev.localStart, h.localStart);
      prev.localEnd = Math.max(prev.localEnd, h.localEnd);
    }
  }

  let bytes = contentBytes;
  let addedUnderline = false;
  let removedUnderline = false;

  // Push trailing absolute-Tm peers BEFORE patching Tf — indices must stay valid.
  // growthDx = selectedW × (newFs/oldFs − 1) stacks with text-edit insert shifts.
  if (
    style.fontSize != null
    && end > start
    && !options?.skipTrailingFontSizeShifts
  ) {
    const { shifts } = collectFontSizeTrailingShifts(
      line, start, end, style.fontSize,
    );
    if (shifts.length > 0) {
      bytes = applyRunPositionShifts(bytes, shifts, line.runs);
    }
  }

  // Right to left: ops inserted for one run must not shift the source
  // indices of runs still to be patched.
  const ordered = [...byRun].sort(
    (a, b) => Math.min(...(b[0].sourceInstructionIndices ?? [0])) - Math.min(...(a[0].sourceInstructionIndices ?? [0])),
  );
  for (const [run, range] of ordered) {
    const patched = patchRunStyle(
      bytes, run, style, page, objects, range.localStart, range.localEnd,
    );
    bytes = patched.bytes;
    addedUnderline = addedUnderline || patched.addedUnderline;
    removedUnderline = removedUnderline || patched.removedUnderline;
  }

  // After Tf grows mid glyphs, push any same-line runs that still overlap
  // (e.g. the "after" fragment of a style split that didn't advance enough).
  if (style.fontSize != null && end > start) {
    const fixed = fixLineLocalOverlapsAfterFontSize(
      bytes, page, objects, line, start, end, style.fontSize,
    );
    bytes = fixed.bytes;
  }

  if (style.align && line.runs.length > 0) {
    const bounds = options?.alignBounds ?? {
      left: line.leftMargin,
      right: page.mediaBox.x + page.mediaBox.width - (line.leftMargin - page.mediaBox.x),
    };
    bytes = applyAlignmentShift(bytes, line, style.align, bounds);
  }

  return {
    newContentBytes: bytes,
    needsFontAugmentation: false,
    missingCharCodes: [],
    usedSyntheticItalic: false,
    addedUnderline,
    removedUnderline,
  };
}

export function applyStyleToLine(
  contentBytes: Uint8Array,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  line: TextLine,
  style: TextStylePatch,
): StyleEditResult {
  return applyStyleToSelection(contentBytes, page, objects, line, 0, line.text.length, style);
}

export async function applyStyleToSelectionOnPage(
  doc: PDFDocumentData,
  pageIndex: number,
  line: TextLine,
  selectionStart: number,
  selectionEnd: number,
  style: TextStylePatch,
  options?: StyleApplyOptions,
): Promise<StyleEditResult> {
  const page = doc.pages[pageIndex];
  const contentBytes = getPageContentBytes(page, doc.objects);
  let opts = options;
  if (style.align && !opts?.alignBounds) {
    const lines = reconstructLines(interpretPage(contentBytes, page, doc.objects).textRuns);
    opts = { ...opts, alignBounds: alignmentBoundsForLine(line, lines, page) };
  }
  const result = applyStyleToSelection(
    contentBytes, page, doc.objects, line, selectionStart, selectionEnd, style, opts,
  );
  await updatePageContent(page.contentRefs, result.newContentBytes, doc.objects);
  return result;
}

function findBtEtRange(
  instructions: CSInstruction[],
  textIndex: number,
): { bt: number; et: number } | null {
  let bt = -1;
  for (let i = textIndex; i >= 0; i--) {
    if (instructions[i].operator === 'ET') return null;
    if (instructions[i].operator === 'BT') { bt = i; break; }
  }
  if (bt < 0) return null;
  let et = -1;
  for (let i = textIndex; i < instructions.length; i++) {
    if (instructions[i].operator === 'ET') { et = i; break; }
  }
  if (et < 0) return null;
  return { bt, et };
}

/** Prefer a real Tj/TJ/'/" index — min(indices) is often a preceding Tf after font switches. */
function resolveTextShowingIndex(
  instructions: CSInstruction[],
  indices: number[],
): number {
  const sorted = [...indices].sort((a, b) => a - b);
  for (const i of sorted) {
    const op = instructions[i]?.operator;
    if (op === 'Tj' || op === 'TJ' || op === "'" || op === '"') return i;
  }
  const start = sorted.length > 0 ? sorted[0] : 0;
  for (let i = start; i < instructions.length; i++) {
    const op = instructions[i]?.operator;
    if (op === 'ET') break;
    if (op === 'Tj' || op === 'TJ' || op === "'" || op === '"') return i;
  }
  return sorted[0] ?? 0;
}

/**
 * Wrap already-encoded Tj/TJ string bytes in a TJ array, inserting space
 * advances without re-encoding letter CIDs.
 */
function tjFromEncodedWithSpaceAdvances(
  text: string,
  encoded: PDFObject,
  fontData: FontData | null,
): PDFArray {
  let bytes: Uint8Array;
  let asHex = false;
  if (encoded instanceof PDFHexString) {
    bytes = encoded.toBytes();
    asHex = true;
  } else if (encoded instanceof PDFString) {
    bytes = encoded.toBytes();
  } else if (encoded instanceof PDFArray) {
    // Already a TJ — prefer rebuild from text via standard path
    return buildTJWithSpaceAdvances(text, fontData, false);
  } else {
    return buildTJWithSpaceAdvances(text, fontData, false);
  }

  const isComposite = !!fontData?.isComposite;
  const bpc = isComposite ? 2 : 1;
  if (bytes.length < text.length * bpc) {
    return buildTJWithSpaceAdvances(text, fontData, false);
  }

  const toPdfString = (from: number, to: number): PDFObject => {
    const part = bytes.slice(from, to);
    if (asHex) {
      let hex = '';
      for (let i = 0; i < part.length; i++) hex += part[i].toString(16).padStart(2, '0');
      return new PDFHexString(hex);
    }
    let s = '';
    for (let i = 0; i < part.length; i++) s += String.fromCharCode(part[i]);
    return new PDFString(s);
  };

  const items: PDFObject[] = [];
  let bytePos = 0;
  let i = 0;
  const supplemental = spaceSupplementalTJ(fontData, false);
  while (i < text.length) {
    if (text[i] === ' ') {
      let j = i;
      while (j < text.length && text[j] === ' ') j++;
      const n = j - i;
      const byteLen = n * bpc;
      items.push(toPdfString(bytePos, bytePos + byteLen));
      if (supplemental > 0) {
        const advChars = Math.min(n, SPACE_TJ_MAX_CHARS);
        items.push(new PDFNumber(-Math.round(advChars * supplemental)));
      }
      bytePos += byteLen;
      i = j;
      continue;
    }
    let j = i;
    while (j < text.length && text[j] !== ' ') j++;
    const n = j - i;
    const byteLen = n * bpc;
    items.push(toPdfString(bytePos, bytePos + byteLen));
    bytePos += byteLen;
    i = j;
  }
  if (items.length === 0) {
    return buildTJWithSpaceAdvances(text, fontData, false);
  }
  return new PDFArray(items);
}

/**
 * Split an existing Tj/TJ PDF string into before/mid/after by Unicode char index
 * without re-encoding — avoids subset round-trips that turn letters into spaces.
 */
function splitEncodedByUnicodeIndex(
  operand: PDFObject,
  fontData: FontData | null,
  midStart: number,
  midEnd: number,
  totalChars: number,
): { before: PDFObject; mid: PDFObject; after: PDFObject } | null {
  let bytes: Uint8Array;
  let asHex = false;
  if (operand instanceof PDFHexString) {
    bytes = operand.toBytes();
    asHex = true;
  } else if (operand instanceof PDFString) {
    bytes = operand.toBytes();
  } else if (operand instanceof PDFArray) {
    // Flatten TJ string parts only (drop kerning numbers) into one byte stream
    const parts: number[] = [];
    for (let i = 0; i < operand.length; i++) {
      const item = operand.get(i)!;
      if (item instanceof PDFString || item instanceof PDFHexString) {
        const b = item.toBytes();
        for (let j = 0; j < b.length; j++) parts.push(b[j]);
        if (item instanceof PDFHexString) asHex = true;
      }
    }
    if (parts.length === 0) return null;
    bytes = new Uint8Array(parts);
  } else {
    return null;
  }

  const isComposite = !!fontData?.isComposite;
  const cuts: number[] = [0]; // byte offsets at unicode boundaries
  let idx = 0;
  let charCount = 0;
  while (idx < bytes.length && charCount < totalChars) {
    if (isComposite && idx + 1 < bytes.length) idx += 2;
    else idx += 1;
    charCount++;
    cuts.push(idx);
  }
  if (charCount < totalChars || midEnd > charCount) return null;
  if (midStart < 0 || midStart > midEnd) return null;

  const b0 = cuts[midStart] ?? 0;
  const b1 = cuts[midEnd] ?? bytes.length;
  const b2 = cuts[totalChars] ?? bytes.length;
  const slice = (from: number, to: number) => {
    const part = bytes.slice(from, to);
    if (asHex) {
      let hex = '';
      for (let i = 0; i < part.length; i++) hex += part[i].toString(16).padStart(2, '0');
      return new PDFHexString(hex);
    }
    let s = '';
    for (let i = 0; i < part.length; i++) s += String.fromCharCode(part[i]);
    return new PDFString(s);
  };
  return {
    before: slice(0, b0),
    mid: slice(b0, b1),
    after: slice(b1, b2),
  };
}

function patchRunStyle(
  contentBytes: Uint8Array,
  run: TextRun,
  style: TextStylePatch,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  localStart = 0,
  localEnd = run.text.length,
): { bytes: Uint8Array; addedUnderline: boolean; removedUnderline: boolean } {
  const instructions = parseContentStream(contentBytes);
  const indices = run.sourceInstructionIndices ?? [];
  if (indices.length === 0) {
    return { bytes: contentBytes, addedUnderline: false, removedUnderline: false };
  }

  const textIndex = resolveTextShowingIndex(instructions, indices);
  const range = findBtEtRange(instructions, textIndex);
  if (!range) return { bytes: contentBytes, addedUnderline: false, removedUnderline: false };

  let addedUnderline = false;
  let removedUnderline = false;

  const clampStart = Math.max(0, Math.min(localStart, run.text.length));
  const clampEnd = Math.max(clampStart, Math.min(localEnd, run.text.length));
  const isPartial = clampStart > 0 || clampEnd < run.text.length;

  // Color: patch or insert rg just after BT (whole-run; partial color uses split path)
  if (style.color && !isPartial) {
    const [r, g, b] = style.color;
    let found = false;
    for (let i = range.bt + 1; i < textIndex; i++) {
      if (instructions[i].operator === 'rg' || instructions[i].operator === 'RG') {
        instructions[i].operands = [new PDFNumber(r), new PDFNumber(g), new PDFNumber(b)];
        found = true;
        break;
      }
    }
    if (!found) {
      instructions.splice(range.bt + 1, 0, op('rg', [
        new PDFNumber(r), new PDFNumber(g), new PDFNumber(b),
      ]));
    }
  }

  // Font size / face: patch existing Tf / Tm only
  if (style.fontSize != null || style.bold != null || style.italic != null || style.fontFamily != null) {
    let fontKey: string | null = null;
    const fontDataForFlags = loadFontForName(run.fontName, page, objects);
    // F2/F3 resource keys are opaque — never use name-only flags (that marks bold as false).
    const currentFlags = resolveRunStyleFlags(run.fontName, fontDataForFlags);
    const wantBold = style.bold ?? currentFlags.bold;
    const wantItalic = style.italic ?? currentFlags.italic;

    if (style.fontFamily) {
      const desired = mapUIFamilyToStandard14(style.fontFamily, wantBold, wantItalic);
      fontKey = ensureStandard14Font(page, objects, desired);
    } else if (style.bold != null || style.italic != null) {
      // 1) Prefer a sibling already on the page (embedded resume fonts)
      fontKey = findSiblingFontKey(page, objects, run.fontName, wantBold, wantItalic);

      // 2) Fall back to Standard14 face we can inject
      if (!fontKey) {
        // run.fontName is the resource key (F1); the family comes from BaseFont.
        const desired = resolveStyledFontName(fontDataForFlags?.baseFont || run.fontName, wantBold, wantItalic);
        fontKey = ensureStandard14Font(page, objects, desired);
      }
    }

    // Partial range: split Tj into before/mid/after so fontSize/face only hit the selection
    const needsSplit = isPartial && (
      style.fontSize != null
      || (fontKey != null && (style.bold != null || style.italic != null || style.fontFamily != null))
    );
    if (needsSplit) {
      const splitOk = splitRunTextStyle(
        instructions,
        run,
        textIndex,
        clampStart,
        clampEnd,
        fontKey,
        page,
        objects,
        style.fontSize ?? null,
      );
      if (!splitOk) {
        // Fall through to whole-run patch if split failed
        applyWholeRunFontPatch(instructions, run, textIndex, range, style, fontKey);
      }
    } else {
      applyWholeRunFontPatch(instructions, run, textIndex, range, style, fontKey);
    }
  }

  // Underline: replace any nearby stroke, then add one spanning the selection.
  if (style.underline === true) {
    removedUnderline = removeUnderlineNearRun(instructions, run) || removedUnderline;
    const color = style.color ?? run.fillColor ?? [0, 0, 0];
    const y = run.y - visualFontSize(run) * 0.12;
    const startX = run.x + widthUpToChar(run, clampStart);
    // Full-run underlines must cover the drawn advance — glyph summation can
    // undercount after mid-line inserts when widths are estimated.
    let endX = run.x + widthUpToChar(run, clampEnd);
    if (clampStart <= 0 && clampEnd >= run.text.length) {
      endX = run.x + Math.max(run.width, endX - run.x, visualFontSize(run) * 0.5);
    }
    const w = Math.max(endX - startX, visualFontSize(run) * 0.5);
    const ul: CSInstruction[] = [
      op('q'),
      op('RG', [new PDFNumber(color[0]), new PDFNumber(color[1]), new PDFNumber(color[2])]),
      op('w', [new PDFNumber(Math.max(0.4, visualFontSize(run) * 0.05))]),
      op('m', [new PDFNumber(startX), new PDFNumber(y)]),
      op('l', [new PDFNumber(startX + w), new PDFNumber(y)]),
      op('S'),
      op('Q'),
    ];
    const range2 = findBtEtRange(instructions, Math.min(...(run.sourceInstructionIndices ?? [textIndex])));
    const insertAt = (range2?.et ?? range.et) + 1;
    instructions.splice(insertAt, 0, ...ul);
    addedUnderline = true;
  } else if (style.underline === false) {
    removedUnderline = removeUnderlineNearRun(instructions, run) || removedUnderline;
  }

  return { bytes: compileInstructions(instructions), addedUnderline, removedUnderline };
}

const SHOWING_OPS = new Set(['Tj', 'TJ', "'", '"']);

/**
 * True when the Tf at `tfIdx` governs only this run's text-showing ops.
 * Text state outlives BT/ET, so a later text object that shows text before
 * setting its own font also depends on it.
 */
function tfIsExclusiveToRun(
  instructions: CSInstruction[],
  tfIdx: number,
  runShowing: Set<number>,
): boolean {
  for (let i = tfIdx + 1; i < instructions.length; i++) {
    const op = instructions[i].operator;
    if (op === 'Tf') return true;
    if (SHOWING_OPS.has(op) && !runShowing.has(i)) return false;
  }
  return true;
}

function applyWholeRunFontPatch(
  instructions: CSInstruction[],
  run: TextRun,
  textIndex: number,
  range: { bt: number; et: number },
  style: TextStylePatch,
  fontKey: string | null,
): void {
  const range2 = findBtEtRange(instructions, textIndex) ?? range;

  // Governing Tf: inside this text object, else the last one before it.
  let tfIdx = -1;
  for (let i = textIndex; i >= 0; i--) {
    if (instructions[i].operator === 'Tf' && instructions[i].operands.length >= 2) {
      tfIdx = i;
      break;
    }
  }
  const tfInBt = tfIdx >= range2.bt;

  // Tiny Tf with the size carried by Tm (Tf 1 + scaled Tm): scale the Tm.
  if (style.fontSize != null && tfInBt) {
    const tfSize = instructions[tfIdx].operands[1];
    const curTf = tfSize instanceof PDFNumber ? tfSize.value : run.fontSize;
    const visual = visualFontSize(run);
    if (curTf > 0 && curTf <= 1.5 && Math.abs(visual - curTf) > 1) {
      const scale = style.fontSize / visual;
      for (let j = textIndex; j >= range2.bt; j--) {
        if (instructions[j].operator === 'Tm' && instructions[j].operands.length >= 6) {
          for (const idx of [0, 1, 2, 3]) {
            const n = instructions[j].operands[idx];
            if (n instanceof PDFNumber) {
              instructions[j].operands[idx] = new PDFNumber(n.value * scale);
            }
          }
          break;
        }
      }
      if (!fontKey) return;
      style = { ...style, fontSize: undefined };
    }
  }
  if (style.fontSize == null && !fontKey) return;

  const runShowing = new Set(
    (run.sourceInstructionIndices ?? []).filter((i) => SHOWING_OPS.has(instructions[i]?.operator)),
  );
  runShowing.add(textIndex);

  if (tfInBt && tfIsExclusiveToRun(instructions, tfIdx, runShowing)) {
    if (style.fontSize != null) instructions[tfIdx].operands[1] = new PDFNumber(style.fontSize);
    if (fontKey) instructions[tfIdx].operands[0] = new PDFName(fontKey);
    return;
  }

  // The Tf is shared with other lines (T* paragraphs, or a font set once for
  // several text objects): set the new face just for this run and restore
  // the original afterwards, so only this line changes (BE-102).
  const origName = tfIdx >= 0 ? instructions[tfIdx].operands[0] : new PDFName(run.fontName);
  const origSizeOp = tfIdx >= 0 ? instructions[tfIdx].operands[1] : new PDFNumber(run.fontSize);
  const origSize = origSizeOp instanceof PDFNumber ? origSizeOp.value : run.fontSize;
  const newName = fontKey ? new PDFName(fontKey) : origName;
  const newSize = style.fontSize ?? origSize;
  const lastShow = Math.max(...runShowing);
  instructions.splice(lastShow + 1, 0, op('Tf', [origName, new PDFNumber(origSize)]));
  instructions.splice(textIndex, 0, op('Tf', [newName, new PDFNumber(newSize)]));
}

function widthUpToChar(run: TextRun, charCount: number): number {
  if (charCount <= 0) return 0;
  if (!run.glyphs.length) {
    return (run.width / Math.max(1, run.text.length)) * charCount;
  }
  let w = 0;
  let chars = 0;
  for (const g of run.glyphs) {
    if (chars >= charCount) break;
    w += g.width;
    chars += (g.unicode || '').length || 1;
  }
  return w;
}

/**
 * Encode a text piece for a style split. Fall back to Helvetica/WinAnsi when the
 * subset font can't encode bullets, periods, or typed ASCII (avoids `?` / missing glyphs).
 */
function encodePieceForStyle(
  text: string,
  fontData: ReturnType<typeof loadFontForName>,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
): { encoded: EncodedText; fontKey: string | null } {
  if (!text) return { encoded: encodeTextWinAnsi(''), fontKey: null };
  const encoded = encodeTextForFont(text, fontData);
  const lossy = encoded.missing.length > 0
    || (encoded.pdfString instanceof PDFString && encoded.pdfString.value.includes('?') && !text.includes('?'));
  if (lossy) {
    const flags = resolveRunStyleFlags(fontData?.name || fontData?.baseFont || '', fontData);
    return { encoded: encodeTextWinAnsi(text), fontKey: ensureFallbackFont(page, objects, flags) };
  }
  return { encoded, fontKey: null };
}

/**
 * Split a single Tj/TJ at [localStart, localEnd) and apply a different face
 * and/or font size to the middle. Surrounding glyphs keep the original style.
 */
function splitRunTextStyle(
  instructions: CSInstruction[],
  run: TextRun,
  textIndex: number,
  localStart: number,
  localEnd: number,
  newFontKey: string | null,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  newFontSize: number | null = null,
): boolean {
  if (textIndex < 0 || textIndex >= instructions.length) return false;
  if (newFontKey == null && newFontSize == null) return false;
  const inst = instructions[textIndex];
  if (inst.operator !== 'Tj' && inst.operator !== 'TJ' && inst.operator !== "'" && inst.operator !== '"') {
    return false;
  }

  const before = run.text.slice(0, localStart);
  const mid = run.text.slice(localStart, localEnd);
  const after = run.text.slice(localEnd);
  if (!mid) return false;

  const fontData = loadFontForName(run.fontName, page, objects);

  // Find current Tf size / name
  let tfSize: PDFObject = new PDFNumber(run.fontSize);
  let origFontName = run.fontName.replace(/^\//, '');
  for (let i = textIndex; i >= 0; i--) {
    if (instructions[i].operator === 'BT') break;
    if (instructions[i].operator === 'Tf' && instructions[i].operands.length >= 2) {
      tfSize = instructions[i].operands[1];
      const nameOp = instructions[i].operands[0];
      if (nameOp instanceof PDFName) origFontName = nameOp.name;
      break;
    }
  }

  // Unit Tf + scaled Tm: NEVER rewrite Tm (breaks other lines in the same BT).
  // Instead scale the mid Tf relatively: visual' = (midTf/curTf) * visual.
  const curTf = tfSize instanceof PDFNumber ? tfSize.value : run.fontSize;
  const visual = Math.max(0.1, visualFontSize(run));
  const usesScaledTm = curTf > 0 && curTf <= 1.5 && Math.abs(visual - curTf) > 1;

  let midSize: PDFObject = tfSize;
  if (newFontSize != null) {
    if (usesScaledTm) {
      // Keep Tm; choose Tf so rendered size ≈ newFontSize
      midSize = new PDFNumber((newFontSize / visual) * curTf);
    } else {
      midSize = new PDFNumber(newFontSize);
    }
  }

  // Size-only: slice existing Tj/TJ bytes by Unicode index — re-encoding through
  // subset ToUnicode was replacing the after-fragment with leading spaces.
  let beforeOperand: PDFObject | null = null;
  let midOperand: PDFObject | null = null;
  let afterOperand: PDFObject | null = null;
  let beforeFont = origFontName;
  let midFont = (newFontKey ?? origFontName).replace(/^\//, '');
  let afterFont = origFontName;
  let usedByteSplit = false;

  const sizeOnly = newFontKey == null && newFontSize != null;
  if (sizeOnly) {
    const operand = inst.operator === '"' ? inst.operands[2] : inst.operands[0];
    if (operand) {
      const sliced = splitEncodedByUnicodeIndex(
        operand,
        fontData,
        localStart,
        localEnd,
        run.text.length,
      );
      if (sliced) {
        beforeOperand = before ? sliced.before : null;
        midOperand = sliced.mid;
        afterOperand = after ? sliced.after : null;
        usedByteSplit = true;
      }
    }
  }

  if (!usedByteSplit) {
    const beforePiece = before ? encodePieceForStyle(before, fontData, page, objects) : null;
    const midPiece = encodePieceForStyle(mid, fontData, page, objects);
    const afterPiece = after ? encodePieceForStyle(after, fontData, page, objects) : null;
    beforeOperand = beforePiece?.encoded.pdfString ?? null;
    midOperand = midPiece.encoded.pdfString;
    afterOperand = afterPiece?.encoded.pdfString ?? null;
    beforeFont = (beforePiece?.fontKey ?? origFontName).replace(/^\//, '');
    midFont = (newFontKey ?? midPiece.fontKey ?? origFontName).replace(/^\//, '');
    afterFont = (afterPiece?.fontKey ?? origFontName).replace(/^\//, '');
  }


  if (!midOperand) return false;

  // Pieces with spaces need TJ advances (subset space glyphs are ~0 wide).
  // When byte-split succeeded, keep those CID bytes — re-encoding via
  // buildTJWithSpaceAdvances was desyncing mid/after advances.
  const showingOp = (
    text: string,
    operand: PDFObject,
    face: string,
    size: PDFObject,
  ): CSInstruction[] => {
    if (/ /.test(text)) {
      const tj = usedByteSplit
        ? tjFromEncodedWithSpaceAdvances(text, operand, fontData)
        : buildTJWithSpaceAdvances(text, fontData, false);
      return [op('Tf', [new PDFName(face), size]), op('TJ', [tj])];
    }
    return [op('Tf', [new PDFName(face), size]), op('Tj', [operand])];
  };

  const replacement: CSInstruction[] = [];
  // Tj advances the text matrix, so consecutive Tj ops stay on one baseline
  // without Td — inserting Td would double-advance and shift glyphs.
  if (before && beforeOperand) {
    replacement.push(...showingOp(before, beforeOperand, beforeFont, tfSize));
  }
  replacement.push(...showingOp(mid, midOperand, midFont, midSize));
  // Restore face/size for the tail (and later ops in this BT).
  if (after && afterOperand) {
    replacement.push(...showingOp(after, afterOperand, afterFont, tfSize));
  } else {
    replacement.push(op('Tf', [new PDFName(afterFont), tfSize]));
  }


  instructions.splice(textIndex, 1, ...replacement);
  return true;
}

/** Remove horizontal underline strokes near a run (q-wrapped or bare m/l/S). */
function removeUnderlineNearRun(instructions: CSInstruction[], run: TextRun): boolean {
  const fs = visualFontSize(run);
  const targetY = run.y - fs * 0.12;
  const runLeft = run.x - fs * 0.5;
  const runRight = run.x + Math.max(run.width, fs) + fs * 0.5;
  let removed = false;

  const tryRemoveSpan = (mIdx: number, lIdx: number, from: number, to: number): boolean => {
    const mx = instructions[mIdx].operands[0];
    const my = instructions[mIdx].operands[1];
    const lx = instructions[lIdx].operands[0];
    const ly = instructions[lIdx].operands[1];
    if (!(mx instanceof PDFNumber) || !(my instanceof PDFNumber)) return false;
    if (!(lx instanceof PDFNumber) || !(ly instanceof PDFNumber)) return false;
    if (Math.abs(my.value - ly.value) > 0.5) return false;
    if (Math.abs(my.value - targetY) > fs * 0.35) return false;
    const strokeLeft = Math.min(mx.value, lx.value);
    const strokeRight = Math.max(mx.value, lx.value);
    if (strokeRight < runLeft || strokeLeft > runRight) return false;
    if (strokeRight - strokeLeft < fs * 0.3) return false;
    instructions.splice(from, to - from + 1);
    return true;
  };

  for (let i = 0; i < instructions.length - 1; i++) {
    // q … m l S Q
    if (instructions[i].operator === 'q') {
      let mIdx = -1;
      let lIdx = -1;
      let sIdx = -1;
      let qIdx = -1;
      for (let j = i + 1; j < Math.min(i + 12, instructions.length); j++) {
        const opName = instructions[j].operator;
        if (opName === 'm' && mIdx < 0) mIdx = j;
        else if (opName === 'l' && mIdx >= 0 && lIdx < 0) lIdx = j;
        else if (opName === 'S' && lIdx >= 0 && sIdx < 0) sIdx = j;
        else if (opName === 'Q' && sIdx >= 0) { qIdx = j; break; }
        else if (opName === 'q' || opName === 'BT') break;
      }
      if (mIdx >= 0 && lIdx >= 0 && sIdx >= 0 && qIdx >= 0) {
        if (tryRemoveSpan(mIdx, lIdx, i, qIdx)) {
          removed = true;
          i--;
          continue;
        }
      }
    }

    // Bare m l S (common for resume path underlines)
    if (instructions[i].operator === 'm' && i + 2 < instructions.length) {
      if (instructions[i + 1].operator === 'l' && instructions[i + 2].operator === 'S') {
        // Include a preceding w / RG / rg if present (up to 3 ops)
        let from = i;
        for (let k = 1; k <= 3 && i - k >= 0; k++) {
          const prev = instructions[i - k].operator;
          if (prev === 'w' || prev === 'RG' || prev === 'rg' || prev === 'G' || prev === 'g') {
            from = i - k;
          } else break;
        }
        if (tryRemoveSpan(i, i + 1, from, i + 2)) {
          removed = true;
          i = Math.max(-1, from - 1);
        }
      }
    }
  }
  return removed;
}

/**
 * The column a line sits in: lines that overlap it horizontally share its
 * left edge, and the right edge is the wider of their right edges and the
 * page's symmetric right margin.
 */
export function alignmentBoundsForLine(
  line: TextLine,
  lines: TextLine[],
  page: PDFPageInfo,
): { left: number; right: number } {
  const lineRight = line.x + line.width;
  const peers = lines.filter((l) => l.x < lineRight && l.x + l.width > line.x);
  const left = Math.min(line.x, ...peers.map((l) => l.x));
  const pageRight = page.mediaBox.x + page.mediaBox.width;
  const symmetricRight = pageRight - (left - page.mediaBox.x);
  const right = Math.max(symmetricRight, ...peers.map((l) => l.x + l.width));
  return { left, right: Math.min(right, pageRight) };
}

/** Move every run of the line so it sits left, centred or right in `bounds`. */
function applyAlignmentShift(
  contentBytes: Uint8Array,
  line: TextLine,
  align: 'left' | 'center' | 'right',
  bounds: { left: number; right: number },
): Uint8Array {
  if (line.runs.length === 0) return contentBytes;
  const width = line.width;
  const span = bounds.right - bounds.left;
  if (span <= 0) return contentBytes;

  let targetX = bounds.left;
  if (align === 'center') targetX = bounds.left + (span - width) / 2;
  if (align === 'right') targetX = bounds.right - width;
  const dx = targetX - line.x;
  if (Math.abs(dx) < 0.01) return contentBytes;

  // Bracket the line's text-showing ops in each text object with a pair of
  // Td moves (+dx before, −dx after). Editing the text object's Tm or Td
  // instead would also move later lines that position relative to it (T*
  // paragraphs), aligning the whole paragraph rather than this line.
  const instructions = parseContentStream(contentBytes);
  const showing = [...new Set(line.runs.flatMap((r) => r.sourceInstructionIndices ?? []))]
    .filter((i) => SHOWING_OPS.has(instructions[i]?.operator))
    .sort((a, b) => a - b);
  if (showing.length === 0) return contentBytes;

  const groups = new Map<number, number[]>();
  for (const i of showing) {
    const range = findBtEtRange(instructions, i);
    if (!range) return contentBytes;
    const list = groups.get(range.bt) ?? [];
    list.push(i);
    groups.set(range.bt, list);
  }
  // Insert from the end so earlier indices stay valid.
  const ordered = [...groups.values()].sort((a, b) => b[0] - a[0]);
  for (const list of ordered) {
    const first = list[0];
    const last = list[list.length - 1];
    instructions.splice(last + 1, 0, op('Td', [new PDFNumber(-dx), new PDFNumber(0)]));
    instructions.splice(first, 0, op('Td', [new PDFNumber(dx), new PDFNumber(0)]));
  }
  return compileInstructions(instructions);
}

/**
 * Duplicate a text line below itself (same glyphs, shifted down by line height).
 * Useful for table-like rows and form-style label lines.
 */
export function duplicateLineBelow(
  contentBytes: Uint8Array,
  line: TextLine,
  dyOverride?: number,
): Uint8Array {
  const instructions = parseContentStream(contentBytes);
  const dy = dyOverride ?? -(Math.max(
    line.runs[0] ? visualFontSize(line.runs[0]) : line.fontSize,
    line.fontSize,
  ) * 1.35);
  const clones: CSInstruction[] = [];
  const seenRanges = new Set<string>();

  for (const run of line.runs) {
    const indices = run.sourceInstructionIndices ?? [];
    if (indices.length === 0) continue;
    const textIndex = Math.min(...indices);
    const range = findBtEtRange(instructions, textIndex);
    if (!range) continue;
    const key = `${range.bt}:${range.et}`;
    if (seenRanges.has(key)) continue;
    seenRanges.add(key);

    // The copy is appended at the end of the stream, so it must carry the
    // state the original relied on: the CTM from enclosing cm operators, and
    // the font and fill colour, which may have been set outside this BT.
    const ctm = ctmAt(instructions, range.bt);
    const scaleY = Math.abs(ctm[3]) > 1e-6 ? ctm[3] : 1;
    const body = instructions.slice(range.bt + 1, range.et).map(cloneInstruction);
    shiftInstructionsY(body, dy / scaleY);
    const color = run.fillColor ?? [0, 0, 0];
    clones.push(
      op('q'),
      op('cm', ctm.map(n => new PDFNumber(n))),
      op('rg', [new PDFNumber(color[0]), new PDFNumber(color[1]), new PDFNumber(color[2])]),
      op('BT'),
      op('Tf', [new PDFName(run.fontName.replace(/^\//, '')), new PDFNumber(run.fontSize || visualFontSize(run))]),
      ...body,
      op('ET'),
      op('Q'),
    );
  }

  if (clones.length === 0) {
    // Fallback: inject a fresh text run under the line
    const run = line.runs[0];
    if (!run) return contentBytes;
    const color = run.fillColor ?? [0, 0, 0];
    const fs = visualFontSize(run);
    clones.push(
      op('q'),
      op('BT'),
      op('rg', [new PDFNumber(color[0]), new PDFNumber(color[1]), new PDFNumber(color[2])]),
      op('Tf', [new PDFName(run.fontName.replace(/^\//, '')), new PDFNumber(run.fontSize || fs)]),
      op('Tm', [
        new PDFNumber(1), new PDFNumber(0), new PDFNumber(0), new PDFNumber(1),
        new PDFNumber(run.x), new PDFNumber(run.y + dy),
      ]),
      op('Tj', [new PDFString(line.text)]),
      op('ET'),
      op('Q'),
    );
  }

  instructions.push(...clones);
  return compileInstructions(instructions);
}

/**
 * Add Row: move the rows below down by one row pitch, then copy the row into
 * the gap. `rowPitch` is the distance between row baselines when known.
 */
export function duplicateTableRowBelow(
  contentBytes: Uint8Array,
  rowLines: TextLine[],
  linesBelow: TextLine[] = [],
  rowPitch?: number,
): Uint8Array {
  if (rowLines.length === 0) return contentBytes;
  const heights = rowLines.map(l =>
    Math.max(l.fontSize, l.runs[0] ? visualFontSize(l.runs[0]) : l.fontSize) * 1.35,
  );
  const dy = -(rowPitch && rowPitch > 0 ? rowPitch : Math.max(...heights, 14));
  let bytes = shiftLinesY(contentBytes, linesBelow, dy);
  for (const line of rowLines) {
    bytes = duplicateLineBelow(bytes, line, dy);
  }
  const baseline = Math.min(...rowLines.map(l => l.baseline));
  return shiftTablePathsForNewRow(bytes, baseline, -dy);
}

const PATH_BUILD_OPS = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're']);
const PATH_PAINT_OPS = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n']);

type Ctm = [number, number, number, number, number, number];
const mulCtm = (m: Ctm, n: Ctm): Ctm => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];

/**
 * Make a table's borders and cell backgrounds follow a row inserted below
 * the row on `baseline` (BE-103). Paths below the row move down by `pitch`,
 * paths inside the row are copied one pitch lower (backgrounds, the row's
 * borders), and grid lines that run through the row get longer.
 */
export function shiftTablePathsForNewRow(contentBytes: Uint8Array, baseline: number, pitch: number): Uint8Array {
  const instructions = parseContentStream(contentBytes);
  const num = (o: PDFObject | undefined) => (o instanceof PDFNumber ? o.value : 0);

  type Block = { start: number; end: number; ctm: Ctm; ys: number[]; clip: boolean };
  const blocks: Block[] = [];
  const stack: Ctm[] = [];
  let ctm: Ctm = [1, 0, 0, 1, 0, 0];
  let start = -1;
  let clip = false;
  for (let i = 0; i < instructions.length; i++) {
    const { operator: o, operands } = instructions[i];
    if (o === 'q') stack.push(ctm);
    else if (o === 'Q') ctm = stack.pop() ?? ctm;
    else if (o === 'cm' && operands.length >= 6) ctm = mulCtm(operands.slice(0, 6).map(num) as Ctm, ctm);
    else if (PATH_BUILD_OPS.has(o)) { if (start < 0) start = i; }
    else if (o === 'W' || o === 'W*') clip = true;
    else if (PATH_PAINT_OPS.has(o)) {
      if (start >= 0) {
        const ys: number[] = [];
        for (let j = start; j < i; j++) {
          const ins = instructions[j];
          const v = ins.operands.map(num);
          const pts: [number, number][] = ins.operator === 're'
            ? [[v[0], v[1]], [v[0] + v[2], v[1] + v[3]]]
            : ins.operator === 'h' ? [] : Array.from({ length: v.length / 2 }, (_, k) => [v[2 * k], v[2 * k + 1]] as [number, number]);
          for (const [x, y] of pts) ys.push(ctm[1] * x + ctm[3] * y + ctm[5]);
        }
        if (o !== 'n' && ys.length > 0) blocks.push({ start, end: i, ctm, ys, clip });
      }
      start = -1;
      clip = false;
    }
  }

  // The row's bottom border: the nearest horizontal edge below the baseline.
  const eps = 0.5;
  const edges = blocks.flatMap(b => b.ys).filter(y => y < baseline && y > baseline - pitch);
  const rowBottom = edges.length > 0 ? Math.max(...edges) : baseline - pitch * 0.3;
  const rowTop = rowBottom + pitch;

  const shiftOps = (ctmAt: Ctm, block: CSInstruction[]): CSInstruction[] => {
    // Translate by −pitch in page space, expressed in the block's local space.
    const det = ctmAt[0] * ctmAt[3] - ctmAt[1] * ctmAt[2];
    if (Math.abs(det) < 1e-9) return block;
    const tx = (ctmAt[2] * pitch) / det;
    const ty = (-ctmAt[0] * pitch) / det;
    return [op('q'), op('cm', [1, 0, 0, 1, tx, ty].map(n => new PDFNumber(n))), ...block, op('Q')];
  };

  let changed = false;
  for (let k = blocks.length - 1; k >= 0; k--) {
    const b = blocks[k];
    if (b.clip) continue;
    const top = Math.max(...b.ys);
    const bottom = Math.min(...b.ys);
    const block = instructions.slice(b.start, b.end + 1);
    if (top <= rowBottom + eps) {
      instructions.splice(b.start, block.length, ...shiftOps(b.ctm, block));
      changed = true;
    } else if (bottom >= rowBottom - eps && top <= rowTop + eps) {
      const copy = block.map(ins => ({ ...ins, operands: [...ins.operands] }));
      instructions.splice(b.end + 1, 0, ...shiftOps(b.ctm, copy));
      changed = true;
    } else if (bottom < rowBottom - eps && b.ctm[1] === 0 && b.ctm[2] === 0 && b.ctm[3] !== 0) {
      // Grid line through the row: move its lower end(s) down.
      const d = b.ctm[3];
      const f = b.ctm[5];
      const lower = (yl: number) => (d * yl + f <= rowBottom + eps ? yl - pitch / d : yl);
      for (let j = b.start; j < b.end; j++) {
        const ins = instructions[j];
        if (ins.operator === 're') {
          const v = ins.operands.map(num);
          const y0 = lower(v[1]);
          const y1 = lower(v[1] + v[3]);
          ins.operands = [v[0], y0, v[2], y1 - y0].map(n => new PDFNumber(n));
        } else if (ins.operator !== 'h') {
          ins.operands = ins.operands.map((o, idx) => (idx % 2 === 1 ? new PDFNumber(lower(num(o))) : o));
        }
      }
      changed = true;
    }
  }
  return changed ? compileInstructions(instructions) : contentBytes;
}

/** Text placed in each cell of a column added with Add Column Right. */
export const NEW_COLUMN_PLACEHOLDER = 'New';

/**
 * Add a column to the right of a table: one placeholder cell per row, all
 * left-aligned on the same x after the widest row, on each row's baseline.
 */
export function insertTableColumnRight(
  contentBytes: Uint8Array,
  rowLines: TextLine[][],
): Uint8Array {
  const rows = rowLines.filter(r => r.length > 0);
  if (rows.length === 0) return contentBytes;
  const tableRight = Math.max(...rows.flat().map(l => l.rightEdge));
  const instructions = parseContentStream(contentBytes);
  for (const row of rows) {
    const rightmost = [...row].sort((a, b) => b.rightEdge - a.rightEdge)[0];
    const run = rightmost.runs[0];
    if (!run) continue;
    const fs = visualFontSize(run);
    const x = tableRight + Math.max(fs * 1.5, 12);
    const y = rightmost.baseline;
    const color = run.fillColor ?? [0, 0, 0];
    instructions.push(
      op('q'),
      op('BT'),
      op('rg', [new PDFNumber(color[0]), new PDFNumber(color[1]), new PDFNumber(color[2])]),
      op('Tf', [new PDFName(run.fontName.replace(/^\//, '')), new PDFNumber(run.fontSize || fs)]),
      op('Tm', [
        new PDFNumber(1), new PDFNumber(0), new PDFNumber(0), new PDFNumber(1),
        new PDFNumber(x), new PDFNumber(y),
      ]),
      // A visible, editable placeholder: a blank cell gave no feedback at all.
      op('Tj', [new PDFString(NEW_COLUMN_PLACEHOLDER)]),
      op('ET'),
      op('Q'),
    );
  }
  return compileInstructions(instructions);
}

/** Move the text objects of the given lines vertically by dy (user space). */
function shiftLinesY(contentBytes: Uint8Array, lines: TextLine[], dy: number): Uint8Array {
  if (lines.length === 0 || dy === 0) return contentBytes;
  const instructions = parseContentStream(contentBytes);
  const done = new Set<number>();
  for (const line of lines) {
    for (const run of line.runs) {
      const indices = run.sourceInstructionIndices ?? [];
      if (indices.length === 0) continue;
      const range = findBtEtRange(instructions, Math.min(...indices));
      if (!range || done.has(range.bt)) continue;
      done.add(range.bt);
      const ctm = ctmAt(instructions, range.bt);
      const scaleY = Math.abs(ctm[3]) > 1e-6 ? ctm[3] : 1;
      // Only the first positioning operator is absolute for the object;
      // later Td/T* are relative and move with it.
      for (let i = range.bt + 1; i < range.et; i++) {
        const inst = instructions[i];
        if (inst.operator === 'Tm' && inst.operands.length >= 6) {
          const f = inst.operands[5];
          if (f instanceof PDFNumber) inst.operands[5] = new PDFNumber(f.value + dy / scaleY);
          break;
        }
        if ((inst.operator === 'Td' || inst.operator === 'TD') && inst.operands.length >= 2) {
          const y = inst.operands[1];
          if (y instanceof PDFNumber) inst.operands[1] = new PDFNumber(y.value + dy / scaleY);
          break;
        }
      }
    }
  }
  return compileInstructions(instructions);
}

type Matrix6 = [number, number, number, number, number, number];

/** Current transformation matrix in effect just before instruction `index`. */
function ctmAt(instructions: CSInstruction[], index: number): Matrix6 {
  const num = (o: unknown) => (o instanceof PDFNumber ? o.value : 0);
  let ctm: Matrix6 = [1, 0, 0, 1, 0, 0];
  const stack: Matrix6[] = [];
  for (let i = 0; i < index && i < instructions.length; i++) {
    const inst = instructions[i];
    if (inst.operator === 'q') stack.push(ctm);
    else if (inst.operator === 'Q') ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (inst.operator === 'cm' && inst.operands.length >= 6) {
      const [a, b, c, d, e, f] = inst.operands.map(num);
      const [A, B, C, D, E, F] = ctm;
      // m × ctm (PDF row-vector convention)
      ctm = [
        a * A + b * C, a * B + b * D,
        c * A + d * C, c * B + d * D,
        e * A + f * C + E, e * B + f * D + F,
      ];
    }
  }
  return ctm;
}

function cloneInstruction(inst: CSInstruction): CSInstruction {
  return {
    operator: inst.operator,
    operands: inst.operands.map(o => o),
    offset: 0,
  };
}

function shiftInstructionsY(instructions: CSInstruction[], dy: number): void {
  for (const inst of instructions) {
    if (inst.operator === 'Tm' && inst.operands.length >= 6) {
      const f = inst.operands[5];
      if (f instanceof PDFNumber) inst.operands[5] = new PDFNumber(f.value + dy);
    } else if ((inst.operator === 'Td' || inst.operator === 'TD') && inst.operands.length >= 2) {
      const y = inst.operands[1];
      if (y instanceof PDFNumber) inst.operands[1] = new PDFNumber(y.value + dy);
    } else if ((inst.operator === 'm' || inst.operator === 'l') && inst.operands.length >= 2) {
      const y = inst.operands[1];
      if (y instanceof PDFNumber) inst.operands[1] = new PDFNumber(y.value + dy);
    }
  }
}

