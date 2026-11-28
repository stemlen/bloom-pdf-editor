/**
 * Text search over a page's text runs, including words split across runs.
 *
 * PDFs often draw one word with several text-showing operators: Devanagari conjuncts and
 * matras go out glyph cluster by glyph cluster, and some producers draw a capital in its
 * own run ("M" + "eeting"). Searching run by run misses all of those. Runs that follow each
 * other in the content stream on the same baseline, with no visible gap between them, are
 * joined into a chain; matches are found in the chain text and mapped back to the runs.
 */

import type { TextRun } from '../content/interpreter';

export interface TextChainSegment {
  run: TextRun;
  /** Character range of `run.text` inside the chain text. */
  startIndex: number;
  endIndex: number;
}

export interface TextChain {
  text: string;
  segments: TextChainSegment[];
}

export interface TextMatch {
  chain: TextChain;
  /** Character range in `chain.text`. */
  start: number;
  end: number;
}

export interface TextMatchBounds {
  /** Left edge, baseline and size in PDF user space. */
  x: number;
  y: number;
  width: number;
  height: number;
}

function runSize(run: TextRun): number {
  return run.fontSize || run.glyphs?.[0]?.fontSize || 12;
}

/**
 * Same baseline, and `next` starts where the chain so far ends. `chainRight` is the chain's
 * right edge rather than `prev`'s: a zero-width matra is drawn inside the glyph before it.
 */
function continuesChain(prev: TextRun, chainRight: number, next: TextRun): boolean {
  if (!prev.text || !next.text) return false;
  const fs = Math.max(runSize(prev), runSize(next));
  if (Math.abs(prev.y - next.y) > fs * 0.2) return false;
  const gap = next.x - chainRight;
  return gap <= fs * 0.15 && gap >= -fs;
}

/** Groups runs (in content-stream order) into chains of visually continuous text. */
export function buildTextChains(runs: TextRun[]): TextChain[] {
  const chains: TextChain[] = [];
  let current: TextChain | null = null;
  let prev: TextRun | null = null;
  let right = -Infinity;
  for (const run of runs) {
    if (!current || !prev || !continuesChain(prev, right, run)) {
      current = { text: '', segments: [] };
      chains.push(current);
      right = -Infinity;
    }
    right = Math.max(right, run.x + run.width);
    current.segments.push({ run, startIndex: current.text.length, endIndex: current.text.length + run.text.length });
    current.text += run.text;
    prev = run;
  }
  return chains;
}

/**
 * Case folding that keeps string length, so indices in the folded text are indices in the
 * original (`'İ'.toLowerCase()` is two code units and would shift every later match).
 */
function foldCase(text: string): string {
  let out = '';
  for (const ch of text) {
    const lower = ch.toLowerCase();
    out += lower.length === ch.length ? lower : ch;
  }
  return out;
}

/** Every non-overlapping occurrence of `query` on the page, in content-stream order. */
export function findTextMatches(runs: TextRun[], query: string, caseSensitive = false): TextMatch[] {
  if (!query) return [];
  const needle = caseSensitive ? query : foldCase(query);
  const matches: TextMatch[] = [];
  for (const chain of buildTextChains(runs)) {
    const hay = caseSensitive ? chain.text : foldCase(chain.text);
    let idx = 0;
    while ((idx = hay.indexOf(needle, idx)) !== -1) {
      matches.push({ chain, start: idx, end: idx + needle.length });
      idx += needle.length;
    }
  }
  return matches;
}

/** Horizontal extent of characters [from, to) of one run, in PDF user space. */
function runCharSpan(run: TextRun, from: number, to: number): { left: number; right: number } {
  const glyphs = run.glyphs ?? [];
  // A glyph may stand for several characters (ligatures, Indic clusters): walk the glyphs'
  // Unicode and share each glyph's advance among its characters.
  const unicodeLength = glyphs.reduce((n, g) => n + (g.unicode?.length ?? 0), 0);
  if (glyphs.length > 0 && unicodeLength === run.text.length) {
    let left = Infinity;
    let right = -Infinity;
    let pos = 0;
    for (const g of glyphs) {
      const n = g.unicode?.length ?? 0;
      if (n > 0 && pos < to && pos + n > from) {
        const per = g.width / n;
        left = Math.min(left, g.x + (Math.max(from, pos) - pos) * per);
        right = Math.max(right, g.x + (Math.min(to, pos + n) - pos) * per);
      }
      pos += n;
    }
    if (left <= right) return { left, right };
  }
  const per = run.text.length > 0 ? run.width / run.text.length : 0;
  return { left: run.x + from * per, right: run.x + to * per };
}

/** Bounding box of a match, covering every run it touches. */
export function textMatchBounds(match: TextMatch): TextMatchBounds {
  let left = Infinity;
  let right = -Infinity;
  let y = Infinity;
  let height = 0;
  for (const seg of match.chain.segments) {
    const from = Math.max(match.start, seg.startIndex);
    const to = Math.min(match.end, seg.endIndex);
    if (from >= to) continue;
    const span = runCharSpan(seg.run, from - seg.startIndex, to - seg.startIndex);
    left = Math.min(left, span.left);
    right = Math.max(right, span.right);
    y = Math.min(y, seg.run.y);
    height = Math.max(height, seg.run.height || runSize(seg.run));
  }
  return { x: left, y, width: right - left, height };
}

/**
 * New text for each run touched by `matches` (all from one chain). The whole replacement
 * goes to the run where its match starts; the rest of the match is removed from the runs
 * it spilled into, so the text reads correctly whatever the run boundaries were.
 */
export function replaceInChainRuns(
  chain: TextChain,
  matches: TextMatch[],
  replacement: string,
): { run: TextRun; newText: string }[] {
  const edits: { run: TextRun; newText: string }[] = [];
  for (const seg of chain.segments) {
    let text = '';
    for (let i = seg.startIndex; i < seg.endIndex; i++) {
      const m = matches.find((mm) => i >= mm.start && i < mm.end);
      if (!m) text += chain.text[i];
      else if (i === m.start) text += replacement;
    }
    if (text !== seg.run.text) edits.push({ run: seg.run, newText: text });
  }
  return edits;
}
