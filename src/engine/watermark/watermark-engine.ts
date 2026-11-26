/**
 * Watermark Engine — Core
 *
 * Provides the ability to add watermarks to PDF pages. Watermarks can be:
 *   - Text watermarks (diagonal, horizontal, tiled)
 *   - Image watermarks (logos, stamps)
 *   - Pattern watermarks (repeating text/images)
 *
 * Watermarks are injected directly into the page's content stream as
 * PDF graphics operators, making them real PDF content (not annotations).
 * This ensures they render correctly in any PDF viewer and survive
 * document processing.
 *
 * The engine supports:
 *   - Opacity/transparency control
 *   - Rotation and positioning
 *   - Tiling/repeating patterns
 *   - Layering (above or below existing content)
 *   - Font selection and sizing
 */

import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFPageInfo,
} from '../types';
import { resolveRef } from '../parser/parser';
import { flateEncode } from '../parser/filters';
import { rasterLineImage, type RasterTextLine } from '../forms/text-appearance';

// ─── Watermark types ────────────────────────────────────────────────────────

export type WatermarkType = 'text' | 'image' | 'pattern' | 'shape';

export interface WatermarkBase {
  /** Unique identifier for this watermark */
  id: string;
  /** Type of watermark */
  type: WatermarkType;
  /** Opacity (0-1, where 1 = fully opaque) */
  opacity: number;
  /** Rotation angle in degrees (counter-clockwise) */
  rotation: number;
  /** Whether to tile/repeat across the page */
  tile: boolean;
  /** Layer: 'above' draws over content, 'below' draws under content */
  layer: 'above' | 'below';
  /** Page indices to apply to (empty = all pages) */
  pageIndices?: number[];
  /** Blend mode (e.g. 'Normal', 'Multiply', etc.) */
  blendMode?: string;
}

export interface TextWatermark extends WatermarkBase {
  type: 'text';
  /** The text to render as watermark */
  text: string;
  /** Font name (e.g., 'Helvetica', 'Times-Roman', 'Courier') */
  fontName: string;
  /** Font size in points */
  fontSize: number;
  /** Text color as RGB (0-1) */
  color: [number, number, number];
  /** Position: 'center', 'top-left', 'top-right', 'bottom-left', 'bottom-right', or custom [x, y] */
  position: WatermarkPosition | [number, number];
  /** Spacing between tiles when tiling (in points) */
  tileSpacing?: number;
  /**
   * The text pre-shaped by the host as an image, for text the standard fonts
   * can't encode (Hindi, CJK…). Drawn instead of `text` when present.
   */
  raster?: RasterTextLine;
}

export interface ImageWatermark extends WatermarkBase {
  type: 'image';
  /** Raw image bytes (JPEG or PNG) */
  imageBytes: Uint8Array;
  /** Image MIME type */
  mimeType: 'image/jpeg' | 'image/png';
  /**
   * Transparency of the image as 8-bit coverage samples (Flate-compressed
   * `data`, plus the decoded `samples`), written as the image's /SMask.
   */
  softMask?: { widthPx: number; heightPx: number; data: Uint8Array; samples: Uint8Array };
  /** Width in PDF points (user space units) */
  width: number;
  /** Height in PDF points */
  height: number;
  /** Position */
  position: WatermarkPosition | [number, number];
  /** Tile spacing */
  tileSpacing?: number;
}

export interface PatternWatermark extends WatermarkBase {
  type: 'pattern';
  /** The text to repeat */
  text: string;
  /** Font name */
  fontName: string;
  /** Font size */
  fontSize: number;
  /** Color */
  color: [number, number, number];
  /** Horizontal spacing between repeats */
  hSpacing: number;
  /** Vertical spacing between repeats */
  vSpacing: number;
  /** Stagger offset for alternating rows */
  stagger?: number;
}

export type WatermarkPosition =
  | 'center'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'
  | 'top-center'
  | 'bottom-center'
  | 'center-left'
  | 'center-right';

export interface ShapeWatermark extends WatermarkBase {
  type: 'shape';
  shape: 'rectangle' | 'circle' | 'pill';
  text: string;
  fontName: string;
  fontSize: number;
  textColor: [number, number, number];
  shapeColor: [number, number, number];
  position: WatermarkPosition | [number, number];
  width: number;
  height: number;
  tileSpacing?: number;
  /** Pre-shaped text image, as for {@link TextWatermark.raster}. */
  raster?: RasterTextLine;
}

export type Watermark = TextWatermark | ImageWatermark | PatternWatermark | ShapeWatermark;

// ─── Watermark application ──────────────────────────────────────────────────

/**
 * Generate PDF content stream operators for a text watermark.
 * Returns the raw content bytes to inject into the page stream.
 */
export function buildTextWatermarkContent(
  wm: TextWatermark,
  pageWidth: number,
  pageHeight: number,
  originX: number = 0,
  originY: number = 0,
): Uint8Array {
  const lines: string[] = [];
  lines.push('q');

  if (wm.opacity < 1 || (wm.blendMode && wm.blendMode !== 'Normal')) {
    lines.push(`/${getExtGStateName(wm.id)} gs`);
  }

  const [r, g, b] = wm.color;
  lines.push(`${fmtNum(r)} ${fmtNum(g)} ${fmtNum(b)} rg`);
  lines.push(`${fmtNum(r)} ${fmtNum(g)} ${fmtNum(b)} RG`);

  lines.push(`/${wm.fontName} ${wm.fontSize} Tf`);

  const wmWidth = wm.raster ? wm.raster.advancePt : wm.text.length * wm.fontSize * 0.5;
  const wmHeight = wm.fontSize;

  if (wm.tile) {
    const spacing = wm.tileSpacing || 300;
    const cols = Math.ceil(pageWidth / spacing) + 1;
    const rows = Math.ceil(pageHeight / spacing) + 1;

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const cx = originX + col * spacing;
        const cy = originY + row * spacing;

        lines.push('q');
        lines.push(`1 0 0 1 ${fmtNum(cx)} ${fmtNum(cy)} cm`);
        if (wm.rotation !== 0) {
          const rad = (wm.rotation * Math.PI) / 180;
          const cos = Math.cos(rad);
          const sin = Math.sin(rad);
          lines.push(`${fmtNum(cos)} ${fmtNum(sin)} ${fmtNum(-sin)} ${fmtNum(cos)} 0 0 cm`);
        }
        lines.push(...watermarkTextOps(wm, -wmWidth / 2, -wmHeight * 0.3));
        lines.push('Q');
      }
    }
  } else {
    const { cx, cy } = resolvePosition(wm.position, pageWidth, pageHeight, wmWidth, wmHeight, originX, originY);

    lines.push('q');
    lines.push(`1 0 0 1 ${fmtNum(cx)} ${fmtNum(cy)} cm`);

    if (wm.rotation !== 0) {
      const rad = (wm.rotation * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      lines.push(`${fmtNum(cos)} ${fmtNum(sin)} ${fmtNum(-sin)} ${fmtNum(cos)} 0 0 cm`);
    }

    lines.push(...watermarkTextOps(wm, -wmWidth / 2, -wmHeight * 0.3));
    lines.push('Q');
  }

  lines.push('Q');
  return stringToBytes(lines.join('\n') + '\n');
}

/**
 * XObject name of a watermark's pre-shaped text image. The ImWM_ prefix is
 * what the watermark remover recognises as ours.
 */
export function watermarkTextImageName(wm: { id: string }): string {
  return `ImWM_${wm.id.substring(0, 8).replace(/[^A-Za-z0-9_-]/g, '_')}_tx`;
}

/** Operators that draw a watermark's text with its baseline starting at (x, y). */
function watermarkTextOps(
  wm: { id: string; text: string; raster?: RasterTextLine },
  x: number,
  y: number,
): string[] {
  const r = wm.raster;
  if (r) {
    return [`q ${fmtNum(r.widthPt)} 0 0 ${fmtNum(r.heightPt)} ${fmtNum(x)} ${fmtNum(y - r.baselinePt)} cm /${watermarkTextImageName(wm)} Do Q`];
  }
  return ['BT', `${fmtNum(x)} ${fmtNum(y)} Td`, `(${escapePDFString(wm.text)}) Tj`, 'ET'];
}

/**
 * Generate PDF content stream operators for an image watermark.
 */
export function buildImageWatermarkContent(
  wm: ImageWatermark,
  pageWidth: number,
  pageHeight: number,
  imageXObjectName: string,
  originX: number = 0,
  originY: number = 0,
): Uint8Array {
  const lines: string[] = [];
  lines.push('q');

  if (wm.opacity < 1 || (wm.blendMode && wm.blendMode !== 'Normal')) {
    lines.push(`/${getExtGStateName(wm.id)} gs`);
  }

  if (wm.tile) {
    const spacing = wm.tileSpacing || 300;
    const cols = Math.ceil(pageWidth / spacing) + 1;
    const rows = Math.ceil(pageHeight / spacing) + 1;

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const cx = originX + col * spacing;
        const cy = originY + row * spacing;

        lines.push('q');
        lines.push(`1 0 0 1 ${fmtNum(cx)} ${fmtNum(cy)} cm`);
        if (wm.rotation !== 0) {
          const rad = (wm.rotation * Math.PI) / 180;
          const cos = Math.cos(rad);
          const sin = Math.sin(rad);
          lines.push(`${fmtNum(cos)} ${fmtNum(sin)} ${fmtNum(-sin)} ${fmtNum(cos)} 0 0 cm`);
        }
        lines.push(`${fmtNum(wm.width)} 0 0 ${fmtNum(wm.height)} ${fmtNum(-wm.width / 2)} ${fmtNum(-wm.height / 2)} cm`);
        lines.push(`/${imageXObjectName} Do`);
        lines.push('Q');
      }
    }
  } else {
    const { cx, cy } = resolvePosition(wm.position, pageWidth, pageHeight, wm.width, wm.height, originX, originY);

    lines.push(`1 0 0 1 ${fmtNum(cx)} ${fmtNum(cy)} cm`);
    if (wm.rotation !== 0) {
      const rad = (wm.rotation * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      lines.push(`${fmtNum(cos)} ${fmtNum(sin)} ${fmtNum(-sin)} ${fmtNum(cos)} 0 0 cm`);
    }
    lines.push(`${fmtNum(wm.width)} 0 0 ${fmtNum(wm.height)} ${fmtNum(-wm.width / 2)} ${fmtNum(-wm.height / 2)} cm`);
    lines.push(`/${imageXObjectName} Do`);
  }

  lines.push('Q');

  return stringToBytes(lines.join('\n') + '\n');
}

/**
 * Generate PDF content stream operators for a pattern watermark.
 */
export function buildPatternWatermarkContent(
  wm: PatternWatermark,
  pageWidth: number,
  pageHeight: number,
  originX: number = 0,
  originY: number = 0,
): Uint8Array {
  const lines: string[] = [];

  lines.push('q');

  if (wm.opacity < 1 || (wm.blendMode && wm.blendMode !== 'Normal')) {
    lines.push(`/${getExtGStateName(wm.id)} gs`);
  }

  const [r, g, b] = wm.color;
  lines.push(`${fmtNum(r)} ${fmtNum(g)} ${fmtNum(b)} rg`);
  lines.push(`/${wm.fontName} ${wm.fontSize} Tf`);

  const cols = Math.ceil(pageWidth / wm.hSpacing) + 1;
  const rows = Math.ceil(pageHeight / wm.vSpacing) + 1;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      let x = originX + col * wm.hSpacing;
      const y = originY + row * wm.vSpacing;

      // Apply stagger for alternating rows
      if (wm.stagger && row % 2 === 1) {
        x += wm.stagger;
      }

      lines.push('BT');
      lines.push(`${fmtNum(x)} ${fmtNum(y)} Td`);
      if (wm.rotation !== 0) {
        const rad = (wm.rotation * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        lines.push(`${fmtNum(cos)} ${fmtNum(sin)} ${fmtNum(-sin)} ${fmtNum(cos)} 0 0 Tm`);
      }
      lines.push(`(${escapePDFString(wm.text)}) Tj`);
      lines.push('ET');
    }
  }

  lines.push('Q');

  return stringToBytes(lines.join('\n') + '\n');
}

/**
 * Generate PDF content stream operators for a shape watermark.
 */
export function buildShapeWatermarkContent(
  wm: ShapeWatermark,
  pageWidth: number,
  pageHeight: number,
  originX: number = 0,
  originY: number = 0,
): Uint8Array {
  const lines: string[] = [];
  lines.push('q');

  if (wm.opacity < 1 || (wm.blendMode && wm.blendMode !== 'Normal')) {
    lines.push(`/${getExtGStateName(wm.id)} gs`);
  }

  const cxs: number[] = [];
  const cys: number[] = [];

  if (wm.tile) {
    const spacing = wm.tileSpacing || 300;
    const cols = Math.ceil(pageWidth / spacing) + 1;
    const rows = Math.ceil(pageHeight / spacing) + 1;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        cxs.push(originX + col * spacing);
        cys.push(originY + row * spacing);
      }
    }
  } else {
    const pos = resolvePosition(wm.position, pageWidth, pageHeight, wm.width, wm.height, originX, originY);
    cxs.push(pos.cx);
    cys.push(pos.cy);
  }

  for (let i = 0; i < cxs.length; i++) {
    const cx = cxs[i];
    const cy = cys[i];
    
    lines.push('q');
    lines.push(`1 0 0 1 ${fmtNum(cx)} ${fmtNum(cy)} cm`);
    if (wm.rotation !== 0) {
      const rad = (wm.rotation * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      lines.push(`${fmtNum(cos)} ${fmtNum(sin)} ${fmtNum(-sin)} ${fmtNum(cos)} 0 0 cm`);
    }

    // Draw Shape
    const [sr, sg, sb] = wm.shapeColor;
    lines.push(`${fmtNum(sr)} ${fmtNum(sg)} ${fmtNum(sb)} RG`);
    lines.push('2 w');
    
    const hw = wm.width / 2;
    const hh = wm.height / 2;

    if (wm.shape === 'rectangle') {
      lines.push(`${fmtNum(-hw)} ${fmtNum(-hh)} ${fmtNum(wm.width)} ${fmtNum(wm.height)} re`);
      lines.push('S');
    } else if (wm.shape === 'circle') {
      const rx = hw;
      const ry = hh;
      const k = 0.5522847498;
      const kx = rx * k;
      const ky = ry * k;
      
      lines.push(`${fmtNum(rx)} 0 m`);
      lines.push(`${fmtNum(rx)} ${fmtNum(ky)} ${fmtNum(kx)} ${fmtNum(ry)} 0 ${fmtNum(ry)} c`);
      lines.push(`${fmtNum(-kx)} ${fmtNum(ry)} ${fmtNum(-rx)} ${fmtNum(ky)} ${fmtNum(-rx)} 0 c`);
      lines.push(`${fmtNum(-rx)} ${fmtNum(-ky)} ${fmtNum(-kx)} ${fmtNum(-ry)} 0 ${fmtNum(-ry)} c`);
      lines.push(`${fmtNum(kx)} ${fmtNum(-ry)} ${fmtNum(rx)} ${fmtNum(-ky)} ${fmtNum(rx)} 0 c`);
      lines.push('s');
    } else if (wm.shape === 'pill') {
      const x = -hw;
      const y = -hh;
      const w = wm.width;
      const h = wm.height;
      const r = Math.min(hw, hh);
      const k = r * 0.5522847498;
      
      lines.push(`${fmtNum(x + r)} ${fmtNum(y)} m`);
      lines.push(`${fmtNum(x + w - r)} ${fmtNum(y)} l`);
      lines.push(`${fmtNum(x + w - r + k)} ${fmtNum(y)} ${fmtNum(x + w)} ${fmtNum(y + r - k)} ${fmtNum(x + w)} ${fmtNum(y + r)} c`);
      lines.push(`${fmtNum(x + w)} ${fmtNum(y + h - r)} l`);
      lines.push(`${fmtNum(x + w)} ${fmtNum(y + h - r + k)} ${fmtNum(x + w - r + k)} ${fmtNum(y + h)} ${fmtNum(x + w - r)} ${fmtNum(y + h)} c`);
      lines.push(`${fmtNum(x + r)} ${fmtNum(y + h)} l`);
      lines.push(`${fmtNum(x + r - k)} ${fmtNum(y + h)} ${fmtNum(x)} ${fmtNum(y + h - r + k)} ${fmtNum(x)} ${fmtNum(y + h - r)} c`);
      lines.push(`${fmtNum(x)} ${fmtNum(y + r)} l`);
      lines.push(`${fmtNum(x)} ${fmtNum(y + r - k)} ${fmtNum(x + r - k)} ${fmtNum(y)} ${fmtNum(x + r)} ${fmtNum(y)} c`);
      lines.push('s');
    }

    if (wm.text) {
      const [tr, tg, tb] = wm.textColor;
      lines.push(`${fmtNum(tr)} ${fmtNum(tg)} ${fmtNum(tb)} rg`);
      lines.push(`/${wm.fontName} ${wm.fontSize} Tf`);
      
      const textWidth = wm.raster ? wm.raster.advancePt : wm.text.length * wm.fontSize * 0.5;
      const textHeight = wm.fontSize;

      lines.push(...watermarkTextOps(wm, -textWidth / 2, -textHeight * 0.3));
    }

    lines.push('Q');
  }

  lines.push('Q');
  return stringToBytes(lines.join('\n') + '\n');
}

/**
 * Create an ExtGState dictionary for opacity control.
 * Returns the dictionary and its name.
 */
export function createOpacityExtGState(
  opacity: number,
  gsName: string,
  blendMode: string = 'Normal',
): { dict: PDFDict; name: string } {
  const dict = new PDFDict();
  dict.set('Type', new PDFName('ExtGState'));
  dict.set('ca', new PDFNumber(opacity));   // non-stroking alpha
  dict.set('CA', new PDFNumber(opacity));   // stroking alpha
  dict.set('BM', new PDFName(blendMode));

  return { dict, name: gsName };
}

/** Pixel size from a JPEG's SOFn header, or null when it can't be read. */
export function jpegPixelSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (bytes[i + 5] << 8) | bytes[i + 6];
      const width = (bytes[i + 7] << 8) | bytes[i + 8];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += 2 + len;
  }
  return null;
}

/**
 * Create an Image XObject for an image watermark.
 */
export function createWatermarkImageXObject(
  wm: ImageWatermark,
): { stream: PDFStream; name: string } {
  const dict = new PDFDict();
  dict.set('Type', new PDFName('XObject'));
  dict.set('Subtype', new PDFName('Image'));
  // /Width and /Height are the image's pixel size (wm.width/height are its
  // size on the page, in points); readers mis-decode the samples otherwise.
  const px = (wm.mimeType === 'image/jpeg' ? jpegPixelSize(wm.imageBytes) : null)
    ?? (wm.softMask ? { width: wm.softMask.widthPx, height: wm.softMask.heightPx } : null)
    ?? { width: Math.round(wm.width), height: Math.round(wm.height) };
  dict.set('Width', new PDFNumber(px.width));
  dict.set('Height', new PDFNumber(px.height));
  dict.set('ColorSpace', new PDFName('DeviceRGB'));
  dict.set('BitsPerComponent', new PDFNumber(8));

  if (wm.mimeType === 'image/jpeg') {
    dict.set('Filter', new PDFName('DCTDecode'));
  } else {
    dict.set('Filter', new PDFName('FlateDecode'));
    // For PNG we'd need to decode first — simplified here
  }

  dict.set('Length', new PDFNumber(wm.imageBytes.length));

  const stream = new PDFStream(dict, wm.imageBytes);
  const name = `/ImWM_${wm.id.substring(0, 8)}`;

  return { stream, name };
}

/**
 * Apply a watermark to a page's content stream.
 *
 * @param contentBytes Original decoded content stream bytes
 * @param page Page info for accessing resources
 * @param objects Document object map (will be mutated with new resources)
 * @param watermark The watermark to apply
 * @param pageWidth Page width in PDF points
 * @param pageHeight Page height in PDF points
 * @param getNextObjNum Function to get the next available object number
 * @param originX MediaBox lower-left X (default 0)
 * @param originY MediaBox lower-left Y (default 0)
 * @returns Modified content stream bytes
 */
export function applyWatermarkToPage(
  contentBytes: Uint8Array,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  watermark: Watermark,
  pageWidth: number,
  pageHeight: number,
  getNextObjNum: () => number,
  originX: number = 0,
  originY: number = 0,
): Uint8Array {
  let watermarkContent: Uint8Array;
  const needsExtGState = watermark.opacity < 1 || (watermark.blendMode !== undefined && watermark.blendMode !== 'Normal');
  const needsImageXObject = watermark.type === 'image';

  // Build the watermark content operators (positions relative to MediaBox origin)
  switch (watermark.type) {
    case 'text':
      registerFontInResources(page, objects, watermark.fontName, getNextObjNum);
      registerTextRaster(page, objects, watermark, getNextObjNum);
      watermarkContent = buildTextWatermarkContent(watermark, pageWidth, pageHeight, originX, originY);
      break;
    case 'image': {
      const imgWm = watermark as ImageWatermark;
      const { stream, name } = createWatermarkImageXObject(imgWm);
      if (imgWm.softMask) {
        const m = imgWm.softMask;
        const maskDict = new PDFDict();
        maskDict.set('Type', new PDFName('XObject'));
        maskDict.set('Subtype', new PDFName('Image'));
        maskDict.set('Width', new PDFNumber(m.widthPx));
        maskDict.set('Height', new PDFNumber(m.heightPx));
        maskDict.set('ColorSpace', new PDFName('DeviceGray'));
        maskDict.set('BitsPerComponent', new PDFNumber(8));
        maskDict.set('Filter', new PDFName('FlateDecode'));
        maskDict.set('Length', new PDFNumber(m.data.length));
        const maskRef = new PDFRef(getNextObjNum(), 0);
        objects.set(maskRef.toKey(), new PDFStream(maskDict, m.data, m.samples));
        stream.dict.set('SMask', maskRef);
      }
      const objNum = getNextObjNum();
      const objRef = new PDFRef(objNum, 0);
      objects.set(objRef.toKey(), stream);

      // Register in page Resources
      registerXObjectInResources(page, objects, name.replace('/', ''), objRef);

      // `name` carries a leading slash; the content builder adds its own.
      watermarkContent = buildImageWatermarkContent(imgWm, pageWidth, pageHeight, name.replace('/', ''), originX, originY);
      break;
    }
    case 'pattern':
      watermarkContent = buildPatternWatermarkContent(
        watermark as PatternWatermark, pageWidth, pageHeight, originX, originY,
      );
      break;
    case 'shape': {
      const shapeWm = watermark as ShapeWatermark;
      registerFontInResources(page, objects, shapeWm.fontName, getNextObjNum);
      registerTextRaster(page, objects, shapeWm, getNextObjNum);
      watermarkContent = buildShapeWatermarkContent(shapeWm, pageWidth, pageHeight, originX, originY);
      break;
    }
    default:
      watermarkContent = new Uint8Array(0);
  }

  // Create ExtGState for opacity if needed
  if (needsExtGState) {
    const gsName = getExtGStateName(watermark.id);
    const { dict } = createOpacityExtGState(watermark.opacity, gsName, watermark.blendMode || 'Normal');
    const objNum = getNextObjNum();
    const objRef = new PDFRef(objNum, 0);
    objects.set(objRef.toKey(), dict);

    registerExtGStateInResources(page, objects, gsName, objRef);
  }

  // Inject watermark into the page stream.
  //
  // Wrap the *existing* content in q/Q so any leftover CTM / graphics state
  // from the original stream is restored before (or isolated from) the
  // watermark. Many PDFs leave a non-identity CTM at end-of-stream; appending
  // without this wrap makes the watermark inherit that transform and appear
  // tilted or skewed — while other PDFs that end at identity look fine.
  const save = stringToBytes('q\n');
  const restore = stringToBytes('\nQ\n');
  const combined = new Uint8Array(
    save.length + contentBytes.length + restore.length + watermarkContent.length,
  );

  if (watermark.layer === 'below') {
    // Watermark first (clean user space), then wrapped original content
    let offset = 0;
    combined.set(watermarkContent, offset); offset += watermarkContent.length;
    combined.set(save, offset); offset += save.length;
    combined.set(contentBytes, offset); offset += contentBytes.length;
    combined.set(restore, offset);
  } else {
    // Wrapped original content, then watermark in restored user space
    let offset = 0;
    combined.set(save, offset); offset += save.length;
    combined.set(contentBytes, offset); offset += contentBytes.length;
    combined.set(restore, offset); offset += restore.length;
    combined.set(watermarkContent, offset);
  }

  return combined;
}

/** Add a watermark's pre-shaped text image (and its soft mask) to the page resources. */
function registerTextRaster(
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  wm: TextWatermark | ShapeWatermark,
  getNextObjNum: () => number,
): void {
  if (!wm.raster) return;
  const { image, smask } = rasterLineImage(wm.raster);
  const smaskRef = new PDFRef(getNextObjNum(), 0);
  objects.set(smaskRef.toKey(), smask);
  image.dict.set('SMask', smaskRef);
  const imageRef = new PDFRef(getNextObjNum(), 0);
  objects.set(imageRef.toKey(), image);
  registerXObjectInResources(page, objects, watermarkTextImageName(wm), imageRef);
}

/**
 * Apply watermarks to multiple pages.
 */
export function applyWatermarks(
  doc: { pages: PDFPageInfo[]; objects: Map<string, PDFObject> },
  watermarks: Watermark[],
  getNextObjNum: () => number,
): Map<number, Uint8Array> {
  const results = new Map<number, Uint8Array>();

  for (const wm of watermarks) {
    const targetPages = wm.pageIndices && wm.pageIndices.length > 0
      ? wm.pageIndices
      : doc.pages.map((_, i) => i);

    for (const pageIdx of targetPages) {
      if (pageIdx < 0 || pageIdx >= doc.pages.length) continue;
      const page = doc.pages[pageIdx];
      // Position in PDF user space (MediaBox origin may be non-zero).
      const pageWidth = page.mediaBox.width;
      const pageHeight = page.mediaBox.height;
      const originX = page.mediaBox.x;
      const originY = page.mediaBox.y;

      // Get current content bytes
      const currentBytes = results.get(pageIdx) || getPageContentBytesRaw(page, doc.objects);

      const newBytes = applyWatermarkToPage(
        currentBytes, page, doc.objects, wm,
        pageWidth, pageHeight, getNextObjNum,
        originX, originY,
      );
      results.set(pageIdx, newBytes);
    }
  }

  return results;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getPageContentBytesRaw(page: PDFPageInfo, objects: Map<string, PDFObject>): Uint8Array {
  // Try to get decoded content bytes from the page's content stream(s)
  const contents = page.dict.get('Contents');
  if (!contents) return new Uint8Array(0);

  const refs: PDFRef[] = [];
  if (contents instanceof PDFRef) {
    refs.push(contents);
  } else if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.length; i++) {
      const item = contents.get(i);
      if (item instanceof PDFRef) refs.push(item);
    }
  }

  // Concatenate decoded bytes from all content streams
  const chunks: Uint8Array[] = [];
  for (const ref of refs) {
    const obj = objects.get(ref.toKey());
    if (obj instanceof PDFStream) {
      chunks.push(obj.decodedBytes || obj.rawBytes);
    }
  }

  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0];

  const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function registerXObjectInResources(
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  name: string,
  ref: PDFRef,
): void {
  const resources = getOrCreateResourcesDict(page, objects);
  let xobjects = resources.get('XObject');
  if (xobjects instanceof PDFRef) {
    xobjects = objects.get(xobjects.toKey()) as PDFDict;
  }
  if (!xobjects || !(xobjects instanceof PDFDict)) {
    xobjects = new PDFDict();
    resources.set('XObject', xobjects);
  }
  xobjects.set(name, ref);
}

function registerFontInResources(
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  fontName: string,
  getNextObjNum: () => number
): void {
  const resources = getOrCreateResourcesDict(page, objects);
  let fonts = resources.get('Font');
  if (fonts instanceof PDFRef) {
    fonts = objects.get(fonts.toKey()) as PDFDict;
  }
  if (!fonts || !(fonts instanceof PDFDict)) {
    fonts = new PDFDict();
    resources.set('Font', fonts);
  }

  if (!fonts.has(fontName)) {
    const fontDict = new PDFDict();
    fontDict.set('Type', new PDFName('Font'));
    fontDict.set('Subtype', new PDFName('Type1'));
    
    let baseFont = fontName;
    if (fontName === 'Arial') baseFont = 'Helvetica';
    else if (fontName === 'Times New Roman') baseFont = 'Times-Roman';
    
    fontDict.set('BaseFont', new PDFName(baseFont));
    
    const objNum = getNextObjNum();
    const ref = new PDFRef(objNum, 0);
    objects.set(ref.toKey(), fontDict);
    fonts.set(fontName, ref);
  }
}

function registerExtGStateInResources(
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  name: string,
  ref: PDFRef,
): void {
  const resources = getOrCreateResourcesDict(page, objects);
  let extGState = resources.get('ExtGState');
  if (extGState instanceof PDFRef) {
    extGState = objects.get(extGState.toKey()) as PDFDict;
  }
  if (!extGState || !(extGState instanceof PDFDict)) {
    extGState = new PDFDict();
    resources.set('ExtGState', extGState);
  }
  extGState.set(name, ref);
}

function getOrCreateResourcesDict(page: PDFPageInfo, objects: Map<string, PDFObject>): PDFDict {
  const resourcesObj = page.dict.get('Resources');
  let resources: PDFDict;
  if (resourcesObj instanceof PDFRef) {
    const resolved = objects.get(resourcesObj.toKey());
    if (resolved instanceof PDFDict) {
      resources = resolved;
    } else {
      resources = new PDFDict();
      page.dict.set('Resources', resources);
    }
  } else if (resourcesObj instanceof PDFDict) {
    resources = resourcesObj;
  } else {
    resources = new PDFDict();
    page.dict.set('Resources', resources);
  }
  return resources;
}

function resolvePosition(
  position: WatermarkPosition | [number, number],
  pageWidth: number,
  pageHeight: number,
  wmWidth: number,
  wmHeight: number,
  originX: number = 0,
  originY: number = 0,
): { cx: number, cy: number } {
  const pad = 30; // 30 points padding

  if (Array.isArray(position)) {
    return { cx: position[0], cy: position[1] };
  }

  let cx = originX + pageWidth / 2;
  let cy = originY + pageHeight / 2;

  switch (position) {
    case 'top-left': 
      cx = originX + pad + wmWidth / 2;
      cy = originY + pageHeight - pad - wmHeight / 2;
      break;
    case 'top-center':
      cx = originX + pageWidth / 2;
      cy = originY + pageHeight - pad - wmHeight / 2;
      break;
    case 'top-right':
      cx = originX + pageWidth - pad - wmWidth / 2;
      cy = originY + pageHeight - pad - wmHeight / 2;
      break;
    case 'center-left':
      cx = originX + pad + wmWidth / 2;
      cy = originY + pageHeight / 2;
      break;
    case 'center':
      cx = originX + pageWidth / 2;
      cy = originY + pageHeight / 2;
      break;
    case 'center-right':
      cx = originX + pageWidth - pad - wmWidth / 2;
      cy = originY + pageHeight / 2;
      break;
    case 'bottom-left':
      cx = originX + pad + wmWidth / 2;
      cy = originY + pad + wmHeight / 2;
      break;
    case 'bottom-center':
      cx = originX + pageWidth / 2;
      cy = originY + pad + wmHeight / 2;
      break;
    case 'bottom-right':
      cx = originX + pageWidth - pad - wmWidth / 2;
      cy = originY + pad + wmHeight / 2;
      break;
  }
  
  return { cx, cy };
}

function getExtGStateName(watermarkId: string): string {
  return `GS_wm_${watermarkId.substring(0, 8)}`;
}

function escapePDFString(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

function fmtNum(n: number): string {
  if (Number.isInteger(n)) return n.toString();
  const s = n.toFixed(4);
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

function stringToBytes(s: string): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(s);
}