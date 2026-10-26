import { createId } from '../../utils/id.js';
import type { BoundingBox } from '../common/geometry.js';
import type { LayoutBlock, LayoutRegion } from '../layout/types.js';
import type { RawCharacter, RawPage } from '../parser/raw-model.js';
import type {
  Character,
  Run,
  StyleCandidate,
  TextAlignment,
  Word,
  WritingDirection,
} from './types.js';

export interface ReconstructedText {
  runs: Run[];
  words: Word[];
  characters: Character[];
  plainText: string;
}

/**
 * Characters → Words → Runs.
 * Preserves source attributes; does not infer new styles.
 */
export function reconstructText(input: {
  region: LayoutRegion;
  blocks: LayoutBlock[];
  rawPage: RawPage | undefined;
  pageIndex: number;
  sectionId: string;
  parentBlockId: string;
  readingOrderBase: number;
  alignment?: TextAlignment;
}): ReconstructedText {
  const { region, blocks, rawPage, pageIndex, sectionId, parentBlockId, readingOrderBase } =
    input;

  const charById = new Map((rawPage?.characters ?? []).map((c) => [c.id, c]));
  const sourceIds = blocks.flatMap((b) => b.sourceObjectIds);
  const rawChars: RawCharacter[] = [];

  for (const id of sourceIds) {
    const c = charById.get(id);
    if (c) rawChars.push(c);
  }

  // Fallback: synthesize from layout block text when raw chars missing
  if (rawChars.length === 0) {
    return synthesizeFromLayoutText({
      blocks,
      pageIndex,
      sectionId,
      parentBlockId,
      readingOrderBase,
      writingDirection: region.writingDirection,
      bbox: region.bbox,
    });
  }

  // Sort reading-ish: top-to-bottom then left-to-right (PDF y-up) — but never
  // reorder characters relative to each other within the same original
  // text-showing run (RawCharacter.parentId). A run's glyphs are always
  // painted strictly left-to-right; re-sorting individual characters by raw
  // float x (even with an epsilon) is unsafe because a whole run's computed
  // position can drift by more than a few points (e.g. bold glyph-width
  // mismatches), which flips characters mid-word and produces interleaved
  // garbage like "Architected" + "backend" -> "Architectebdackend". Instead,
  // group into contiguous runs (order preserved verbatim inside each run) and
  // only sort at the run level.
  const sorted = orderCharsRunAware(rawChars);

  // Layout clustering often omits space glyphs from sourceObjectIds — re-insert
  // spaces using the SAME break rules as layout clusterWords (gap / style / line),
  // which already joins words with ' '. Do NOT break merely because parentId
  // changes — many PDFs emit one glyph per Tj, and that letter-spaces everything.
  const withSpaces: RawCharacter[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i]!;
    if (i > 0) {
      const prev = sorted[i - 1]!;
      const fs = Math.max(prev.fontSize, c.fontSize, 1);
      const sameLine = Math.abs(c.bbox.y - prev.bbox.y) <= fs * 0.35;
      const gap = c.bbox.x - (prev.bbox.x + prev.bbox.width);
      // Space glyphs are often dropped from layout sourceObjectIds; the leftover
      // gap is typically ~0.25–0.35em. Use 0.2em so we recover those without
      // treating near-zero inter-letter kerning as word breaks.
      const threshold = fs * 0.2;
      const fontOk =
        prev.fontName === c.fontName &&
        Math.abs(prev.fontSize - c.fontSize) < 0.75 &&
        prev.fontWeight === c.fontWeight &&
        prev.italic === c.italic;
      if (prev.unicode !== ' ' && c.unicode !== ' ' && prev.unicode !== '\n' && c.unicode !== '\n') {
        if (!sameLine) {
          withSpaces.push({
            ...prev,
            id: `${prev.id}_nl`,
            unicode: '\n',
            bbox: {
              x: prev.bbox.x + prev.bbox.width,
              y: prev.bbox.y,
              width: 0,
              height: prev.bbox.height,
            },
            glyphId: 10,
          });
        } else if (
          (gap > threshold || !fontOk) &&
          // Style/gap breaks before punctuation create "Excel ," / "risk ." artifacts
          // (bold keywords often change fontWeight right before , or .)
          !/^[,.;:!?\u2013\u2014)\]}%]/.test(c.unicode) &&
          !/^[(\[{]/.test(prev.unicode)
        ) {
          withSpaces.push({
            ...prev,
            id: `${prev.id}_space`,
            unicode: ' ',
            bbox: {
              x: prev.bbox.x + prev.bbox.width,
              y: prev.bbox.y,
              width: Math.max(gap, 0),
              height: prev.bbox.height,
            },
            glyphId: 32,
          });
        }
      }
    }
    withSpaces.push(c);
  }

  const characters: Character[] = withSpaces.map((c, i) => ({
    id: createId('ch'),
    parentId: parentBlockId,
    childIds: [],
    previousId: null,
    nextId: null,
    pageIndex,
    sectionId,
    readingOrderIndex: readingOrderBase + i,
    logicalOrderIndex: readingOrderBase + i,
    bbox: { ...c.bbox },
    styleCandidates: [],
    unicode: c.unicode,
    glyphId: c.glyphId,
    fontName: c.fontName,
    fontSize: c.fontSize,
    fontWeight: c.fontWeight,
    bold: c.fontWeight >= 700,
    italic: c.italic,
    color: colorToHex(c.fillColor),
    characterSpacing: c.characterSpacing,
    wordSpacing: c.wordSpacing,
    writingDirection: c.writingDirection,
    rotation: c.rotation,
    sourceObjectId: c.id,
  }));

  linkLinear(characters);

  const words = groupWords(characters, pageIndex, sectionId, parentBlockId, readingOrderBase);
  const runs = groupRuns(characters, words, pageIndex, sectionId, parentBlockId, readingOrderBase);

  // Attach word/run linkage
  for (const run of runs) {
    run.wordIds = words.filter((w) => w.parentId === run.id || run.characterIds.includes(w.characterIds[0] ?? '')).map((w) => w.id);
  }
  // Fix word → run ownership properly
  for (const word of words) {
    const firstCh = characters.find((c) => c.id === word.characterIds[0]);
    const run = runs.find((r) => firstCh && r.characterIds.includes(firstCh.id));
    word.runId = run?.id ?? null;
    word.parentId = run?.id ?? parentBlockId;
    if (run && !run.wordIds.includes(word.id)) run.wordIds.push(word.id);
  }

  return {
    runs,
    words,
    characters,
    plainText: characters.map((c) => c.unicode).join(''),
  };
}

function orderCharsRunAware(chars: RawCharacter[]): RawCharacter[] {
  interface CharRun {
    chars: RawCharacter[];
    order: number;
    y: number;
  }

  const runs: CharRun[] = [];
  let current: RawCharacter[] = [];
  let currentRunKey: string | null | undefined = undefined;

  const flushRun = () => {
    if (current.length === 0) return;
    const first = current[0]!;
    runs.push({
      chars: current,
      order: first.zIndex,
      y: first.bbox.y,
    });
    current = [];
  };

  for (const c of chars) {
    const key = c.parentId ?? c.id;
    if (current.length > 0 && key === currentRunKey) {
      current.push(c);
    } else {
      flushRun();
      current = [c];
      currentRunKey = key;
    }
  }
  flushRun();

  // Runs sharing a line keep their original extraction order; x is never
  // used to reorder (see orderCharactersRunAware in layout/clustering.ts for
  // full rationale — glyph-width drift can be arbitrarily large and must not
  // silently flip run/character order).
  runs.sort((A, B) => {
    const dy = B.y - A.y;
    const fontSize = Math.max(A.chars[0]!.fontSize, B.chars[0]!.fontSize, 1);
    if (Math.abs(dy) > fontSize * 0.3) return dy;
    return A.order - B.order;
  });

  return runs.flatMap((r) => r.chars);
}

function synthesizeFromLayoutText(input: {
  blocks: LayoutBlock[];
  pageIndex: number;
  sectionId: string;
  parentBlockId: string;
  readingOrderBase: number;
  writingDirection: WritingDirection;
  bbox: BoundingBox;
}): ReconstructedText {
  const text = input.blocks
    .map((b) => b.text ?? '')
    .filter(Boolean)
    .join('\n');

  const style = input.blocks.find((b) => b.style)?.style;
  const characters: Character[] = [];
  let i = 0;
  let prevChar = '';
  for (const raw of text) {
    // A layout line break is a soft wrap: keep the words apart.
    const ch = raw === '\n' ? ' ' : raw;
    if (raw === '\n' && (prevChar === '' || /\s/.test(prevChar))) continue;
    prevChar = ch;
    characters.push({
      id: createId('ch'),
      parentId: input.parentBlockId,
      childIds: [],
      previousId: null,
      nextId: null,
      pageIndex: input.pageIndex,
      sectionId: input.sectionId,
      readingOrderIndex: input.readingOrderBase + i,
      logicalOrderIndex: input.readingOrderBase + i,
      bbox: input.bbox,
      styleCandidates: [],
      unicode: ch,
      fontName: style?.fontName,
      fontSize: style?.fontSize,
      fontWeight: style?.fontWeight,
      bold: (style?.fontWeight ?? 400) >= 700,
      italic: /italic|oblique/i.test(style?.fontName ?? ''),
      writingDirection: input.writingDirection,
    });
    i++;
  }
  linkLinear(characters);
  const words = groupWords(
    characters,
    input.pageIndex,
    input.sectionId,
    input.parentBlockId,
    input.readingOrderBase,
  );
  const runs = groupRuns(
    characters,
    words,
    input.pageIndex,
    input.sectionId,
    input.parentBlockId,
    input.readingOrderBase,
  );
  for (const word of words) {
    const firstCh = characters.find((c) => c.id === word.characterIds[0]);
    const run = runs.find((r) => firstCh && r.characterIds.includes(firstCh.id));
    word.runId = run?.id ?? null;
    word.parentId = run?.id ?? input.parentBlockId;
    if (run && !run.wordIds.includes(word.id)) run.wordIds.push(word.id);
  }
  return { runs, words, characters, plainText: text.replace(/\n/g, ' ') };
}

function groupWords(
  characters: Character[],
  pageIndex: number,
  sectionId: string,
  parentBlockId: string,
  base: number,
): Word[] {
  const words: Word[] = [];
  let current: Character[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const id = createId('word');
    const word: Word = {
      id,
      parentId: parentBlockId,
      childIds: current.map((c) => c.id),
      previousId: null,
      nextId: null,
      pageIndex,
      sectionId,
      readingOrderIndex: base + words.length,
      logicalOrderIndex: base + words.length,
      bbox: unionBBox(current.map((c) => c.bbox).filter(Boolean) as BoundingBox[]),
      styleCandidates: [],
      text: current.map((c) => c.unicode).join(''),
      characterIds: current.map((c) => c.id),
      runId: null,
    };
    for (const c of current) c.parentId = id;
    words.push(word);
    current = [];
  };

  for (const ch of characters) {
    if (ch.unicode === ' ' || ch.unicode === '\t') {
      flush();
      continue;
    }
    if (current.length === 0) {
      current.push(ch);
      continue;
    }
    const prev = current[current.length - 1]!;
    const gap =
      ch.bbox && prev.bbox
        ? ch.bbox.x - (prev.bbox.x + prev.bbox.width)
        : 0;
    const threshold = (prev.fontSize ?? 12) * 0.4;
    const sameStyle =
      prev.fontName === ch.fontName &&
      Math.abs((prev.fontSize ?? 0) - (ch.fontSize ?? 0)) < 0.5;

    if (gap > threshold || !sameStyle || onNewLine(prev, ch)) flush();
    current.push(ch);
  }
  flush();
  linkLinear(words);
  return words;
}

function groupRuns(
  characters: Character[],
  _words: Word[],
  pageIndex: number,
  sectionId: string,
  parentBlockId: string,
  base: number,
): Run[] {
  const runs: Run[] = [];
  let current: Character[] = [];

  const styleKey = (c: Character) =>
    [
      c.fontName ?? '',
      c.fontSize ?? 0,
      c.fontWeight ?? 400,
      c.bold ? 1 : 0,
      c.italic ? 1 : 0,
      c.color ?? '',
    ].join('|');

  const flush = () => {
    if (current.length === 0) return;
    const first = current[0]!;
    const id = createId('run');
    const run: Run = {
      id,
      parentId: parentBlockId,
      childIds: current.map((c) => c.id),
      previousId: null,
      nextId: null,
      pageIndex,
      sectionId,
      readingOrderIndex: base + runs.length,
      logicalOrderIndex: base + runs.length,
      bbox: unionBBox(current.map((c) => c.bbox).filter(Boolean) as BoundingBox[]),
      styleCandidates: [],
      text: current.map((c) => c.unicode).join(''),
      bold: first.bold,
      italic: first.italic,
      fontName: first.fontName,
      fontSize: first.fontSize,
      fontWeight: first.fontWeight,
      color: first.color,
      characterSpacing: first.characterSpacing,
      wordSpacing: first.wordSpacing,
      writingDirection: first.writingDirection,
      rotation: first.rotation,
      wordIds: [],
      characterIds: current.map((c) => c.id),
    };
    runs.push(run);
    current = [];
  };

  for (const ch of characters) {
    if (current.length === 0) {
      current.push(ch);
      continue;
    }
    if (styleKey(current[0]!) === styleKey(ch) && !onNewLine(current[current.length - 1]!, ch)) {
      current.push(ch);
    } else {
      flush();
      current.push(ch);
    }
  }
  flush();
  linkLinear(runs);
  return runs;
}

/** True when `next` sits on a different baseline from `prev` (a line wrap). */
function onNewLine(prev: Character, next: Character): boolean {
  if (!prev.bbox || !next.bbox) return false;
  const size = Math.max(prev.fontSize ?? 0, next.fontSize ?? 0, prev.bbox.height, 1);
  return Math.abs(prev.bbox.y - next.bbox.y) > size * 0.5;
}

function linkLinear<T extends { id: string; previousId: string | null; nextId: string | null }>(
  nodes: T[],
): void {
  for (let i = 0; i < nodes.length; i++) {
    nodes[i]!.previousId = i > 0 ? nodes[i - 1]!.id : null;
    nodes[i]!.nextId = i < nodes.length - 1 ? nodes[i + 1]!.id : null;
  }
}

function unionBBox(boxes: BoundingBox[]): BoundingBox | undefined {
  if (boxes.length === 0) return undefined;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function colorToHex(
  color: RawCharacter['fillColor'],
): string | undefined {
  if (!color) return undefined;
  if (color.space === 'DeviceGray') {
    const g = Math.round((color.values[0] ?? 0) * 255);
    return `#${g.toString(16).padStart(2, '0').repeat(3)}`;
  }
  if (color.space === 'DeviceRGB') {
    const [r, g, b] = color.values.map((v) => Math.round(v * 255));
    return `#${[r, g, b].map((n) => (n ?? 0).toString(16).padStart(2, '0')).join('')}`;
  }
  return undefined;
}

/** Map layout region kind → style candidates (not final classification). */
export function candidatesForRegion(kind: LayoutRegion['kind']): StyleCandidate[] {
  switch (kind) {
    case 'title':
      return ['Possible Title', 'Possible Heading'];
    case 'heading':
      return ['Possible Heading'];
    case 'caption':
      return ['Possible Caption'];
    case 'text_block':
      return [];
    default:
      return [];
  }
}
