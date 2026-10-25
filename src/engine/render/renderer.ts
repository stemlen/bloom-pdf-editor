/**
 * PDF Page Renderer
 *
 * Renders a parsed PDF page to an HTML5 Canvas using our own engine.
 * This replaces PDF.js entirely.
 *
 * Pipeline:
 *   1. Parse page content stream → CSInstructions
 *   2. Interpret instructions → display list (text, paths, images)
 *   3. Draw display list items to CanvasRenderingContext2D
 *
 * Supports:
 *   - Text rendering with font matching
 *   - Path construction and painting (fill, stroke, clip)
 *   - Image XObjects (JPEG, raw pixel data)
 *   - Color spaces (RGB, Gray, CMYK, Indexed, CalRGB, ICCBased)
 *   - Transparency (fill/stroke alpha, SMask)
 *   - Page rotation and scaling
 */

import { parsePDF, getPageContentBytes, resolveRef, getResource } from '../parser/parser';
import { interpretPage, type DisplayItem, type TextRun, type PathItem, type ImageItem, type FormItem, type ShadingItem, type GlyphPosition, type ClipPathNode } from '../content/interpreter';
import { buildDocumentFlow, buildFlowDrawIndex, type DocumentFlow, type TextLine } from '../flow';
import type { FlowGlyphDraw } from '../flow/flow-draw';
import { loadPageFonts, type FontData } from '../fonts/font-parser';
import { isTrueTypeFontData } from '../fonts/truetype-parser';
import { getCSSFontFamily, getStandardFont } from '../fonts/standard14';
import { isIndicCombiningChar, normalizeIndicText, INDIC_FONT_FALLBACKS, hasIndicText } from '../fonts/indic-normalizer';
import { decodeImage } from './image-decoder';
import { rgbToCSSColor } from './color-space';
import { applyClipPaths } from './clipping';
import { toCanvasBlendMode } from './transparency';
import { parseSoftMask, type SoftMaskSubtype } from './soft-mask';
import {
  PDFDict,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFStream,
  PDFArray,
  type PDFDocumentData,
  type PDFPageInfo,
} from '../types';

// ─── Render options ─────────────────────────────────────────────────────────

export interface RenderOptions {
  /** Scale factor (1.0 = 72 DPI, 2.0 = 144 DPI, etc.) */
  scale: number;
  /** Background color (default: white) */
  background?: string;
  /** Whether to render text (default: true) */
  renderText?: boolean;
  /** Whether to render paths (default: true) */
  renderPaths?: boolean;
  /** Whether to render images (default: true) */
  renderImages?: boolean;
  /**
   * Override devicePixelRatio used for canvas backing store.
   * Pass `1` for export/compression so Retina screens don't inflate file size.
   */
  devicePixelRatio?: number;
}

// ─── Render result ──────────────────────────────────────────────────────────

export interface RenderResult {
  /** The rendered canvas */
  canvas: HTMLCanvasElement;
  /** Raw text runs from the content stream */
  textRuns: TextRun[];
  /** Logical lines (bold + regular grouped) for Word-style editing */
  textLines: TextLine[];
  /** Full document flow model */
  documentFlow: DocumentFlow;
  /** Font data loaded for this page */
  fonts: Map<string, FontData>;
  /** Page dimensions in PDF points */
  pageWidth: number;
  pageHeight: number;
}

// ─── Main render functions ──────────────────────────────────────────────────

/**
 * Render a single page from a parsed PDF document to a canvas.
 */
export async function renderPage(
  doc: PDFDocumentData,
  pageIndex: number,
  options: RenderOptions,
): Promise<RenderResult> {
  if (pageIndex < 0 || pageIndex >= doc.pages.length) {
    throw new Error(`Page index ${pageIndex} out of range (0-${doc.pages.length - 1})`);
  }

  const page = doc.pages[pageIndex];
  return renderPageToCanvas(page, doc.objects, options);
}

/**
 * Render a page to a new canvas element.
 */
export async function renderPageToCanvas(
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  options: RenderOptions,
): Promise<RenderResult> {
  const scale = options.scale ?? 1;
  const background = options.background ?? '#ffffff';
  const renderText = options.renderText ?? true;
  const renderPaths = options.renderPaths ?? true;
  const renderImages = options.renderImages ?? true;

  // Compute page dimensions (accounting for rotation)
  const { mediaBox, rotate } = page;
  const isRotated = rotate === 90 || rotate === 270;
  const pageWidth = isRotated ? mediaBox.height : mediaBox.width;
  const pageHeight = isRotated ? mediaBox.width : mediaBox.height;

  // Create canvas
  const canvas = document.createElement('canvas');
  const dpr =
    options.devicePixelRatio ??
    (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
  const logicalWidth = Math.ceil(pageWidth * scale);
  const logicalHeight = Math.ceil(pageHeight * scale);

  canvas.width = Math.ceil(logicalWidth * dpr);
  canvas.height = Math.ceil(logicalHeight * dpr);
  canvas.style.width = `${logicalWidth}px`;
  canvas.style.height = `${logicalHeight}px`;

  const ctx = canvas.getContext('2d')!;

  // Fill background
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Set up coordinate transformation:
  // PDF coordinates: origin at bottom-left, Y goes up
  // Canvas coordinates: origin at top-left, Y goes down
  ctx.save();
  ctx.scale(scale * dpr, scale * dpr);

  // Apply page rotation
  applyPageRotation(ctx, rotate, mediaBox.width, mediaBox.height);

  // Flip Y axis: PDF bottom-left → canvas top-left
  ctx.transform(1, 0, 0, -1, -mediaBox.x, mediaBox.y + mediaBox.height);

  // Get content stream bytes
  const contentBytes = getPageContentBytes(page, objects);

  // Interpret content stream
  const interpreted = interpretPage(contentBytes, page, objects);

  // Build flow model before drawing — justified lines use flow positions
  const documentFlow = buildDocumentFlow(interpreted.textRuns);

  // Load detailed font data
  const fonts = loadPageFonts(page.resources, objects);

  // Register embedded fonts in the browser
  if (typeof window !== 'undefined') {
    await registerEmbeddedFonts(fonts);
  }

  const flowDraw = buildFlowDrawIndex(documentFlow.lines, fonts);
  const drawnJustifiedRuns = new Set<TextRun>();
  const softMaskMap = await buildSoftMaskMap(interpreted.displayList, page, objects, options);

  // Render display list
  for (let i = 0; i < interpreted.displayList.length; i++) {
    const item = interpreted.displayList[i];

    switch (item.type) {
      case 'path':
        if (renderPaths) drawPath(ctx, item, softMaskMap);
        break;
      case 'text':
        if (renderText) {
          drawTextRunWithFlow(ctx, item, fonts, flowDraw, drawnJustifiedRuns, softMaskMap);
        }
        break;
      case 'image':
        if (renderImages) await drawImage(ctx, item, page, objects, softMaskMap);
        break;
      case 'form':
        await drawFormItem(ctx, item, page, objects, options);
        break;
      case 'shading':
        if (renderImages) drawShadingItem(ctx, item, page, objects);
        break;
    }
  }

  // Render Annotations (Appearance Streams)
  const annotsRef = page.dict.get('Annots');
  let annotsObj = annotsRef;
  if (annotsRef instanceof PDFRef) {
    annotsObj = resolveRef(annotsRef, objects);
  }
  
  if (annotsObj instanceof PDFArray) {
    for (const annotRef of annotsObj.items) {
      if (!(annotRef instanceof PDFRef)) continue;
      const annotDict = resolveRef(annotRef, objects);
      if (!(annotDict instanceof PDFDict)) continue;

      // Link annotations duplicate page text in hyperref/LaTeX PDFs — skip their
      // appearance streams to avoid rendering text twice on top of itself.
      const subtype = annotDict.get('Subtype');
      const subtypeName = subtype instanceof PDFName ? subtype.name : '';
      if (subtypeName === 'Link') continue;
      // Signature widgets stay as before: the editor draws placed signatures itself.
      if (subtypeName === 'Widget') {
        const parentObj = resolveRef(annotDict.get('Parent') as PDFRef, objects);
        const ft = annotDict.get('FT') ?? (parentObj instanceof PDFDict ? parentObj.get('FT') : undefined);
        if (ft instanceof PDFName && ft.name === 'Sig') continue;
      }
      // Hidden (F bit 2) and NoView (F bit 6) annotations aren't drawn.
      const flagsObj = annotDict.get('F');
      const annotFlags = flagsObj instanceof PDFNumber ? flagsObj.value : 0;
      if (annotFlags & 0b100010) continue;

      const apRef = annotDict.get('AP');
      let apDict = apRef;
      if (apRef instanceof PDFRef) apDict = resolveRef(apRef, objects);

      if (apDict instanceof PDFDict) {
        const nRef = apDict.get('N');
        let nStream = nRef;
        if (nRef instanceof PDFRef) nStream = resolveRef(nRef, objects);
        // Check boxes and radio buttons keep one appearance per state; /AS picks it.
        if (nStream instanceof PDFDict && !(nStream instanceof PDFStream)) {
          const asObj = annotDict.get('AS');
          const state = asObj instanceof PDFName ? nStream.get(asObj.name) : undefined;
          nStream = state instanceof PDFRef ? resolveRef(state, objects) : state;
        }
        
        if (nStream instanceof PDFStream) {
          // Interpret this Appearance stream
          const annotResources = nStream.dict.get('Resources') || annotDict.get('Resources') || page.dict.get('Resources');
          const mockPage = {
            ...page,
            resources: annotResources instanceof PDFRef ? resolveRef(annotResources, objects) as PDFDict : (annotResources as PDFDict) || new PDFDict(),
          };
          
          // Need to decode the stream if not already decoded
          if (!nStream.decodedBytes) {
             const { applyFilters } = await import('../parser/filters');
             nStream.decodedBytes = await applyFilters(
                 nStream.rawBytes,
                 nStream.getFilters(),
                 nStream.getDecodeParams()
             );
          }
          // Now getBytes() will safely return the uncompressed bytes
          
          const annotInterpreted = interpretPage(nStream.getBytes(), mockPage, objects);
          const annotFonts = loadPageFonts(mockPage.resources, objects);
          if (typeof window !== 'undefined') {
            await registerEmbeddedFonts(annotFonts);
          }
          
          ctx.save();

          // Honor annotation /CA so translucent highlights aren't solid bars
          const caObj = annotDict.get('CA');
          const annotOpacity = caObj instanceof PDFNumber ? caObj.value : 1;
          if (annotOpacity < 0.999) {
            ctx.globalAlpha = annotOpacity;
          }
          if (subtypeName === 'Highlight') {
            ctx.globalCompositeOperation = 'multiply';
          }

          // PDF 12.5.5: map the appearance Form BBox into the annotation Rect.
          // An identity /Matrix alone must NOT skip this — otherwise highlights
          // paint at the page origin (bottom of the page).
          const rectObj = annotDict.get('Rect');
          const bboxObj = nStream.dict.get('BBox');
          let mappedToRect = false;
          if (
            rectObj instanceof PDFArray && rectObj.items.length >= 4 &&
            bboxObj instanceof PDFArray && bboxObj.items.length >= 4
          ) {
            const rx0 = (rectObj.items[0] as PDFNumber).value;
            const ry0 = (rectObj.items[1] as PDFNumber).value;
            const rx1 = (rectObj.items[2] as PDFNumber).value;
            const ry1 = (rectObj.items[3] as PDFNumber).value;
            const bx0 = (bboxObj.items[0] as PDFNumber).value;
            const by0 = (bboxObj.items[1] as PDFNumber).value;
            const bx1 = (bboxObj.items[2] as PDFNumber).value;
            const by1 = (bboxObj.items[3] as PDFNumber).value;
            const bw = (bx1 - bx0) || 1;
            const bh = (by1 - by0) || 1;
            ctx.translate(rx0, ry0);
            ctx.scale((rx1 - rx0) / bw, (ry1 - ry0) / bh);
            ctx.translate(-bx0, -by0);
            mappedToRect = true;
          }

          if (!mappedToRect) {
            const streamMatrix = nStream.dict.get('Matrix');
            if (streamMatrix instanceof PDFArray && streamMatrix.items.length === 6) {
              const m = streamMatrix.items.map((e) => (e as PDFNumber).value);
              ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
            } else if (rectObj instanceof PDFArray && rectObj.items.length >= 4) {
              const x = (rectObj.items[0] as PDFNumber).value;
              const y = (rectObj.items[1] as PDFNumber).value;
              ctx.translate(x, y);
            }
          }

          for (let j = 0; j < annotInterpreted.displayList.length; j++) {
            const item = annotInterpreted.displayList[j];
            switch (item.type) {
              case 'path': if (renderPaths) drawPath(ctx, item); break;
              case 'text': if (renderText) drawTextRun(ctx, item, annotFonts); break;
              case 'image': if (renderImages) await drawImage(ctx, item, mockPage, objects); break;
              case 'form': await drawFormItem(ctx, item, mockPage, objects, options); break;
              case 'shading': if (renderImages) drawShadingItem(ctx, item, mockPage, objects); break;
            }
          }
          ctx.restore();
        }
      }
    }
  }

  ctx.restore();

  return {
    canvas,
    textRuns: interpreted.textRuns,
    textLines: documentFlow.lines,
    documentFlow,
    fonts,
    pageWidth,
    pageHeight,
  };
}

// ─── Page rotation ──────────────────────────────────────────────────────────

function applyPageRotation(
  ctx: CanvasRenderingContext2D,
  rotate: number,
  width: number,
  height: number,
): void {
  switch (rotate) {
    case 90:
      ctx.translate(height, 0);
      ctx.rotate(Math.PI / 2);
      break;
    case 180:
      ctx.translate(width, height);
      ctx.rotate(Math.PI);
      break;
    case 270:
      ctx.translate(0, width);
      ctx.rotate(-Math.PI / 2);
      break;
    default:
      break;
  }
}

// ─── Soft mask group rendering ────────────────────────────────────────────────

const softMaskCache = new WeakMap<PDFDict, HTMLCanvasElement>();

function maskLuminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function maskToAlphaCanvas(source: HTMLCanvasElement, subtype: SoftMaskSubtype): HTMLCanvasElement {
  const w = source.width;
  const h = source.height;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const sctx = source.getContext('2d')!;
  const octx = out.getContext('2d')!;
  const img = sctx.getImageData(0, 0, w, h);
  const outData = octx.createImageData(w, h);

  for (let i = 0; i < img.data.length; i += 4) {
    const r = img.data[i] / 255;
    const g = img.data[i + 1] / 255;
    const b = img.data[i + 2] / 255;
    const a = img.data[i + 3] / 255;
    const alpha = subtype === 'Luminosity' ? maskLuminance(r, g, b) : a;
    const v = Math.round(alpha * 255);
    outData.data[i] = v;
    outData.data[i + 1] = v;
    outData.data[i + 2] = v;
    outData.data[i + 3] = 255;
  }

  octx.putImageData(outData, 0, 0);
  return out;
}

async function renderSoftMaskGroup(
  softMask: PDFDict,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  options: RenderOptions,
): Promise<HTMLCanvasElement | null> {
  const cached = softMaskCache.get(softMask);
  if (cached) return cached;

  const info = parseSoftMask(softMask);
  const gRef = softMask.get('G');
  if (!gRef) return null;

  const gObj = resolveRef(gRef, objects);
  if (!(gObj instanceof PDFStream)) return null;

  const dict = gObj.dict;
  const bbox = dict.getArray('BBox')?.asNumbers() ?? [0, 0, page.mediaBox.width, page.mediaBox.height];
  const matrix = dict.getArray('Matrix')?.asNumbers() ?? [1, 0, 0, 1, 0, 0];

  const w = Math.max(1, Math.ceil(page.mediaBox.width));
  const h = Math.max(1, Math.ceil(page.mediaBox.height));
  const rgbCanvas = document.createElement('canvas');
  rgbCanvas.width = w;
  rgbCanvas.height = h;
  const rgbCtx = rgbCanvas.getContext('2d')!;
  rgbCtx.save();
  rgbCtx.transform(1, 0, 0, -1, -page.mediaBox.x, page.mediaBox.y + page.mediaBox.height);
  rgbCtx.transform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);

  const formResourcesRef = dict.get('Resources');
  let formResources = page.resources;
  if (formResourcesRef) {
    const resolved = resolveRef(formResourcesRef, objects);
    if (resolved instanceof PDFDict) formResources = resolved;
  }

  if (!gObj.decodedBytes) {
    const { applyFilters } = await import('../parser/filters');
    gObj.decodedBytes = await applyFilters(
      gObj.rawBytes,
      gObj.getFilters(),
      gObj.getDecodeParams(),
    );
  }

  const formPage: PDFPageInfo = { ...page, resources: formResources };
  const interpreted = interpretPage(gObj.getBytes(), formPage, objects);
  const formFonts = loadPageFonts(formResources, objects);
  if (typeof window !== 'undefined') {
    await registerEmbeddedFonts(formFonts);
  }

  rgbCtx.beginPath();
  rgbCtx.rect(bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1]);
  rgbCtx.clip();

  const emptyMask = new Map<PDFDict, HTMLCanvasElement>();
  for (let i = 0; i < interpreted.displayList.length; i++) {
    const item = interpreted.displayList[i];
    switch (item.type) {
      case 'path': drawPath(rgbCtx, item, emptyMask); break;
      case 'text': drawTextRun(rgbCtx, item, formFonts, emptyMask); break;
      case 'image': await drawImage(rgbCtx, item, formPage, objects, emptyMask); break;
      case 'form': await drawFormItem(rgbCtx, item, formPage, objects, options); break;
      case 'shading': drawShadingItem(rgbCtx, item, formPage, objects); break;
    }
  }

  rgbCtx.restore();

  const alphaCanvas = maskToAlphaCanvas(rgbCanvas, info.subtype);
  softMaskCache.set(softMask, alphaCanvas);
  return alphaCanvas;
}

async function buildSoftMaskMap(
  items: DisplayItem[],
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  options: RenderOptions,
): Promise<Map<PDFDict, HTMLCanvasElement>> {
  const map = new Map<PDFDict, HTMLCanvasElement>();
  const seen = new Set<PDFDict>();

  for (let i = 0; i < items.length; i++) {
    const sm = items[i].softMask;
    if (sm && !seen.has(sm)) {
      seen.add(sm);
      const canvas = await renderSoftMaskGroup(sm, page, objects, options);
      if (canvas) map.set(sm, canvas);
    }
  }

  return map;
}

function drawWithSoftMask(
  ctx: CanvasRenderingContext2D,
  softMask: PDFDict | null,
  maskMap: Map<PDFDict, HTMLCanvasElement>,
  bounds: { x: number; y: number; width: number; height: number },
  paint: () => void,
): void {
  if (!softMask || !maskMap.has(softMask) || bounds.width <= 0 || bounds.height <= 0) {
    paint();
    return;
  }

  const mask = maskMap.get(softMask)!;
  ctx.save();
  ctx.beginPath();
  ctx.rect(bounds.x, bounds.y, bounds.width, bounds.height);
  ctx.clip();
  paint();
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(mask, 0, 0);
  ctx.restore();
}

// ─── Path rendering ─────────────────────────────────────────────────────────

function drawPath(
  ctx: CanvasRenderingContext2D,
  item: PathItem,
  maskMap: Map<PDFDict, HTMLCanvasElement> = new Map(),
): void {
  if (item.segments.length === 0) return;

  const bounds = { x: item.x, y: item.y, width: item.width, height: item.height };
  drawWithSoftMask(ctx, item.softMask, maskMap, bounds, () => {
    ctx.save();
    ctx.globalCompositeOperation = toCanvasBlendMode(item.blendMode);
    applyClipPaths(ctx, item.clipPaths);

    ctx.beginPath();

    for (let i = 0; i < item.segments.length; i++) {
      const seg = item.segments[i];
      switch (seg.type) {
        case 'M':
          ctx.moveTo(seg.points[0], seg.points[1]);
          break;
        case 'L':
          ctx.lineTo(seg.points[0], seg.points[1]);
          break;
        case 'C':
          ctx.bezierCurveTo(
            seg.points[0], seg.points[1],
            seg.points[2], seg.points[3],
            seg.points[4], seg.points[5],
          );
          break;
        case 'Z':
          ctx.closePath();
          break;
      }
    }

    if (item.paintType === 'fill' || item.paintType === 'both') {
      if (item.fillColor) {
        ctx.fillStyle = rgbToCSSColor(item.fillColor, item.fillAlpha);
        ctx.fill();
      }
    }

    if (item.paintType === 'stroke' || item.paintType === 'both') {
      if (item.strokeColor) {
        ctx.strokeStyle = rgbToCSSColor(item.strokeColor, item.strokeAlpha);
        ctx.lineWidth = item.lineWidth;
        ctx.stroke();
      }
    }

    ctx.restore();
  });
}

// ─── Text rendering ─────────────────────────────────────────────────────────

/** Strip PDF subset prefix (e.g. "ABCDEF+TimesNewRomanPSMT" → "TimesNewRomanPSMT"). */
function stripFontSubsetPrefix(baseFont: string): string {
  const plus = baseFont.indexOf('+');
  return plus >= 0 ? baseFont.slice(plus + 1) : baseFont;
}

/**
 * CSS/FontFace-safe family name.
 * PDF BaseFonts often look like "Times New Roman,Bold" — the comma breaks
 * unquoted CSS font-family lists, so we normalize style suffixes to spaces.
 */
function cssFontFamilyName(baseFont: string): string {
  let name = stripFontSubsetPrefix(baseFont) || baseFont;
  // "Family,Bold" / "Family,BoldItalic" → "Family Bold" / "Family BoldItalic"
  name = name.replace(/,(\s*)(Bold|Italic|BoldItalic|Oblique|Regular|Light|Medium|Black)/gi, ' $2');
  return name.trim();
}

function isDingbatOrSymbolFamily(baseFont: string): boolean {
  const lower = (stripFontSubsetPrefix(baseFont) || baseFont).toLowerCase();
  return lower.includes('zapf') || lower.includes('dingbat') || lower === 'symbol' || lower.endsWith('symbol');
}

type FlowDrawIndex = ReturnType<typeof buildFlowDrawIndex>;

function drawTextRunWithFlow(
  ctx: CanvasRenderingContext2D,
  run: TextRun,
  fonts: Map<string, FontData>,
  flowDraw: FlowDrawIndex,
  drawnJustifiedRuns: Set<TextRun>,
  maskMap: Map<PDFDict, HTMLCanvasElement> = new Map(),
): void {
  if (drawnJustifiedRuns.has(run)) return;

  const line = flowDraw.runToLine.get(run);
  if (line && flowDraw.justifiedLines.has(line)) {
    drawJustifiedTextLine(ctx, line, flowDraw, fonts, drawnJustifiedRuns, maskMap);
    return;
  }

  drawTextRun(ctx, run, fonts, maskMap);
}

function drawJustifiedTextLine(
  ctx: CanvasRenderingContext2D,
  line: TextLine,
  flowDraw: FlowDrawIndex,
  fonts: Map<string, FontData>,
  drawnJustifiedRuns: Set<TextRun>,
  maskMap: Map<PDFDict, HTMLCanvasElement> = new Map(),
): void {
  const drawMap = flowDraw.drawMaps.get(line);
  if (!drawMap) {
    for (let r = 0; r < line.runs.length; r++) {
      drawTextRun(ctx, line.runs[r], fonts, maskMap);
      drawnJustifiedRuns.add(line.runs[r]);
    }
    return;
  }

  for (let r = 0; r < line.runs.length; r++) {
    const run = line.runs[r];
    const positions = drawMap.get(run);
    if (positions && positions.length > 0) {
      drawTextRunAtPositions(ctx, run, fonts, positions, maskMap);
    } else {
      drawTextRun(ctx, run, fonts, maskMap);
    }
    drawnJustifiedRuns.add(run);
  }
}

function drawTextRunAtPositions(
  ctx: CanvasRenderingContext2D,
  run: TextRun,
  fonts: Map<string, FontData>,
  positions: FlowGlyphDraw[],
  maskMap: Map<PDFDict, HTMLCanvasElement> = new Map(),
): void {
  if (positions.length === 0) return;

  const bounds = { x: run.x, y: run.y, width: run.width, height: run.height };
  drawWithSoftMask(ctx, run.softMask, maskMap, bounds, () => {
    ctx.save();
    ctx.globalCompositeOperation = toCanvasBlendMode(run.blendMode);
    applyClipPaths(ctx, run.clipPaths, bounds);

    const fontData = fonts.get(run.fontName);
    const fillColor = rgbToCSSColor(run.fillColor, run.fillAlpha);
    const { family, weight, style } = getCanvasFontProperties(run.fontName, fontData);
    ctx.fillStyle = fillColor;

    if (fontData?.charProcs) {
      // Type3 — must draw glyph-by-glyph
      for (let i = 0; i < positions.length; i++) {
        const glyph = positions[i].glyph;
        if (glyph.unicode === ' ' || glyph.unicode === '\u00A0') continue;
        const charName = type3CharName(fontData, glyph.charCode ?? glyph.unicode.charCodeAt(0));
        if (charName) {
          drawType3Glyph(
            ctx, fontData, charName, positions[i].x, positions[i].f, run.fontSize
          );
        } else {
          drawGlyph(ctx, glyph, run, family, weight, style, fillColor, positions[i].x, positions[i].f);
        }
      }
    } else {
      // Group glyphs into chunks; split on whitespace OR large/negative TJ gaps.
      type Chunk = { start: number; end: number; text: string };
      const chunks: Chunk[] = [];
      let ci = 0;
      const gapFrac = CHUNK_GAP_FRAC;

      while (ci < positions.length) {
        if (positions[ci].glyph.unicode === ' ' || positions[ci].glyph.unicode === '\u00A0') {
          ci++;
          continue;
        }
        const start = ci;
        let text = positions[ci].glyph.unicode;
        ci++;
        while (
          ci < positions.length &&
          positions[ci].glyph.unicode !== ' ' &&
          positions[ci].glyph.unicode !== '\u00A0'
        ) {
          const prev = positions[ci - 1];
          const cur = positions[ci];
          const gap = cur.x - (prev.x + prev.glyph.width);
          const fs = cur.glyph.fontSize || run.fontSize || 12;
          const isIndic =
            hasIndicText(cur.glyph.unicode) ||
            hasIndicText(prev.glyph.unicode) ||
            isIndicCombiningChar(cur.glyph.unicode) ||
            isIndicCombiningChar(prev.glyph.unicode);

          if (isIndic) {
            // Never split inside an Indic word across intra-word kerning/vowel gaps
            if (gap > fs * 1.5) break;
          } else {
            if (gap > fs * gapFrac || gap < -fs * 0.02) break;
          }
          text += cur.glyph.unicode;
          ci++;
        }
        if (text.length > 0) {
          chunks.push({ start, end: ci, text });
        }
      }

      const nextDrawable = (from: number): number => {
        for (let i = from; i < positions.length; i++) {
          const u = positions[i].glyph.unicode;
          if (u !== ' ' && u !== '\u00A0') return i;
        }
        return -1;
      };

      for (const chunk of chunks) {
        const firstPos = positions[chunk.start];
        const { tRm } = firstPos.glyph;
        const effFontSize = Math.sqrt(tRm.c * tRm.c + tRm.d * tRm.d);
        if (effFontSize < 0.1) continue;

        let originX = firstPos.x;
        const isIndic = hasIndicText(chunk.text);
        if (isIndic) {
          let minX = Infinity;
          for (let i = chunk.start; i < chunk.end; i++) {
            if (positions[i].x < minX) minX = positions[i].x;
          }
          if (minX < Infinity) originX = minX;
        }

        let pdfSpan = chunkPdfSpan(
          i => positions[i].x,
          i => positions[i].glyph.width,
          i => positions[i].glyph.fontSize || run.fontSize || 12,
          chunk.start,
          chunk.end,
          positions.length,
          nextDrawable,
        );

        if (isIndic && originX < firstPos.x) {
          pdfSpan += (firstPos.x - originX);
        }

        ctx.save();
        ctx.transform(
          tRm.a / effFontSize, tRm.b / effFontSize,
          tRm.c / effFontSize, tRm.d / effFontSize,
          originX, firstPos.f,
        );
        ctx.scale(1, -1);

        if (isBulletOnlyText(chunk.text)) {
          fillBulletDot(ctx, effFontSize, pdfSpan, fillColor);
          ctx.restore();
          continue;
        }

        ctx.font = `${style} ${weight} ${effFontSize}px ${family}`;

        const drawText = normalizeIndicText(chunk.text);
        if (pdfSpan > 0.5 && drawText.length > 0) {
          const browserWidth = ctx.measureText(drawText).width;
          if (browserWidth > 0.1) {
            const hScale = Math.abs(tRm.a) / effFontSize;
            const expectedWidth = pdfSpan / (hScale || 1);
            let ratio = expectedWidth / browserWidth;
            // Clamp extreme ratios from missing FontFace / bad widths.
            ratio = Math.max(0.4, Math.min(2.5, ratio));
            if (Math.abs(ratio - 1) > 0.005) {
              ctx.scale(ratio, 1);
            }
          }
        }

        ctx.fillText(drawText, 0, 0);

        if (run.isUnderline) {
          const underlineY = effFontSize * 0.15;
          const underlineThickness = Math.max(1, effFontSize * 0.05);
          const charWidth = ctx.measureText(chunk.text).width;
          ctx.beginPath();
          ctx.moveTo(0, underlineY);
          ctx.lineTo(charWidth, underlineY);
          ctx.lineWidth = underlineThickness;
          ctx.strokeStyle = fillColor;
          ctx.stroke();
        }

        ctx.restore();
      }
    }

    ctx.restore();
  });
}

import { drawType3Glyph, type3CharName } from './type3';

function drawTextRun(
  ctx: CanvasRenderingContext2D,
  run: TextRun,
  fonts: Map<string, FontData>,
  maskMap: Map<PDFDict, HTMLCanvasElement> = new Map(),
): void {
  if (run.glyphs.length === 0) return;

  const bounds = { x: run.x, y: run.y, width: run.width, height: run.height };
  drawWithSoftMask(ctx, run.softMask, maskMap, bounds, () => {
    ctx.save();
    ctx.globalCompositeOperation = toCanvasBlendMode(run.blendMode);
    applyClipPaths(ctx, run.clipPaths, bounds);

    const fontData = fonts.get(run.fontName);
    const fillColor = rgbToCSSColor(run.fillColor, run.fillAlpha);
    const { family, weight, style } = getCanvasFontProperties(run.fontName, fontData);
    ctx.fillStyle = fillColor;

    const isType3 = fontData?.charProcs && fontData.charProcs.size > 0;

    if (isType3) {
      for (let i = 0; i < run.glyphs.length; i++) {
        const glyph = run.glyphs[i];
        const name = type3CharName(fontData!, glyph.charCode ?? glyph.unicode.charCodeAt(0));
        if (name) {
          const drawn = drawType3Glyph(
            ctx, fontData!, name, glyph.tRm.e, glyph.tRm.f,
            Math.sqrt(glyph.tRm.c * glyph.tRm.c + glyph.tRm.d * glyph.tRm.d) || run.fontSize,
          );
          if (drawn) continue;
        }
        drawGlyph(ctx, glyph, run, family, weight, style, fillColor, glyph.tRm.e, glyph.tRm.f);
      }
    } else {
      drawWordGrouped(ctx, run, family, weight, style, fillColor);
    }

    ctx.restore();
  });
}

/** Split chunks when TJ inserts a large gap (do not stretch fillText across it). */
const CHUNK_GAP_FRAC = 0.12;

/**
 * Horizontal span for a glyph chunk in PDF user units.
 *
 * Acrobat/PDF.js place each glyph at its PDF origin; we approximate that by
 * scaling a fillText word so it occupies [first.x, last.x + last.width].
 * Only clamp when the span would draw into the next glyph's origin — never
 * leave padding that becomes a visible river before punctuation.
 */
function chunkPdfSpan(
  getX: (i: number) => number,
  getWidth: (i: number) => number,
  getFs: (i: number) => number,
  start: number,
  end: number,
  len: number,
  findNextDrawable: (from: number) => number,
): number {
  const firstX = getX(start);
  const last = end - 1;
  const fs = getFs(last);
  const lastW = getWidth(last);
  // Cap only pathological Widths entries (would invade neighbors).
  let span = (getX(last) - firstX) + (lastW > fs * 1.2 ? fs * 0.65 : lastW);

  const next = findNextDrawable(end);
  if (next >= 0 && next < len) {
    // Hard stop at the next glyph origin — zero padding so substitute-font
    // scaling fills the PDF slot completely (PDFBOX-520 / Acrobat parity).
    const maxSpan = getX(next) - firstX;
    if (maxSpan > 0.5) span = Math.min(span, maxSpan);
  }

  return Math.max(span, 0.5);
}

/**
 * Bullet / list-marker code points. System Times often paints U+2022 as a
 * square block; draw these as circles for Acrobat-like round dots.
 */
function isBulletCodePoint(cp: number): boolean {
  return (
    cp === 0x2022 || // •
    cp === 0x25CF || // ●
    cp === 0x25AA || // ▪
    cp === 0x25A0 || // ■ (ZapfDingbats filled box used as bullet)
    cp === 0x00B7 || // ·
    cp === 0x2219 || // ∙
    cp === 0x2043 || // ⁃
    cp === 0x25E6 || // ◦
    cp === 0x2023    // ‣
  );
}

function isBulletOnlyText(text: string): boolean {
  if (!text) return false;
  let saw = false;
  for (const ch of text) {
    if (ch === ' ' || ch === '\u00A0') continue;
    const cp = ch.codePointAt(0);
    if (cp == null || !isBulletCodePoint(cp)) return false;
    saw = true;
  }
  return saw;
}

/** Filled circle in the same local space as fillText(0,0) after scale(1,-1). */
function fillBulletDot(
  ctx: CanvasRenderingContext2D,
  fontSize: number,
  advance: number,
  fillColor: string,
): void {
  const slot = Math.max(advance, fontSize * 0.35);
  const r = Math.max(0.45, Math.min(fontSize * 0.17, slot * 0.32));
  const cx = slot * 0.45;
  // Optical center of a list bullet (between baseline and cap-height).
  const cy = -fontSize * 0.32;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = fillColor;
  ctx.fill();
}

/**
 * Draw run text by grouping consecutive non-space glyphs into word chunks.
 * Each chunk is a single fillText call, scaled to a span that must not
 * invade the following glyph's slot.
 */
function drawWordGrouped(
  ctx: CanvasRenderingContext2D,
  run: TextRun,
  family: string,
  weight: string,
  style: string,
  fillColor: string,
): void {
  const glyphs = run.glyphs;
  if (glyphs.length === 0) return;

  type Chunk = { start: number; end: number; text: string };
  const chunks: Chunk[] = [];
  let ci = 0;

  while (ci < glyphs.length) {
    if (glyphs[ci].unicode === ' ' || glyphs[ci].unicode === '\u00A0') {
      ci++;
      continue;
    }
    const start = ci;
    let text = glyphs[ci].unicode;
    ci++;
    while (ci < glyphs.length && glyphs[ci].unicode !== ' ' && glyphs[ci].unicode !== '\u00A0') {
      const prev = glyphs[ci - 1];
      const cur = glyphs[ci];
      const gap = cur.tRm.e - (prev.tRm.e + prev.width);
      const fs = cur.fontSize || run.fontSize || 12;
      const isIndic =
        hasIndicText(cur.unicode) ||
        hasIndicText(prev.unicode) ||
        isIndicCombiningChar(cur.unicode) ||
        isIndicCombiningChar(prev.unicode);

      if (isIndic) {
        // Never split inside an Indic word across intra-word kerning/vowel gaps
        if (gap > fs * 1.5) break;
      } else {
        if (gap > fs * CHUNK_GAP_FRAC || gap < -fs * 0.02) break;
      }
      text += cur.unicode;
      ci++;
    }
    if (text.length > 0) {
      chunks.push({ start, end: ci, text });
    }
  }

  const nextDrawable = (from: number): number => {
    for (let i = from; i < glyphs.length; i++) {
      if (glyphs[i].unicode !== ' ' && glyphs[i].unicode !== '\u00A0') return i;
    }
    return -1;
  };

  for (const chunk of chunks) {
    const firstGlyph = glyphs[chunk.start];
    const { tRm } = firstGlyph;
    const effFontSize = Math.sqrt(tRm.c * tRm.c + tRm.d * tRm.d);
    if (effFontSize < 0.1) continue;

    let originX = firstGlyph.tRm.e;
    const isIndic = hasIndicText(chunk.text);
    if (isIndic) {
      let minX = Infinity;
      for (let i = chunk.start; i < chunk.end; i++) {
        if (glyphs[i].tRm.e < minX) minX = glyphs[i].tRm.e;
      }
      if (minX < Infinity) originX = minX;
    }

    let pdfSpan = chunkPdfSpan(
      i => glyphs[i].tRm.e,
      i => glyphs[i].width,
      i => glyphs[i].fontSize || run.fontSize || 12,
      chunk.start,
      chunk.end,
      glyphs.length,
      nextDrawable,
    );

    if (isIndic && originX < firstGlyph.tRm.e) {
      pdfSpan += (firstGlyph.tRm.e - originX);
    }

    ctx.save();
    ctx.transform(
      tRm.a / effFontSize, tRm.b / effFontSize,
      tRm.c / effFontSize, tRm.d / effFontSize,
      originX, firstGlyph.tRm.f,
    );
    ctx.scale(1, -1);

    // Round geometric dots — system Times/serif often paint U+2022 as a square.
    if (isBulletOnlyText(chunk.text)) {
      fillBulletDot(ctx, effFontSize, pdfSpan, fillColor);
      ctx.restore();
      continue;
    }

    ctx.font = `${style} ${weight} ${effFontSize}px ${family}`;

    const drawText = normalizeIndicText(chunk.text);
    if (pdfSpan > 0.5 && drawText.length > 0) {
      const browserWidth = ctx.measureText(drawText).width;
      if (browserWidth > 0.1) {
        const hScale = Math.abs(tRm.a) / effFontSize;
        const expectedWidth = pdfSpan / (hScale || 1);
        let ratio = expectedWidth / browserWidth;
        // Wider clamp so substitute fonts can still fill PDF slots.
        ratio = Math.max(0.4, Math.min(2.5, ratio));
        if (Math.abs(ratio - 1) > 0.005) {
          ctx.scale(ratio, 1);
        }
      }
    }

    ctx.fillText(drawText, 0, 0);

    if (run.isUnderline) {
      const underlineY = effFontSize * 0.15;
      const underlineThickness = Math.max(1, effFontSize * 0.05);
      const charWidth = ctx.measureText(drawText).width;
      ctx.beginPath();
      ctx.moveTo(0, underlineY);
      ctx.lineTo(charWidth, underlineY);
      ctx.lineWidth = underlineThickness;
      ctx.strokeStyle = fillColor;
      ctx.stroke();
    }

    ctx.restore();
  }
}

function drawGlyph(
  ctx: CanvasRenderingContext2D,
  glyph: GlyphPosition,
  run: TextRun,
  family: string,
  weight: string,
  style: string,
  fillColor: string,
  x: number,
  f: number,
): void {
  const { tRm } = glyph;
  const effFontSize = Math.sqrt(tRm.c * tRm.c + tRm.d * tRm.d);
  if (effFontSize < 0.1) return;
  if (glyph.unicode === ' ' || glyph.unicode === '\u00A0') return;

  ctx.save();
  ctx.transform(
    tRm.a / effFontSize, tRm.b / effFontSize,
    tRm.c / effFontSize, tRm.d / effFontSize,
    x, f,
  );
  ctx.scale(1, -1);

  if (isBulletOnlyText(glyph.unicode)) {
    fillBulletDot(ctx, effFontSize, glyph.width || effFontSize * 0.5, fillColor);
    ctx.restore();
    return;
  }

  ctx.font = `${style} ${weight} ${effFontSize}px ${family}`;

  const drawGlyphText = normalizeIndicText(glyph.unicode);

  // Fit substitute-font glyph into the PDF advance so letters don't overlap.
  const pdfAdvance = Math.max(glyph.width, 0.01);
  const hScale = Math.abs(tRm.a) / effFontSize || 1;
  const expected = pdfAdvance / hScale;
  const measured = ctx.measureText(drawGlyphText).width;
  if (measured > 0.1) {
    let ratio = expected / measured;
    ratio = Math.max(0.45, Math.min(1.85, ratio));
    if (Math.abs(ratio - 1) > 0.005) ctx.scale(ratio, 1);
  }

  ctx.fillText(drawGlyphText, 0, 0);

  if (run.isUnderline) {
    const underlineY = effFontSize * 0.15;
    const underlineThickness = Math.max(1, effFontSize * 0.05);
    const charWidth = ctx.measureText(glyph.unicode).width;
    ctx.beginPath();
    ctx.moveTo(0, underlineY);
    ctx.lineTo(charWidth, underlineY);
    ctx.lineWidth = underlineThickness;
    ctx.strokeStyle = fillColor;
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * Extract CSS font properties (family, style, weight) without the size,
 * because size is handled by the transformation matrix.
 */
function fontLooksBold(fontData: FontData | undefined, fontName: string): boolean {
  if (!fontData) {
    return /bold|black|heavy|demi/i.test(fontName);
  }
  if (fontData.standardMetrics?.isBold) return true;
  if ((fontData.fontWeight ?? 0) >= 600) return true;
  // PDF FontDescriptor Flags bit 18 = ForceBold
  if ((fontData.flags ?? 0) & (1 << 18)) return true;
  const base = stripFontSubsetPrefix(fontData.baseFont) || fontData.baseFont || fontName;
  return /bold|black|heavy|demi/i.test(base);
}

function fontLooksItalic(fontData: FontData | undefined, fontName: string): boolean {
  if (!fontData) {
    return /italic|oblique/i.test(fontName);
  }
  if (fontData.standardMetrics?.isItalic) return true;
  if (Math.abs(fontData.italicAngle ?? 0) > 1) return true;
  // Flags bit 6 = Italic
  if ((fontData.flags ?? 0) & (1 << 6)) return true;
  const base = stripFontSubsetPrefix(fontData.baseFont) || fontData.baseFont || fontName;
  return /italic|oblique/i.test(base);
}

function getCanvasFontProperties(
  fontName: string,
  fontData?: FontData,
): { family: string; weight: string; style: string } {
  let weight = fontLooksBold(fontData, fontName) ? 'bold' : 'normal';
  let style = fontLooksItalic(fontData, fontName) ? 'italic' : 'normal';
  let family = 'sans-serif';

  if (fontData) {
    const stripped = cssFontFamilyName(fontData.baseFont);
    const lower = (stripped || fontData.baseFont || '').toLowerCase();

    // Symbol / ZapfDingbats: always paint remapped Unicode with a real system
    // symbols face. Embedded Symbol subsets only cmap PUA/Mac bytes, so
    // fillText("•") / fillText("x") both fail against the embedded FontFace.
    const isIndic =
      lower.includes('kruti') ||
      lower.includes('devlys') ||
      lower.includes('chanakya') ||
      lower.includes('mangal') ||
      lower.includes('nirmala') ||
      lower.includes('deva') ||
      lower.includes('hindi') ||
      lower.includes('hind') ||
      lower.includes('walkman') ||
      lower.includes('shusha') ||
      lower.includes('shree') ||
      lower.includes('aps');

    if (isDingbatOrSymbolFamily(fontData.baseFont)) {
      family = '"Segoe UI Symbol", "Apple Symbols", "Noto Sans Symbols", sans-serif';
      weight = 'normal';
      style = 'normal';
    } else if (isIndic) {
      family = `${INDIC_FONT_FALLBACKS}`;
    } else if (fontData.fontBytes && stripped) {
      // Embedded face already carries weight/style. Applying CSS bold/italic
      // on top synthesizes extra stroke and breaks measureText vs PDF Widths
      // (classic Acrobat vs canvas mismatch). Only use CSS weight when the
      // FontFace failed to load and we fall back to a system family.
      // FontDescriptor /Flags: bit 1 FixedPitch, bit 2 Serif. A face that says
      // it is neither (e.g. Mukta) falls back to a sans family, so glyphs the
      // subset lacks don't switch to a serif face mid-word (BE-207).
      const flags = fontData.flags;
      const declaredSans = flags !== undefined && (flags & 0b11) === 0;
      let fallback = declaredSans
        ? `Helvetica, Arial, sans-serif, ${INDIC_FONT_FALLBACKS}`
        : `serif, ${INDIC_FONT_FALLBACKS}`;
      if (lower.includes('courier') || lower.includes('mono') || lower.includes('cumberland')) {
        fallback = `"Courier New", Courier, monospace, ${INDIC_FONT_FALLBACKS}`;
      } else if (lower.includes('helv') || lower.includes('arial') || lower.includes('sans') || lower.includes('albany')) {
        fallback = `Helvetica, Arial, ${INDIC_FONT_FALLBACKS}`;
      } else if (
        lower.includes('times') || lower.includes('roman') ||
        lower.includes('serif') || lower.includes('cmr') || lower.includes('ptm') || lower.includes('thorndale')
      ) {
        fallback = `"Times New Roman", Times, "Noto Serif Devanagari", ${INDIC_FONT_FALLBACKS}`;
      }
      const rawStripped = stripFontSubsetPrefix(fontData.baseFont);
      family = `"${stripped}", "${rawStripped}", "${fontData.baseFont}", ${fallback}`;

      // Only drop CSS weight/style when WE successfully registered this face.
      // document.fonts.check() alone is a false positive (system font with a
      // similar name) and caused certificate bold text to render regular.
      const faceReady =
        loadedFontFaces.has(stripped) ||
        loadedFontFaces.has(rawStripped) ||
        loadedFontFaces.has(fontData.baseFont);
      if (faceReady) {
        weight = 'normal';
        style = 'normal';
      }
    } else if (fontData.standardMetrics) {
      family = `${fontData.standardMetrics.cssFamily}, ${INDIC_FONT_FALLBACKS}`;
      if (isDingbatOrSymbolFamily(fontData.baseFont)) {
        family = '"Segoe UI Symbol", "Apple Symbols", "Noto Sans Symbols", sans-serif';
      }
    } else if (isDingbatOrSymbolFamily(fontData.baseFont)) {
      family = '"Segoe UI Symbol", "Apple Symbols", "Noto Sans Symbols", sans-serif';
    } else if (lower.includes('courier') || lower.includes('mono') || lower.includes('cmtt') || lower.includes('lmtt') || lower.includes('cumberland')) {
      family = `"Courier New", Courier, monospace, ${INDIC_FONT_FALLBACKS}`;
    } else if (
      lower.includes('times') || lower.includes('roman') ||
      lower.includes('cmr') || lower.includes('lmr') || lower.includes('ptm') || lower.includes('thorndale')
    ) {
      family = `"Times New Roman", Times, "Noto Serif Devanagari", ${INDIC_FONT_FALLBACKS}`;
    } else if (lower.includes('helv') || lower.includes('arial') || lower.includes('cms') || lower.includes('lmss') || lower.includes('albany')) {
      family = `Helvetica, Arial, ${INDIC_FONT_FALLBACKS}`;
    } else if (stripped) {
      family = `"${stripped}", serif, ${INDIC_FONT_FALLBACKS}`;
    }
  } else {
    family = `${getCSSFontFamily(fontName)}, ${INDIC_FONT_FALLBACKS}`;
  }

  return { family, weight, style };
}

/**
 * Build a CSS font string for canvas rendering.
 * Takes into account the text matrix scaling to get the right visual size.
 */
function buildCanvasFont(
  fontName: string,
  fontSize: number,
  textMatrix: { a: number; b: number; c: number; d: number },
  fontData?: FontData,
): string {
  // Compute effective font size from the text matrix
  const scaleY = Math.sqrt(textMatrix.b * textMatrix.b + textMatrix.d * textMatrix.d);
  const effectiveSize = Math.abs(fontSize * scaleY) || fontSize;

  const { family, weight, style } = getCanvasFontProperties(fontName, fontData);

  // Canvas font format: "style weight size family"
  return `${style} ${weight} ${effectiveSize}px ${family}`;
}

// ─── Image rendering ────────────────────────────────────────────────────────

async function drawImage(
  ctx: CanvasRenderingContext2D,
  item: ImageItem,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  maskMap: Map<PDFDict, HTMLCanvasElement> = new Map(),
): Promise<void> {
  // Get the image XObject
  const xobj = getResource(page.resources, 'XObject', item.name, objects);
  if (!(xobj instanceof PDFStream)) return;

  const decoded = await decodeImage(xobj, objects);
  if (!decoded) return;

  const bounds = { x: item.x, y: item.y, width: item.width, height: item.height };

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const imageData = new ImageData(decoded.data as any, decoded.width, decoded.height);

    drawWithSoftMask(ctx, item.softMask, maskMap, bounds, () => {
      ctx.save();
      ctx.globalCompositeOperation = toCanvasBlendMode(item.blendMode);
      applyClipPaths(ctx, item.clipPaths);

      ctx.transform(
        item.ctm.a, item.ctm.b,
        item.ctm.c, item.ctm.d,
        item.ctm.e, item.ctm.f,
      );

      const tmpCanvas = new OffscreenCanvas(decoded.width, decoded.height);
      const tmpCtx = tmpCanvas.getContext('2d')!;
      tmpCtx.putImageData(imageData, 0, 0);

      ctx.scale(1 / decoded.width, -1 / decoded.height);
      ctx.translate(0, -decoded.height);
      ctx.drawImage(tmpCanvas, 0, 0);
      ctx.restore();
    });
  } catch (e) {
    console.warn(`[Renderer] Failed to draw image ${item.name}:`, e);
  }
}

// ─── Convenience: render PDF bytes to canvas directly ───────────────────────

/**
 * Parse raw PDF bytes and render a page to canvas in one call.
 * This is the simplest entry point for rendering.
 */
export async function renderPDFPage(
  pdfBytes: Uint8Array,
  pageIndex: number = 0,
  scale: number = 1.5,
): Promise<RenderResult> {
  const doc = await parsePDF(pdfBytes);
  return renderPage(doc, pageIndex, { scale });
}

/**
 * Render all pages of a PDF document.
 */
export async function renderAllPages(
  doc: PDFDocumentData,
  options: RenderOptions,
): Promise<RenderResult[]> {
  const results: RenderResult[] = [];
  for (let i = 0; i < doc.pages.length; i++) {
    const result = await renderPage(doc, i, options);
    results.push(result);
  }
  return results;
}

/** Successfully registered embedded FontFace family names. */
const loadedFontFaces = new Set<string>();
/** Family names that failed to load (avoid retrying on every frame). */
const failedFontFaces = new Set<string>();

async function registerEmbeddedFonts(fonts: Map<string, FontData>): Promise<void> {
  const promises: Promise<void>[] = [];
  const registered = new Set<string>();

  for (const [, fontData] of fonts.entries()) {
    if (!fontData.fontBytes || !fontData.baseFont) continue;
    if (!isTrueTypeFontData(fontData.fontBytes)) continue;
    // Symbol/ZapfDingbats: canvas uses system symbol fonts + remapped Unicode
    if (isDingbatOrSymbolFamily(fontData.baseFont)) continue;

    const names = new Set<string>();
    names.add(fontData.baseFont);
    const stripped = stripFontSubsetPrefix(fontData.baseFont);
    if (stripped) names.add(stripped);
    const cssName = cssFontFamilyName(fontData.baseFont);
    if (cssName) names.add(cssName);

    for (const familyName of names) {
      if (
        registered.has(familyName) ||
        loadedFontFaces.has(familyName) ||
        failedFontFaces.has(familyName)
      ) {
        continue;
      }

      registered.add(familyName);

      // Always register embedded bytes. document.fonts.check() is a false
      // positive for names like "Times New Roman" / "Calibri" and would skip
      // loading the PDF's bold subset, then mark the face "ready" at weight
      // normal — certificate labels render regular.
      try {
        const fontFace = new FontFace(familyName, fontData.fontBytes.buffer.slice(
          fontData.fontBytes.byteOffset,
          fontData.fontBytes.byteOffset + fontData.fontBytes.byteLength,
        ) as ArrayBuffer);
        const p = fontFace.load().then((loadedFace) => {
          document.fonts.add(loadedFace);
          loadedFontFaces.add(familyName);
        }).catch((e) => {
          failedFontFaces.add(familyName);
          console.debug?.(`[Renderer] Embedded font face not loaded for "${familyName}", using system fallback:`, e);
        });
        promises.push(p);
      } catch (e) {
        failedFontFaces.add(familyName);
        console.debug?.(`[Renderer] Failed to construct font face for "${familyName}":`, e);
      }
    }
  }

  if (promises.length > 0) {
    await Promise.all(promises);
  }
}

// ─── Canvas Pool ────────────────────────────────────────────────────────────

class CanvasPool {
  private static pool: HTMLCanvasElement[] = [];

  static acquire(width: number, height: number): HTMLCanvasElement {
    const canvas = this.pool.pop() || document.createElement('canvas');
    canvas.width = Math.ceil(width);
    canvas.height = Math.ceil(height);
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return canvas;
  }

  static release(canvas: HTMLCanvasElement) {
    this.pool.push(canvas);
  }
}

// ─── Form rendering ─────────────────────────────────────────────────────────

async function drawFormItem(
  ctx: CanvasRenderingContext2D,
  item: FormItem,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  options: RenderOptions,
): Promise<void> {
  const xobj = getResource(page.resources, 'XObject', item.name, objects);
  if (!(xobj instanceof PDFStream)) return;

  ctx.save();
  ctx.globalCompositeOperation = toCanvasBlendMode(item.blendMode);
  applyClipPaths(ctx, item.clipPaths);

  // Apply the CTM from the item which positioned the form
  ctx.transform(
    item.ctm.a, item.ctm.b,
    item.ctm.c, item.ctm.d,
    item.ctm.e, item.ctm.f,
  );

  await drawFormXObject(ctx, xobj, objects, page, options);
  
  ctx.restore();
}

async function drawFormXObject(
  ctx: CanvasRenderingContext2D,
  formStream: PDFStream,
  objects: Map<string, PDFObject>,
  parentPage: PDFPageInfo,
  options: RenderOptions,
  activeFormRefs: Set<number> = new Set()
): Promise<void> {
  const objNum = formStream.dict.getNumber('ObjNum') || 0;
  if (activeFormRefs.has(objNum)) {
    console.warn("Circular Form XObject reference detected. Breaking recursion.");
    return;
  }
  if (objNum !== 0) activeFormRefs.add(objNum);

  const dict = formStream.dict;
  const bboxArr = dict.getArray('BBox')?.asNumbers() || [0, 0, 0, 0];
  const matrixArr = dict.getArray('Matrix')?.asNumbers() || [1, 0, 0, 1, 0, 0];

  const groupDict = dict.getDict('Group');
  const isTransparencyGroup = groupDict !== undefined && groupDict.getName('S') === 'Transparency';
  const isolated = groupDict?.getBool('I') ?? false;

  ctx.save();

  // 1. Apply Form Matrix
  ctx.transform(matrixArr[0], matrixArr[1], matrixArr[2], matrixArr[3], matrixArr[4], matrixArr[5]);

  // 2. Clip to BBox
  ctx.beginPath();
  ctx.rect(bboxArr[0], bboxArr[1], bboxArr[2] - bboxArr[0], bboxArr[3] - bboxArr[1]);
  ctx.clip();

  // 3. Resolve Resources (fallback to parent page resources if absent)
  const formResourcesRef = dict.get('Resources');
  let formResources = parentPage.resources;
  if (formResourcesRef) {
     const resolved = resolveRef(formResourcesRef, objects);
     if (resolved instanceof PDFDict) formResources = resolved;
  }

  // 4. Decode content stream
  if (!formStream.decodedBytes) {
    const { applyFilters } = await import('../parser/filters');
    formStream.decodedBytes = await applyFilters(
      formStream.rawBytes,
      formStream.getFilters(),
      formStream.getDecodeParams()
    );
  }

  // 5. Interpret and Render
  const formPageMock: PDFPageInfo = {
    ...parentPage,
    resources: formResources,
  };

  let targetCtx = ctx;
  let offscreenCanvas: HTMLCanvasElement | null = null;
  const width = bboxArr[2] - bboxArr[0];
  const height = bboxArr[3] - bboxArr[1];

  if (isTransparencyGroup && isolated && width > 0 && height > 0) {
    offscreenCanvas = CanvasPool.acquire(width, height);
    targetCtx = offscreenCanvas.getContext('2d')!;
    targetCtx.save();
    targetCtx.translate(-bboxArr[0], -bboxArr[1]); // Normalize to local origin
  }

  const formInterpreted = interpretPage(formStream.getBytes(), formPageMock, objects);
  const formFonts = loadPageFonts(formResources, objects);

  const renderPaths = options.renderPaths ?? true;
  const renderText = options.renderText ?? true;
  const renderImages = options.renderImages ?? true;

  for (const item of formInterpreted.displayList) {
    switch (item.type) {
      case 'path':
        if (renderPaths) drawPath(targetCtx, item);
        break;
      case 'text':
        if (renderText) drawTextRun(targetCtx, item, formFonts);
        break;
      case 'image':
        if (renderImages) await drawImage(targetCtx, item, formPageMock, objects);
        break;
      case 'form':
        await drawFormItem(targetCtx, item, formPageMock, objects, options);
        break;
      case 'shading':
        if (renderImages) drawShadingItem(targetCtx, item, formPageMock, objects);
        break;
    }
  }

  if (offscreenCanvas) {
    targetCtx.restore(); // Restore the translate
    ctx.save();
    ctx.drawImage(offscreenCanvas, bboxArr[0], bboxArr[1]);
    ctx.restore();
    CanvasPool.release(offscreenCanvas);
  }

  ctx.restore();
  if (objNum !== 0) activeFormRefs.delete(objNum);
}

// ─── Shading rendering ──────────────────────────────────────────────────────

function drawShadingItem(
  ctx: CanvasRenderingContext2D,
  item: ShadingItem,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
): void {
  const shadingDict = getResource(page.resources, 'Shading', item.name, objects);
  if (!(shadingDict instanceof PDFDict)) return;

  const shadingType = shadingDict.getNumber('ShadingType');
  const colorSpace = shadingDict.get('ColorSpace');

  ctx.save();
  ctx.globalCompositeOperation = toCanvasBlendMode(item.blendMode);
  applyClipPaths(ctx, item.clipPaths);

  ctx.transform(
    item.ctm.a, item.ctm.b,
    item.ctm.c, item.ctm.d,
    item.ctm.e, item.ctm.f,
  );

  if (shadingType === 2) {
    // Type 2: Axial Shading
    const coords = shadingDict.getArray('Coords')?.asNumbers() || [0, 0, 1, 0];
    const funcRef = shadingDict.get('Function');
    const functionObj = funcRef ? resolveRef(funcRef, objects) : undefined;
    
    const grad = ctx.createLinearGradient(coords[0], coords[1], coords[2], coords[3]);
    
    // Basic fallback/stub for exponential functions mapping 0->1
    if (functionObj instanceof PDFDict) {
      const c0 = functionObj.getArray('C0')?.asNumbers() || [0, 0, 0];
      const c1 = functionObj.getArray('C1')?.asNumbers() || [1, 1, 1];
      
      const r0 = Math.min(255, Math.max(0, Math.round(c0[0] * 255)));
      const g0 = Math.min(255, Math.max(0, Math.round(c0[1] * 255)));
      const b0 = Math.min(255, Math.max(0, Math.round(c0[2] * 255)));
      
      const r1 = Math.min(255, Math.max(0, Math.round(c1[0] * 255)));
      const g1 = Math.min(255, Math.max(0, Math.round(c1[1] * 255)));
      const b1 = Math.min(255, Math.max(0, Math.round(c1[2] * 255)));

      grad.addColorStop(0, `rgb(${r0}, ${g0}, ${b0})`);
      grad.addColorStop(1, `rgb(${r1}, ${g1}, ${b1})`);
    } else {
      grad.addColorStop(0, '#000');
      grad.addColorStop(1, '#FFF');
    }

    ctx.fillStyle = grad;
    // Fill a sufficiently large area to cover the clipping region
    ctx.fillRect(-10000, -10000, 20000, 20000);
  } else {
    console.warn(`[Renderer] ShadingType ${shadingType} not fully implemented. ColorSpace:`, colorSpace);
  }
  
  ctx.restore();
}

