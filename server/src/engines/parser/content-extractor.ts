import { IDENTITY_MATRIX, multiplyMatrix, type Matrix2D } from '../common/geometry.js';
import { createId } from '../../utils/id.js';
import { PdfLexer } from './lexer.js';
import { ObjectGraph } from './object-graph.js';
import {
  PdfArray,
  PdfDict,
  PdfName,
  PdfRef,
  PdfStream,
  type PdfPageInfo,
  type PdfPrimitive,
} from './pdf-objects.js';
import { resolve } from './document-parser.js';
import { decodeStream } from './filters.js';
import { PageSpatialIndex } from './spatial-index.js';
import { decodePdfTextString, decodeTextString, loadPageFonts, type LoadedFont } from './font-decode.js';
import type {
  ColorValue,
  PathCommand,
  RawAnnotation,
  RawCharacter,
  RawFont,
  RawForm,
  RawImage,
  RawPage,
  RawTextRun,
  RawVector,
} from './raw-model.js';

interface GraphicsState {
  ctm: Matrix2D;
  fillColor: ColorValue | null;
  strokeColor: ColorValue | null;
  lineWidth: number;
  lineCap: number;
  lineJoin: number;
  dash: number[];
  /** Resource font name (e.g. F1), not BaseFont. */
  fontResource: string;
  fontName: string;
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  leading: number;
  textMatrix: Matrix2D;
  textLineMatrix: Matrix2D;
  renderingMode: number;
  opacity: number;
}

/** An open marked-content sequence (BMC/BDC … EMC). */
interface MarkedContent {
  /** /ActualText replacing the glyphs painted inside the sequence (PDF 14.9.4). */
  actualText: string | null;
  /** Glyph boxes painted inside, in device space. */
  boxes: Array<{ x: number; y: number; x2: number; y2: number }>;
  /** Text state at the first glyph, for the replacement characters. */
  state: GraphicsState | null;
  tm: Matrix2D | null;
}

/** An inline dictionary operand (e.g. the property list of BDC). */
class InlineDict {
  constructor(readonly entries: Map<string, unknown>) {}
}

function defaultState(): GraphicsState {
  return {
    ctm: IDENTITY_MATRIX,
    fillColor: { space: 'DeviceGray', values: [0] },
    strokeColor: { space: 'DeviceGray', values: [0] },
    lineWidth: 1,
    lineCap: 0,
    lineJoin: 0,
    dash: [],
    fontResource: '',
    fontName: 'Unknown',
    fontSize: 12,
    charSpacing: 0,
    wordSpacing: 0,
    leading: 0,
    textMatrix: IDENTITY_MATRIX,
    textLineMatrix: IDENTITY_MATRIX,
    renderingMode: 0,
    opacity: 1,
  };
}

/**
 * Extract raw page objects from a decoded content stream.
 * No paragraph merging, no reading order — extraction only.
 */
export async function extractPageRaw(
  page: PdfPageInfo,
  objects: Map<string, PdfPrimitive>,
  content: Uint8Array,
  graph: ObjectGraph,
): Promise<RawPage> {
  const [x0, y0, x1, y1] = page.mediaBox;
  const width = Math.abs(x1 - x0);
  const height = Math.abs(y1 - y0);
  const pageId = createId('page');

  const characters: RawCharacter[] = [];
  const textRuns: RawTextRun[] = [];
  const images: RawImage[] = [];
  const vectors: RawVector[] = [];
  const fonts: RawFont[] = [];
  const spatial = new PageSpatialIndex();

  const stack: GraphicsState[] = [];
  let gs = defaultState();
  let z = 0;
  const path: PathCommand[] = [];

  const fontMap = await loadPageFonts(page.resources, objects, fonts);
  const xObjectMap = collectXObjects(page.resources, objects);

  const lexer = new PdfLexer(content);
  const operands: Array<number | string | PdfName | InlineDict | Array<number | string>> = [];

  const flushPath = (paint: RawVector['paint']) => {
    if (path.length === 0) return;
    const id = createId('vector');
    const pts = pathPoints(path);
    const xs = pts.map((p) => transform(gs.ctm, p.x, p.y));
    const bbox = boundsOf(xs);
    const vector: RawVector = {
      id,
      type: 'vector',
      parentId: pageId,
      childIds: [],
      pageIndex: page.index,
      bbox,
      transform: gs.ctm,
      zIndex: z++,
      pathCommands: [...path],
      strokeWidth: gs.lineWidth,
      strokeColor: gs.strokeColor,
      fillColor: gs.fillColor,
      dashPattern: [...gs.dash],
      joinStyle: gs.lineJoin,
      capStyle: gs.lineCap,
      opacity: gs.opacity,
      paint,
    };
    vectors.push(vector);
    graph.add(vector);
    spatial.insert({ id, type: 'vector', bbox, zIndex: vector.zIndex });
    path.length = 0;
  };

  const nextLine = () => {
    gs.textLineMatrix = multiplyMatrix([1, 0, 0, 1, 0, -gs.leading], gs.textLineMatrix);
    gs.textMatrix = gs.textLineMatrix;
  };

  const markedContent: MarkedContent[] = [];
  const properties = collectProperties(page.resources, objects);
  /** Outermost open ActualText sequence: it replaces everything painted inside it. */
  const actualTextSpan = () => markedContent.find((m) => m.actualText !== null);

  /** Emit an ActualText sequence's replacement text over the glyphs it covered. */
  const emitActualText = (span: MarkedContent) => {
    const text = [...(span.actualText ?? '')];
    if (text.length === 0 || span.boxes.length === 0 || !span.state || !span.tm) return;
    const minX = Math.min(...span.boxes.map((b) => b.x));
    const minY = Math.min(...span.boxes.map((b) => b.y));
    const maxX = Math.max(...span.boxes.map((b) => b.x2));
    const maxY = Math.max(...span.boxes.map((b) => b.y2));
    const st = span.state;
    const runId = createId('textRun');
    const charIds: string[] = [];
    const step = (maxX - minX) / text.length;
    text.forEach((ch, i) => {
      const bbox = { x: minX + step * i, y: minY, width: step, height: maxY - minY };
      const charId = createId('char');
      const character: RawCharacter = {
        id: charId,
        type: 'character',
        parentId: runId,
        childIds: [],
        pageIndex: page.index,
        bbox,
        transform: span.tm!,
        zIndex: z++,
        unicode: ch,
        glyphId: ch.codePointAt(0) ?? 0,
        width: bbox.width,
        height: bbox.height,
        rotation: Math.atan2(span.tm![1], span.tm![0]) * (180 / Math.PI),
        fontName: st.fontName,
        fontSize: st.fontSize,
        fontWeight: /bold/i.test(st.fontName) ? 700 : 400,
        italic: /italic|oblique/i.test(st.fontName),
        fillColor: st.fillColor,
        strokeColor: st.strokeColor,
        characterSpacing: st.charSpacing,
        wordSpacing: st.wordSpacing,
        renderingMode: st.renderingMode,
        writingDirection: 'ltr',
      };
      characters.push(character);
      charIds.push(charId);
      graph.add(character);
      spatial.insert({ id: charId, type: 'character', bbox, zIndex: character.zIndex });
    });
    const runBBox = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    const run: RawTextRun = {
      id: runId,
      type: 'textRun',
      parentId: pageId,
      childIds: charIds,
      pageIndex: page.index,
      bbox: runBBox,
      transform: span.tm,
      zIndex: z++,
      text: text.join(''),
      fontName: st.fontName,
      fontSize: st.fontSize,
      characterIds: charIds,
      fillColor: st.fillColor,
    };
    textRuns.push(run);
    graph.add(run);
    spatial.insert({ id: runId, type: 'textRun', bbox: runBBox, zIndex: run.zIndex });
  };

  const showText = (text: string) => {
    if (!text) return;
    const font: LoadedFont | undefined = fontMap.get(gs.fontResource);
    const glyphs = decodeTextString(text, font);
    if (glyphs.length === 0) return;

    // Inside an ActualText sequence the glyphs only move the pen and mark the
    // area; the sequence's text is emitted at EMC (shaped scripts such as
    // Devanagari carry their real text there, not in the font's ToUnicode).
    const span = actualTextSpan();
    if (span) {
      for (const glyph of glyphs) {
        const glyphWidth = (glyph.width1000 / 1000) * gs.fontSize;
        let advance = glyphWidth + gs.charSpacing;
        if (glyph.charCode === 32) advance += gs.wordSpacing;
        const tm = multiplyMatrix(gs.textMatrix, gs.ctm);
        const origin = transform(tm, 0, 0);
        const tip = transform(tm, glyphWidth, gs.fontSize);
        span.boxes.push({
          x: Math.min(origin.x, tip.x),
          y: Math.min(origin.y, tip.y),
          x2: Math.max(origin.x, tip.x),
          y2: Math.max(origin.y, tip.y),
        });
        if (!span.state) {
          span.state = structuredClone(gs);
          span.tm = tm;
        }
        gs.textMatrix = multiplyMatrix([1, 0, 0, 1, advance, 0], gs.textMatrix);
      }
      return;
    }

    const runId = createId('textRun');
    const charIds: string[] = [];
    const fontSize = gs.fontSize;
    let runText = '';

    for (const glyph of glyphs) {
      const glyphWidth = (glyph.width1000 / 1000) * fontSize;
      let advance = glyphWidth + gs.charSpacing;
      if (glyph.charCode === 32) advance += gs.wordSpacing;

      const tm = multiplyMatrix(gs.textMatrix, gs.ctm);
      const origin = transform(tm, 0, 0);
      const tip = transform(tm, glyphWidth, fontSize);
      const bbox = {
        x: Math.min(origin.x, tip.x),
        y: Math.min(origin.y, tip.y),
        width: Math.abs(tip.x - origin.x) || glyphWidth,
        height: Math.abs(tip.y - origin.y) || fontSize,
      };

      for (const ch of glyph.unicode) {
        const charId = createId('char');
        const character: RawCharacter = {
          id: charId,
          type: 'character',
          parentId: runId,
          childIds: [],
          pageIndex: page.index,
          bbox,
          transform: tm,
          zIndex: z++,
          unicode: ch,
          glyphId: glyph.charCode,
          width: bbox.width,
          height: bbox.height,
          rotation: Math.atan2(tm[1], tm[0]) * (180 / Math.PI),
          fontName: gs.fontName,
          fontSize,
          fontWeight: /bold/i.test(gs.fontName) ? 700 : 400,
          italic: /italic|oblique/i.test(gs.fontName),
          fillColor: gs.fillColor,
          strokeColor: gs.strokeColor,
          characterSpacing: gs.charSpacing,
          wordSpacing: gs.wordSpacing,
          renderingMode: gs.renderingMode,
          writingDirection: 'ltr',
        };
        characters.push(character);
        charIds.push(charId);
        graph.add(character);
        spatial.insert({ id: charId, type: 'character', bbox, zIndex: character.zIndex });
        runText += ch;
      }

      gs.textMatrix = multiplyMatrix([1, 0, 0, 1, advance, 0], gs.textMatrix);
    }
    if (charIds.length === 0) return; // only unmapped glyphs: nothing to read

    const runBBox = boundsOf(
      characters
        .filter((c) => charIds.includes(c.id))
        .map((c) => ({
          x: c.bbox.x,
          y: c.bbox.y,
          x2: c.bbox.x + c.bbox.width,
          y2: c.bbox.y + c.bbox.height,
        }))
        .flatMap((b) => [
          { x: b.x, y: b.y },
          { x: b.x2, y: b.y2 },
        ]),
    );

    const run: RawTextRun = {
      id: runId,
      type: 'textRun',
      parentId: pageId,
      childIds: charIds,
      pageIndex: page.index,
      bbox: runBBox,
      transform: multiplyMatrix(gs.textMatrix, gs.ctm),
      zIndex: z++,
      text: runText,
      fontName: gs.fontName,
      fontSize,
      characterIds: charIds,
      fillColor: gs.fillColor,
    };
    textRuns.push(run);
    graph.add(run);
    spatial.insert({ id: runId, type: 'textRun', bbox: runBBox, zIndex: run.zIndex });
  };

  while (true) {
    const tok = lexer.nextToken();
    if (tok.kind === 'eof') break;

    if (tok.kind === 'number') {
      operands.push(tok.value);
      continue;
    }
    if (tok.kind === 'string') {
      operands.push(tok.value);
      continue;
    }
    if (tok.kind === 'name') {
      operands.push(new PdfName(tok.value));
      continue;
    }
    if (tok.kind === 'dictStart') {
      operands.push(readInlineDict(lexer));
      continue;
    }
    if (tok.kind === 'arrayStart') {
      const arr: Array<number | string> = [];
      while (true) {
        const t = lexer.nextToken();
        if (t.kind === 'arrayEnd' || t.kind === 'eof') break;
        if (t.kind === 'number') arr.push(t.value);
        else if (t.kind === 'string') arr.push(t.value);
      }
      operands.push(arr);
      continue;
    }
    if (tok.kind !== 'word') {
      operands.length = 0;
      continue;
    }

    const op = tok.value;
    switch (op) {
      case 'q':
        stack.push(structuredClone(gs));
        break;
      case 'Q':
        gs = stack.pop() ?? defaultState();
        break;
      case 'cm': {
        const [a, b, c, d, e, f] = nums(operands, 6);
        // PDF 8.4.4: CTM' = M × CTM (the new matrix applies first).
        gs.ctm = multiplyMatrix([a, b, c, d, e, f], gs.ctm);
        break;
      }
      case 'w':
        gs.lineWidth = num(operands, 0);
        break;
      case 'J':
        gs.lineCap = num(operands, 0);
        break;
      case 'j':
        gs.lineJoin = num(operands, 0);
        break;
      case 'd': {
        const dash = operands.find((o) => Array.isArray(o)) as number[] | undefined;
        gs.dash = dash ?? [];
        break;
      }
      case 'rg':
      case 'RG': {
        const [r, g, b] = nums(operands, 3);
        const color: ColorValue = { space: 'DeviceRGB', values: [r, g, b] };
        if (op === 'rg') gs.fillColor = color;
        else gs.strokeColor = color;
        break;
      }
      case 'g':
      case 'G': {
        const [v] = nums(operands, 1);
        const color: ColorValue = { space: 'DeviceGray', values: [v] };
        if (op === 'g') gs.fillColor = color;
        else gs.strokeColor = color;
        break;
      }
      case 'k':
      case 'K': {
        const [c, m, y, k] = nums(operands, 4);
        const color: ColorValue = { space: 'DeviceCMYK', values: [c, m, y, k] };
        if (op === 'k') gs.fillColor = color;
        else gs.strokeColor = color;
        break;
      }
      case 'm': {
        const [x, y] = nums(operands, 2);
        path.push({ op: 'm', x, y });
        break;
      }
      case 'l': {
        const [x, y] = nums(operands, 2);
        path.push({ op: 'l', x, y });
        break;
      }
      case 'c': {
        const [x1, y1, x2, y2, x3, y3] = nums(operands, 6);
        path.push({ op: 'c', x1, y1, x2, y2, x3, y3 });
        break;
      }
      case 'v': {
        const [x2, y2, x3, y3] = nums(operands, 4);
        path.push({ op: 'v', x2, y2, x3, y3 });
        break;
      }
      case 'y': {
        const [x1, y1, x3, y3] = nums(operands, 4);
        path.push({ op: 'y', x1, y1, x3, y3 });
        break;
      }
      case 'h':
        path.push({ op: 'h' });
        break;
      case 're': {
        const [x, y, w, h] = nums(operands, 4);
        path.push({ op: 're', x, y, w, h });
        break;
      }
      case 'S':
        flushPath('stroke');
        break;
      case 's':
        path.push({ op: 'h' });
        flushPath('stroke');
        break;
      case 'f':
      case 'F':
      case 'f*':
        flushPath('fill');
        break;
      case 'B':
      case 'B*':
        flushPath('fillStroke');
        break;
      case 'n':
        path.length = 0;
        break;
      case 'W':
      case 'W*':
        flushPath('clip');
        break;
      case 'BT':
        gs.textMatrix = IDENTITY_MATRIX;
        gs.textLineMatrix = IDENTITY_MATRIX;
        break;
      case 'ET':
        break;
      case 'Td': {
        const [tx, ty] = nums(operands, 2);
        // PDF 9.4.2: Tlm' = [1 0 0 1 tx ty] × Tlm (offsets are in text space).
        gs.textLineMatrix = multiplyMatrix([1, 0, 0, 1, tx, ty], gs.textLineMatrix);
        gs.textMatrix = gs.textLineMatrix;
        break;
      }
      case 'TD': {
        const [tx, ty] = nums(operands, 2);
        gs.leading = -ty;
        gs.textLineMatrix = multiplyMatrix([1, 0, 0, 1, tx, ty], gs.textLineMatrix);
        gs.textMatrix = gs.textLineMatrix;
        break;
      }
      case 'Tm': {
        const [a, b, c, d, e, f] = nums(operands, 6);
        gs.textMatrix = [a, b, c, d, e, f];
        gs.textLineMatrix = gs.textMatrix;
        break;
      }
      case 'Tf': {
        const name = operands.find((o) => o instanceof PdfName) as PdfName | undefined;
        const size = [...operands].reverse().find((o) => typeof o === 'number') as number | undefined;
        if (name) {
          gs.fontResource = name.value;
          const loaded = fontMap.get(name.value);
          gs.fontName = loaded?.baseFont ?? name.value;
        }
        if (size != null) gs.fontSize = size;
        break;
      }
      case 'Tc':
        gs.charSpacing = num(operands, 0);
        break;
      case 'Tw':
        gs.wordSpacing = num(operands, 0);
        break;
      case 'TL':
        gs.leading = num(operands, 0);
        break;
      case 'T*':
        nextLine();
        break;
      case 'Tr':
        gs.renderingMode = num(operands, 0);
        break;
      case 'Tj':
      case "'":
      case '"': {
        if (op === '"') {
          const [aw, ac] = nums(operands, 2);
          gs.wordSpacing = aw;
          gs.charSpacing = ac;
        }
        // ' and " move to the next line before showing the string.
        if (op !== 'Tj') nextLine();
        const s = operands.find((o) => typeof o === 'string') as string | undefined;
        if (s) showText(s);
        break;
      }
      case 'TJ': {
        const arr = operands.find((o) => Array.isArray(o)) as Array<number | string> | undefined;
        if (arr) {
          for (const item of arr) {
            if (typeof item === 'string') {
              showText(item);
            } else if (typeof item === 'number') {
              const adjust = (-item / 1000) * gs.fontSize;
              gs.textMatrix = multiplyMatrix([1, 0, 0, 1, adjust, 0], gs.textMatrix);
            }
          }
        }
        break;
      }
      case 'BMC':
        markedContent.push({ actualText: null, boxes: [], state: null, tm: null });
        break;
      case 'BDC': {
        const props = operands[operands.length - 1];
        let actual: unknown = null;
        if (props instanceof InlineDict) actual = props.entries.get('ActualText');
        else if (props instanceof PdfName) {
          const dict = properties.get(props.value);
          actual = dict?.get('ActualText') ?? null;
        }
        markedContent.push({
          actualText: typeof actual === 'string' ? decodePdfTextString(actual) : null,
          boxes: [],
          state: null,
          tm: null,
        });
        break;
      }
      case 'EMC': {
        const span = markedContent.pop();
        // Nested sequences inside an ActualText one are covered by the outer text.
        if (span && span.actualText !== null && !actualTextSpan()) emitActualText(span);
        break;
      }
      case 'Do': {
        const name = operands.find((o) => o instanceof PdfName) as PdfName | undefined;
        if (name) {
          const xo = xObjectMap.get(name.value);
          if (xo) {
            const img = await extractImage(name.value, xo, page, gs, pageId, z++, graph, objects);
            if (img) {
              images.push(img);
              spatial.insert({
                id: img.id,
                type: 'image',
                bbox: img.bbox,
                zIndex: img.zIndex,
              });
            }
          }
        }
        break;
      }
      default:
        break;
    }
    operands.length = 0;
  }

  // A sequence left open at the end of the stream still covers its glyphs.
  const unclosed = actualTextSpan();
  if (unclosed) emitActualText(unclosed);

  // Annotations / forms from page dict
  const annotations = extractAnnotations(page, objects, pageId, graph, spatial);
  const forms = extractForms(annotations, pageId, graph, spatial);

  graph.add({
    id: pageId,
    type: 'page',
    parentId: null,
    childIds: [
      ...textRuns.map((t) => t.id),
      ...images.map((i) => i.id),
      ...vectors.map((v) => v.id),
      ...annotations.map((a) => a.id),
    ],
    pageIndex: page.index,
    bbox: { x: x0, y: y0, width, height },
    transform: IDENTITY_MATRIX,
    zIndex: 0,
  });

  return {
    id: pageId,
    index: page.index,
    width,
    height,
    rotation: page.rotate,
    boxes: {
      mediaBox: { x: x0, y: y0, width, height },
      cropBox: boxFrom(page.cropBox),
      bleedBox: null,
      trimBox: null,
      artBox: null,
    },
    resources: {},
    characters,
    textRuns,
    words: [], // Phase 2: no word merging (layout will do this)
    images,
    vectors,
    annotations,
    forms,
    fonts,
    spatialIndex: spatial,
  };
}

/** Read an inline `<< … >>` operand; nested dictionaries/arrays are skipped. */
function readInlineDict(lexer: PdfLexer): InlineDict {
  const entries = new Map<string, unknown>();
  let key: string | null = null;
  let depth = 0;
  for (;;) {
    const t = lexer.nextToken();
    if (t.kind === 'eof') break;
    if (t.kind === 'dictStart' || t.kind === 'arrayStart') {
      depth++;
      continue;
    }
    if (t.kind === 'dictEnd' || t.kind === 'arrayEnd') {
      if (depth === 0) break;
      depth--;
      if (depth === 0) key = null;
      continue;
    }
    if (depth > 0) continue;
    if (key === null) {
      if (t.kind === 'name') key = t.value;
      continue;
    }
    if (t.kind === 'string' || t.kind === 'number') entries.set(key, t.value);
    else if (t.kind === 'name') entries.set(key, new PdfName(t.value));
    key = null;
  }
  return new InlineDict(entries);
}

/** Named marked-content property lists (/Resources /Properties). */
function collectProperties(
  resources: PdfDict | null,
  objects: Map<string, PdfPrimitive>,
): Map<string, PdfDict> {
  const map = new Map<string, PdfDict>();
  if (!resources) return map;
  let props: PdfPrimitive = resources.get('Properties');
  if (props instanceof PdfRef) props = resolve(objects, props);
  if (!(props instanceof PdfDict)) return map;
  for (const [name, value] of props.entries()) {
    const obj = value instanceof PdfRef ? resolve(objects, value) : value;
    if (obj instanceof PdfDict) map.set(name, obj);
  }
  return map;
}

function collectXObjects(
  resources: PdfDict | null,
  objects: Map<string, PdfPrimitive>,
): Map<string, PdfStream | PdfDict> {
  const map = new Map<string, PdfStream | PdfDict>();
  if (!resources) return map;
  let xo = resources.getDict('XObject');
  const xoRef = resources.getRef('XObject');
  if (!xo && xoRef) {
    const resolved = resolve(objects, xoRef);
    if (resolved instanceof PdfDict) xo = resolved;
  }
  if (!xo) return map;

  for (const [name, value] of xo.entries()) {
    let obj = value;
    if (value instanceof PdfRef) obj = resolve(objects, value);
    if (obj instanceof PdfStream || obj instanceof PdfDict) {
      map.set(name, obj);
    }
  }
  return map;
}

async function extractImage(
  resourceName: string,
  xo: PdfStream | PdfDict,
  page: PdfPageInfo,
  gs: GraphicsState,
  pageId: string,
  zIndex: number,
  graph: ObjectGraph,
  _objects: Map<string, PdfPrimitive>,
): Promise<RawImage | null> {
  const dict = xo instanceof PdfStream ? xo.dict : xo;
  if (dict.getName('Subtype') !== 'Image') return null;

  const widthPx = dict.getNumber('Width') ?? 0;
  const heightPx = dict.getNumber('Height') ?? 0;
  const colorSpace = dict.getName('ColorSpace');
  const filter = dict.get('Filter');
  let compression: string | null = null;
  if (filter instanceof PdfName) compression = filter.value;
  else if (filter instanceof PdfArray && filter.items[0] instanceof PdfName) {
    compression = filter.items[0].value;
  }

  // Image placed with current CTM mapping unit square
  const p0 = transform(gs.ctm, 0, 0);
  const p1 = transform(gs.ctm, 1, 1);
  const bbox = {
    x: Math.min(p0.x, p1.x),
    y: Math.min(p0.y, p1.y),
    width: Math.abs(p1.x - p0.x),
    height: Math.abs(p1.y - p0.y),
  };

  let data: Uint8Array | undefined;
  if (xo instanceof PdfStream) {
    try {
      data = await decodeStream(xo.rawBytes, xo.dict);
    } catch {
      data = xo.rawBytes;
    }
  }

  const image: RawImage = {
    id: createId('image'),
    type: 'image',
    parentId: pageId,
    childIds: [],
    pageIndex: page.index,
    bbox,
    transform: gs.ctm,
    zIndex,
    imageType: compression ?? 'raw',
    widthPx,
    heightPx,
    dpi: bbox.height > 0 ? (heightPx * 72) / bbox.height : 72,
    compression,
    colorSpace,
    hasTransparency: dict.has('SMask') || dict.has('Mask'),
    rotation: Math.atan2(gs.ctm[1], gs.ctm[0]) * (180 / Math.PI),
    resourceName,
    data,
  };
  graph.add(image);
  return image;
}

function extractAnnotations(
  page: PdfPageInfo,
  objects: Map<string, PdfPrimitive>,
  pageId: string,
  graph: ObjectGraph,
  spatial: PageSpatialIndex,
): RawAnnotation[] {
  const out: RawAnnotation[] = [];
  const annots = page.dict.get('Annots');
  let items: PdfPrimitive[] = [];
  if (annots instanceof PdfArray) items = annots.items;
  else if (annots instanceof PdfRef) {
    const arr = resolve(objects, annots);
    if (arr instanceof PdfArray) items = arr.items;
  }

  let z = 10_000;
  for (const item of items) {
    let dict = item;
    if (item instanceof PdfRef) dict = resolve(objects, item);
    if (!(dict instanceof PdfDict)) continue;

    const subtype = dict.getName('Subtype') ?? 'Unknown';
    const rect = dict.getArray('Rect')?.asNumbers() ?? [0, 0, 0, 0];
    const bbox = {
      x: Math.min(rect[0] ?? 0, rect[2] ?? 0),
      y: Math.min(rect[1] ?? 0, rect[3] ?? 0),
      width: Math.abs((rect[2] ?? 0) - (rect[0] ?? 0)),
      height: Math.abs((rect[3] ?? 0) - (rect[1] ?? 0)),
    };

    const contents = typeof dict.get('Contents') === 'string' ? (dict.get('Contents') as string) : null;
    let uri: string | null = null;
    const action = dict.getDict('A') ?? (dict.getRef('A') ? (resolve(objects, dict.getRef('A')!) as PdfDict) : null);
    if (action instanceof PdfDict && action.getName('S') === 'URI') {
      const u = action.get('URI');
      if (typeof u === 'string') uri = u;
    }

    const ann: RawAnnotation = {
      id: createId('annot'),
      type: 'annotation',
      parentId: pageId,
      childIds: [],
      pageIndex: page.index,
      bbox,
      transform: IDENTITY_MATRIX,
      zIndex: z++,
      subtype,
      contents,
      uri,
      dest: dict.get('Dest'),
    };
    out.push(ann);
    graph.add(ann);
    spatial.insert({ id: ann.id, type: 'annotation', bbox, zIndex: ann.zIndex });
  }
  return out;
}

function extractForms(
  annotations: RawAnnotation[],
  pageId: string,
  graph: ObjectGraph,
  spatial: PageSpatialIndex,
): RawForm[] {
  // Widget annotations become form fields at a basic level
  return annotations
    .filter((a) => a.subtype === 'Widget')
    .map((a) => {
      const form: RawForm = {
        id: createId('form'),
        type: 'form',
        parentId: pageId,
        childIds: [],
        pageIndex: a.pageIndex,
        bbox: a.bbox,
        transform: IDENTITY_MATRIX,
        zIndex: a.zIndex,
        fieldName: a.contents ?? 'field',
        fieldType: 'Widget',
        value: a.contents,
      };
      graph.add(form);
      spatial.insert({ id: form.id, type: 'form', bbox: form.bbox, zIndex: form.zIndex });
      return form;
    });
}

function nums(operands: unknown[], count: number): number[] {
  const numbers = operands.filter((o): o is number => typeof o === 'number');
  return numbers.slice(-count);
}

function num(operands: unknown[], _i: number): number {
  const numbers = operands.filter((o): o is number => typeof o === 'number');
  return numbers[numbers.length - 1] ?? 0;
}

function transform(m: Matrix2D, x: number, y: number): { x: number; y: number } {
  return {
    x: m[0] * x + m[2] * y + m[4],
    y: m[1] * x + m[3] * y + m[5],
  };
}

function pathPoints(cmds: PathCommand[]): Array<{ x: number; y: number }> {
  const pts: Array<{ x: number; y: number }> = [];
  for (const c of cmds) {
    if (c.op === 'm' || c.op === 'l') pts.push({ x: c.x, y: c.y });
    else if (c.op === 'c') pts.push({ x: c.x1, y: c.y1 }, { x: c.x2, y: c.y2 }, { x: c.x3, y: c.y3 });
    else if (c.op === 'v' || c.op === 'y') pts.push({ x: c.x3, y: c.y3 });
    else if (c.op === 're') {
      pts.push(
        { x: c.x, y: c.y },
        { x: c.x + c.w, y: c.y },
        { x: c.x + c.w, y: c.y + c.h },
        { x: c.x, y: c.y + c.h },
      );
    }
  }
  return pts;
}

function boundsOf(points: Array<{ x: number; y: number }>): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function boxFrom(r: [number, number, number, number]): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  return {
    x: Math.min(r[0], r[2]),
    y: Math.min(r[1], r[3]),
    width: Math.abs(r[2] - r[0]),
    height: Math.abs(r[3] - r[1]),
  };
}
