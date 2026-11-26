/**
 * Text reflow — redistribute edited line text across styled segments.
 *
 * When the user edits a full line (Word-style), we map the new text back
 * to the original styled runs (bold, regular, etc.) preserving font boundaries
 * where possible using caret-aware + prefix/suffix splitting.
 */

import type { SegmentEdit, StyledSegment, TextLine } from './types';
import { estimateTextWidth } from './metrics';

/** Split new line text across original styled segments. */
export function distributeTextToSegments(line: TextLine, newText: string): SegmentEdit[] {
  return distributeTextChangeToSegments(line, line.text, newText, newText.length);
}

/**
 * Caret-aware redistribute: put insertions/deletions into the segment under the caret
 * so live typing doesn't jump words into neighboring bold/regular runs.
 */
export function distributeTextChangeToSegments(
  line: TextLine,
  oldText: string,
  newText: string,
  caretAfter: number,
): SegmentEdit[] {
  if (newText === line.text && oldText === line.text) {
    return line.segments.map(s => ({ run: s.run, newText: s.text }));
  }

  if (line.segments.length === 1) {
    return [{ run: line.segments[0].run, newText }];
  }

  // 1) Exact segment prefix/suffix preservation (best for mixed bold/regular).
  const preserved = preserveSegmentBoundaries(line, newText);
  if (preserved) return preserved;

  // 2) Common-prefix/suffix edit attributed to the segment that owns the caret.
  const caretAware = distributeByCaret(line, oldText, newText, caretAfter);
  if (caretAware) return caretAware;

  // 3) Proportional split — NO word-boundary snapping (that steals words into
  // the wrong style run and looks like "typing elsewhere").
  return proportionalSplit(line, newText);
}

function distributeByCaret(
  line: TextLine,
  oldText: string,
  newText: string,
  caretAfter: number,
): SegmentEdit[] | null {
  const segs = line.segments;
  if (segs.length < 2) return null;

  let prefix = 0;
  const minLen = Math.min(oldText.length, newText.length);
  while (prefix < minLen && oldText[prefix] === newText[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix++;
  }

  // Never cut a grapheme / Indic cluster: a matra, virama-joined consonant or
  // ZWJ belongs with the character before it (कि → का changes the whole कि).
  while (prefix > 0 && continuesCluster(oldText, prefix)) prefix--;
  while (suffix > 0 && continuesCluster(oldText, oldText.length - suffix)) suffix--;

  const midNew = newText.slice(prefix, newText.length - suffix);
  const oldMidLen = oldText.length - prefix - suffix;

  // A replaced range spanning several segments (a word drawn as many runs, as
  // Chromium prints Hindi): rewrite only the segments it touches. Leaving it to
  // the proportional split re-encodes — and corrupts — every untouched run.
  const spanning = distributeSpanningChange(segs, prefix, oldText.length - suffix, midNew);
  if (spanning) return spanning.map(e => e.newText).join('') === newText ? spanning : null;

  // Prefer the segment that contained the edit point.
  const delta = newText.length - oldText.length;
  const caretBefore = Math.max(0, Math.min(oldText.length, caretAfter - delta));
  const editAt = Math.min(prefix, caretBefore);

  let activeIdx = -1;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (editAt >= seg.startIndex && editAt <= seg.endIndex) {
      activeIdx = i;
      break;
    }
  }
  if (activeIdx < 0) activeIdx = segs.length - 1;

  const edits: SegmentEdit[] = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (i !== activeIdx) {
      edits.push({ run: seg.run, newText: seg.text });
      continue;
    }
    const localStart = Math.max(0, prefix - seg.startIndex);
    const localOldEnd = Math.min(seg.text.length, localStart + oldMidLen);
    const head = seg.text.slice(0, localStart);
    const tail = seg.text.slice(localOldEnd);
    edits.push({ run: seg.run, newText: head + midNew + tail });
  }

  return edits.map(e => e.newText).join('') === newText ? edits : null;
}

/** True when the code unit at `i` must stay with the one before it. */
function continuesCluster(text: string, i: number): boolean {
  if (i <= 0 || i >= text.length) return false;
  const cur = text[i];
  const prev = text[i - 1];
  return /\p{M}/u.test(cur) || cur === '\u200D' || prev === '\u200D' || prev === '\u094D' ||
    // Low surrogate of a pair
    (cur >= '\uDC00' && cur <= '\uDFFF');
}

/**
 * Old range [start, end) covers more than one segment: the first touched
 * segment keeps its head and takes the new text, the last keeps its tail,
 * those in between are emptied, all others are left exactly as they were.
 * Returns null when the range lies within one segment.
 */
function distributeSpanningChange(
  segs: StyledSegment[],
  start: number,
  end: number,
  midNew: string,
): SegmentEdit[] | null {
  if (end <= start) return null;
  let first = -1;
  let last = -1;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].endIndex > start && segs[i].startIndex < end) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0 || first === last) return null;

  return segs.map((seg, i) => {
    if (i < first || i > last) return { run: seg.run, newText: seg.text };
    let text = '';
    if (i === first) text = seg.text.slice(0, start - seg.startIndex) + midNew;
    if (i === last) text += seg.text.slice(end - seg.startIndex);
    return { run: seg.run, newText: text };
  });
}

function proportionalSplit(line: TextLine, newText: string): SegmentEdit[] {
  const oldLen = Math.max(1, line.text.length);
  const edits: SegmentEdit[] = [];
  let pos = 0;

  for (let i = 0; i < line.segments.length; i++) {
    const seg = line.segments[i];
    let len: number;

    if (i === line.segments.length - 1) {
      len = newText.length - pos;
    } else {
      const ratio = Math.max(0, seg.text.length) / oldLen;
      len = Math.round(ratio * newText.length);
      const remaining = newText.length - pos;
      const remainingSegs = line.segments.length - i - 1;
      if (remaining - len < remainingSegs) {
        len = Math.max(0, remaining - remainingSegs);
      }
    }

    len = Math.max(0, Math.min(len, newText.length - pos));
    edits.push({ run: seg.run, newText: newText.substring(pos, pos + len) });
    pos += len;
  }

  if (pos < newText.length && edits.length > 0) {
    edits[edits.length - 1].newText += newText.substring(pos);
  }

  return edits;
}

/**
 * If newText shares the same segment prefix/suffix as the old line,
 * only rewrite the middle segment(s) — keeps bold/italic runs intact.
 */
function preserveSegmentBoundaries(line: TextLine, newText: string): SegmentEdit[] | null {
  const segs = line.segments;
  if (segs.length < 2) return null;

  let prefixLen = 0;
  let prefixText = '';
  for (let i = 0; i < segs.length; i++) {
    const next = prefixText + segs[i].text;
    if (!newText.startsWith(next)) break;
    prefixText = next;
    prefixLen = i + 1;
  }

  let suffixLen = 0;
  let suffixText = '';
  for (let i = segs.length - 1; i >= prefixLen; i--) {
    const next = segs[i].text + suffixText;
    if (!newText.endsWith(next)) break;
    if (prefixText.length + next.length > newText.length) break;
    suffixText = next;
    suffixLen = segs.length - i;
  }

  const middleCount = segs.length - prefixLen - suffixLen;
  if (middleCount !== 1) return null;
  if (prefixLen === 0 && suffixLen === 0) return null;

  const middleText = newText.slice(prefixText.length, newText.length - suffixText.length);
  const middleIdx = prefixLen;
  const edits: SegmentEdit[] = [];
  for (let i = 0; i < segs.length; i++) {
    if (i === middleIdx) edits.push({ run: segs[i].run, newText: middleText });
    else edits.push({ run: segs[i].run, newText: segs[i].text });
  }
  return edits;
}

/** Compute width delta after editing a line (for shifting trailing runs). */
export function computeLineWidthDelta(line: TextLine, edits: SegmentEdit[]): number {
  let oldWidth = 0;
  let newWidth = 0;

  for (let i = 0; i < line.segments.length; i++) {
    const seg = line.segments[i];
    oldWidth += estimateTextWidth(seg.text, seg.run);
    const edit = edits.find(e => e.run === seg.run);
    newWidth += estimateTextWidth(edit?.newText ?? seg.text, seg.run);
  }

  return newWidth - oldWidth;
}

/** Find which segment contains a character index in the line. */
export function segmentAtIndex(line: TextLine, charIndex: number): StyledSegment | null {
  for (let i = 0; i < line.segments.length; i++) {
    const seg = line.segments[i];
    if (charIndex >= seg.startIndex && charIndex < seg.endIndex) {
      return seg;
    }
  }
  if (charIndex === line.text.length && line.segments.length > 0) {
    return line.segments[line.segments.length - 1];
  }
  return null;
}
