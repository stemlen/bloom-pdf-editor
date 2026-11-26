import { bboxFromPoints, type BoundingBox } from '../common/geometry.js';
import { createId } from '../../utils/id.js';
import type {
  ILayoutSpatialIndex,
  IObjectClusterer,
  NormalizedChar,
  NormalizedImage,
  NormalizedShape,
} from './algorithms/types.js';
import type { ClusteredObject, LayoutBlock, LayoutStyleKey } from './types.js';

/**
 * Docstrum-lite clustering:
 * characters → words → lines → text_cluster blocks.
 * Images / vectors / annotations / forms become their own blocks.
 *
 * This is geometric clustering only — not paragraph reconstruction.
 */
export class ObjectClusterer implements IObjectClusterer {
  readonly name = 'ObjectClusterer';

  cluster(input: {
    pageIndex: number;
    characters: NormalizedChar[];
    images: NormalizedImage[];
    vectors: NormalizedShape[];
    annotations: NormalizedShape[];
    forms: NormalizedShape[];
    index: ILayoutSpatialIndex;
  }): { clusters: ClusteredObject[]; blocks: LayoutBlock[] } {
    const { pageIndex, characters, images, vectors, annotations, forms, index } = input;

    // Index characters for future queries
    let z = 0;
    for (const c of characters) {
      index.insert({
        id: c.id,
        type: 'character',
        bbox: c.bbox,
        fontName: c.fontName,
        fontSize: c.fontSize,
        fontWeight: c.fontWeight,
        styleKey: styleKeyOf(c),
        zIndex: z++,
      });
    }

    const words = clusterWords(characters, pageIndex);
    for (const w of words) {
      index.insert({
        id: w.id,
        type: 'word',
        bbox: w.bbox,
        fontName: w.style?.fontName,
        fontSize: w.style?.fontSize,
        fontWeight: w.style?.fontWeight,
        styleKey: w.style ? `${w.style.fontName}|${w.style.fontSize}|${w.style.fontWeight}` : undefined,
        zIndex: z++,
      });
    }

    const lines = clusterLines(words, pageIndex);
    for (const line of lines) {
      index.insert({
        id: line.id,
        type: 'line',
        bbox: line.bbox,
        fontName: line.style?.fontName,
        fontSize: line.style?.fontSize,
        fontWeight: line.style?.fontWeight,
        styleKey: line.style
          ? `${line.style.fontName}|${line.style.fontSize}|${line.style.fontWeight}`
          : undefined,
        zIndex: z++,
      });
    }

    const textClusters = clusterTextBlocks(lines, pageIndex);

    const shapeBlocks: ClusteredObject[] = [
      ...images.map((img) =>
        makeCluster('image', pageIndex, img.bbox, [img.id]),
      ),
      ...vectors.map((v) => makeCluster('vector', pageIndex, v.bbox, [v.id])),
      ...annotations.map((a) => makeCluster('annotation', pageIndex, a.bbox, [a.id])),
      ...forms.map((f) => makeCluster('form', pageIndex, f.bbox, [f.id])),
    ];

    for (const s of shapeBlocks) {
      index.insert({
        id: s.id,
        type: s.kind === 'image' ? 'image' : s.kind === 'vector' ? 'vector' : s.kind === 'form' ? 'form' : 'annotation',
        bbox: s.bbox,
        zIndex: z++,
      });
    }

    const clusters = [...words, ...lines, ...textClusters, ...shapeBlocks];
    const blocks: LayoutBlock[] = [...textClusters, ...shapeBlocks].map((c) => toBlock(c));

    // Also expose lines as blocks when no text clusters formed
    if (textClusters.length === 0 && lines.length > 0) {
      for (const line of lines) {
        blocks.push(toBlock({ ...line, kind: 'line' }));
      }
    }

    return { clusters, blocks };
  }
}

function styleKeyOf(c: NormalizedChar): string {
  return `${c.fontName}|${c.fontSize}|${c.fontWeight}`;
}

function makeCluster(
  kind: ClusteredObject['kind'],
  pageIndex: number,
  bbox: BoundingBox,
  sourceObjectIds: string[],
  text?: string,
  style?: LayoutStyleKey,
  baseline?: number,
): ClusteredObject {
  return {
    id: createId(kind),
    kind,
    bbox: { ...bbox },
    sourceObjectIds,
    text,
    style,
    baseline,
    pageIndex,
  };
}

function clusterWords(characters: NormalizedChar[], pageIndex: number): ClusteredObject[] {
  if (characters.length === 0) return [];

  const sorted = orderCharactersRunAware(characters);

  const words: ClusteredObject[] = [];
  let current: NormalizedChar[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const text = current.map((c) => c.unicode).join('');
    const bbox = unionBBoxes(current.map((c) => c.bbox));
    const style = majorityStyle(current);
    words.push(
      makeCluster(
        'word',
        pageIndex,
        bbox,
        current.map((c) => c.id),
        text,
        style,
        average(current.map((c) => c.baseline)),
      ),
    );
    current = [];
  };

  for (const ch of sorted) {
    if (current.length === 0) {
      current.push(ch);
      continue;
    }
    const prev = current[current.length - 1]!;
    const sameLine = Math.abs(ch.baseline - prev.baseline) <= Math.max(2, prev.fontSize * 0.25);
    const gap = ch.bbox.x - (prev.bbox.x + prev.bbox.width);
    const threshold = Math.max(prev.fontSize, ch.fontSize) * 0.35;
    // Touching glyphs stay one word across a font switch: subsetting producers
    // (e.g. Chrome's Type3 fonts) change fonts mid-word ("M" + "eeting").
    const fontOk =
      (prev.fontName === ch.fontName || gap <= Math.max(prev.fontSize, ch.fontSize) * 0.1) &&
      Math.abs(prev.fontSize - ch.fontSize) < 0.75;

    if (sameLine && gap <= threshold && fontOk && ch.unicode !== ' ') {
      current.push(ch);
    } else if (sameLine && ch.unicode === ' ') {
      // space ends word
      flush();
    } else {
      flush();
      if (ch.unicode !== ' ') current.push(ch);
    }
  }
  flush();
  return words;
}

/**
 * Order characters top-to-bottom / left-to-right WITHOUT ever reordering
 * characters relative to one another within the same original text-showing
 * run (Tj/TJ call), AND without reordering different runs that share a line
 * by x-position at all.
 *
 * Rationale: a run's glyphs are always painted strictly left-to-right by
 * construction (see content-extractor.ts). Runs on the *same visual line*
 * are, for virtually every real-world PDF, also already emitted in
 * left-to-right reading order in the content stream (text generators don't
 * jump backwards mid-line). Re-deriving left-to-right order from computed
 * float x — even with an epsilon tolerance — is unsafe: a run's x position
 * can drift by an arbitrarily large amount relative to its true position
 * (e.g. bold/embedded-font glyph-width table mismatches accumulating over a
 * whole word), which silently flips whole runs or individual characters and
 * produces interleaved garbage like "Architected" + "backend" ->
 * "Architectebdackend". No fixed epsilon can safely bound that error.
 *
 * So: x is used only to build words/lines (gap detection), never to reorder.
 * Only the vertical (baseline) position — which glyph-width errors do not
 * affect — is used to order distinct lines relative to each other. Runs
 * sharing a line always keep their original extraction order.
 */
function orderCharactersRunAware(characters: NormalizedChar[]): NormalizedChar[] {
  interface CharRun {
    chars: NormalizedChar[];
    order: number;
    baseline: number;
  }

  const runs: CharRun[] = [];
  let current: NormalizedChar[] = [];
  let currentRunKey: string | null | undefined | number = undefined;

  const flushRun = () => {
    if (current.length === 0) return;
    const first = current[0]!;
    runs.push({
      chars: current,
      order: first.sourceZIndex,
      baseline: first.baseline,
    });
    current = [];
  };

  for (const c of characters) {
    // Fall back to per-character grouping when sourceRunId is absent (e.g.
    // synthesized/OCR characters) — safe no-op, behaves like before per-char.
    const key = c.sourceRunId ?? c.id;
    if (current.length > 0 && key === currentRunKey) {
      current.push(c);
    } else {
      flushRun();
      current = [c];
      currentRunKey = key;
    }
  }
  flushRun();

  runs.sort((A, B) => {
    const dy = B.baseline - A.baseline; // higher baseline first (PDF y-up)
    const fontSize = Math.max(A.chars[0]!.fontSize, B.chars[0]!.fontSize, 1);
    if (Math.abs(dy) > fontSize * 0.3) return dy;
    return A.order - B.order; // same line: always preserve original stream order
  });

  return runs.flatMap((r) => r.chars);
}

function clusterLines(words: ClusteredObject[], pageIndex: number): ClusteredObject[] {
  if (words.length === 0) return [];

  // Same rationale as orderCharactersRunAware: words sharing a line keep
  // their original (already-correct) order; only baseline decides line
  // membership/ordering. Never reorder same-line words by x.
  const indexedWords = words.map((w, i) => ({ w, i }));
  indexedWords.sort((A, B) => {
    const a = A.w;
    const b = B.w;
    const dy = (b.baseline ?? b.bbox.y) - (a.baseline ?? a.bbox.y);
    const fontSize = Math.max(a.style?.fontSize ?? 12, b.style?.fontSize ?? 12, 1);
    if (Math.abs(dy) > fontSize * 0.3) return dy;
    return A.i - B.i;
  });
  const sorted = indexedWords.map((x) => x.w);

  const lines: ClusteredObject[] = [];
  let current: ClusteredObject[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const text = current.map((w) => w.text ?? '').join(' ');
    const bbox = unionBBoxes(current.map((w) => w.bbox));
    const style = current[0]?.style;
    lines.push(
      makeCluster(
        'line',
        pageIndex,
        bbox,
        current.flatMap((w) => w.sourceObjectIds),
        text,
        style,
        average(current.map((w) => w.baseline ?? w.bbox.y)),
      ),
    );
    current = [];
  };

  for (const word of sorted) {
    if (current.length === 0) {
      current.push(word);
      continue;
    }
    const prev = current[current.length - 1]!;
    const fontSize = prev.style?.fontSize ?? 12;
    const baselineTol = fontSize * 0.35;
    const sameBaseline =
      Math.abs((word.baseline ?? word.bbox.y) - (prev.baseline ?? prev.bbox.y)) <= baselineTol;
    const horizontalGap = word.bbox.x - (prev.bbox.x + prev.bbox.width);
    const maxGap = fontSize * 3;

    if (sameBaseline && horizontalGap <= maxGap) {
      current.push(word);
    } else {
      flush();
      current.push(word);
    }
  }
  flush();
  return lines;
}

function clusterTextBlocks(lines: ClusteredObject[], pageIndex: number): ClusteredObject[] {
  if (lines.length === 0) return [];

  // Process top-to-bottom (high y first)
  const sorted = [...lines].sort(
    (a, b) => (b.baseline ?? b.bbox.y) - (a.baseline ?? a.bbox.y),
  );

  const blocks: ClusteredObject[] = [];
  let current: ClusteredObject[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const text = current.map((l) => l.text ?? '').join('\n');
    const bbox = unionBBoxes(current.map((l) => l.bbox));
    const style = current[0]?.style;
    blocks.push(
      makeCluster(
        'text_cluster',
        pageIndex,
        bbox,
        current.flatMap((l) => l.sourceObjectIds),
        text,
        style,
        average(current.map((l) => l.baseline ?? l.bbox.y)),
      ),
    );
    current = [];
  };

  for (const line of sorted) {
    if (current.length === 0) {
      current.push(line);
      continue;
    }
    const prev = current[current.length - 1]!;
    const fontSize = prev.style?.fontSize ?? 12;
    // Vertical distance between baselines (prev is above in reading order)
    const vGap = (prev.baseline ?? prev.bbox.y) - ((line.baseline ?? line.bbox.y) + line.bbox.height);
    const xOverlap = horizontalOverlapRatio(prev.bbox, line.bbox);
    const sizeOk =
      !prev.style ||
      !line.style ||
      Math.abs(prev.style.fontSize - line.style.fontSize) <= fontSize * 0.35;

    if (vGap <= fontSize * 1.6 && xOverlap >= 0.2 && sizeOk) {
      current.push(line);
    } else {
      flush();
      current.push(line);
    }
  }
  flush();
  return blocks;
}

function toBlock(c: ClusteredObject): LayoutBlock {
  const area = Math.max(c.bbox.width * c.bbox.height, 1);
  const textLen = (c.text ?? '').replace(/\s/g, '').length;
  return {
    id: c.id,
    kind: c.kind,
    bbox: { ...c.bbox },
    parentId: null,
    childIds: [],
    readingOrderIndex: -1,
    confidence: 0.8,
    sourceObjectIds: [...c.sourceObjectIds],
    text: c.text,
    style: c.style,
    objectDensity: c.sourceObjectIds.length / area,
    textDensity: textLen / area,
  };
}

function majorityStyle(chars: NormalizedChar[]): LayoutStyleKey {
  const c = chars[0]!;
  return { fontName: c.fontName, fontSize: c.fontSize, fontWeight: c.fontWeight };
}

function unionBBoxes(boxes: BoundingBox[]): BoundingBox {
  return bboxFromPoints(
    boxes.flatMap((b) => [
      { x: b.x, y: b.y },
      { x: b.x + b.width, y: b.y + b.height },
    ]),
  );
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function horizontalOverlapRatio(a: BoundingBox, b: BoundingBox): number {
  const left = Math.max(a.x, b.x);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const overlap = Math.max(0, right - left);
  const minW = Math.max(Math.min(a.width, b.width), 1);
  return overlap / minW;
}
