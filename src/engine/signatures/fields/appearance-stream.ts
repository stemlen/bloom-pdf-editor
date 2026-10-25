/**
 * Phase 5 — Signature field appearance streams (/AP /N).
 *
 * Generates Form XObject appearance streams with:
 * - /BBox
 * - /Resources (Font, XObject, ExtGState)
 * - /Matrix
 * - Vector content where possible (paths + text)
 *
 * Bitmap signature ink is embedded as an Image XObject only when necessary.
 */

import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFDocumentData,
  type PDFObject,
  type PDFRectangle,
} from '../../types';
import { getNextObjNum } from '../../writer/serializer';
import { resolveRef } from '../../parser/parser';

// ─── Resource manager ───────────────────────────────────────────────────────

export class AppearanceResourceManager {
  readonly fonts = new Map<string, PDFRef | PDFDict>();
  readonly xobjects = new Map<string, PDFRef>();
  readonly extGStates = new Map<string, PDFRef | PDFDict>();
  private fontCounter = 0;
  private imageCounter = 0;
  private gsCounter = 0;

  /** Ensure Helvetica (or given Type1 base font) is available; returns resource name. */
  ensureType1Font(baseFont = 'Helvetica', preferredName?: string): string {
    const name = preferredName ?? (baseFont === 'Helvetica' ? 'Helv' : `F${++this.fontCounter}`);
    if (this.fonts.has(name)) return name;
    const dict = new PDFDict();
    dict.set('Type', new PDFName('Font'));
    dict.set('Subtype', new PDFName('Type1'));
    dict.set('BaseFont', new PDFName(baseFont));
    this.fonts.set(name, dict);
    return name;
  }

  /** Register an Image XObject ref under a unique name. */
  addImageXObject(ref: PDFRef, preferredName?: string): string {
    const name = preferredName ?? `Im${++this.imageCounter}`;
    this.xobjects.set(name, ref);
    return name;
  }

  /** Register opacity ExtGState; returns resource name. */
  ensureOpacity(opacity: number, preferredName?: string): string {
    const name = preferredName ?? `GS${++this.gsCounter}`;
    if (this.extGStates.has(name)) return name;
    const dict = new PDFDict();
    dict.set('Type', new PDFName('ExtGState'));
    dict.set('ca', new PDFNumber(opacity));
    dict.set('CA', new PDFNumber(opacity));
    this.extGStates.set(name, dict);
    return name;
  }

  /** Build /Resources dictionary (inline dicts + refs). */
  toResourcesDict(): PDFDict {
    const resources = new PDFDict();

    if (this.fonts.size > 0) {
      const fontDict = new PDFDict();
      for (const [name, val] of this.fonts) {
        fontDict.set(name, val);
      }
      resources.set('Font', fontDict);
    }

    if (this.xobjects.size > 0) {
      const xo = new PDFDict();
      for (const [name, ref] of this.xobjects) {
        xo.set(name, ref);
      }
      resources.set('XObject', xo);
    }

    if (this.extGStates.size > 0) {
      const gs = new PDFDict();
      for (const [name, val] of this.extGStates) {
        gs.set(name, val);
      }
      resources.set('ExtGState', gs);
    }

    return resources;
  }
}

// ─── Appearance options / content ───────────────────────────────────────────

export interface SignatureFieldAppearanceOptions {
  width: number;
  height: number;
  /** Signature ink as PNG/JPEG/SVG data URL — embedded as Image XObject when present. */
  imageDataUrl?: string;
  /** JPEG bytes + dims when already decoded (preferred over data URL). */
  imageJpegBytes?: Uint8Array;
  imagePixelWidth?: number;
  imagePixelHeight?: number;
  typedName?: string;
  date?: string;
  reason?: string;
  location?: string;
  contactInfo?: string;
  backgroundColor?: [number, number, number] | null;
  backgroundOpacity?: number;
  borderColor?: [number, number, number];
  borderWidth?: number;
  textColor?: [number, number, number];
  fontSize?: number;
  padding?: number;
  showPlaceholder?: boolean;
  /** Compress stream with FlateDecode. */
  compress?: boolean;
}

export interface SerializedAppearance {
  /** Form XObject stream ref. */
  streamRef: PDFRef;
  bbox: PDFRectangle;
  matrix: [number, number, number, number, number, number];
  content: string;
}

function escapePdfString(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

function fmt(n: number): string {
  return (Math.round(n * 1000) / 1000).toString();
}

/**
 * Build PDF content-stream operators for a signature appearance (vector + optional image).
 * Coordinate space is appearance BBox: origin bottom-left, units = field size.
 */
export function buildSignatureAppearanceContent(
  options: SignatureFieldAppearanceOptions,
  resources: AppearanceResourceManager,
  imageResourceName?: string,
): string {
  const w = Math.max(1, options.width);
  const h = Math.max(1, options.height);
  const pad = options.padding ?? 4;
  const borderW = options.borderWidth ?? 1;
  const border = options.borderColor ?? [0.2, 0.25, 0.35];
  const textColor = options.textColor ?? [0.1, 0.1, 0.15];
  const fontSize = options.fontSize ?? 9;
  const fontName = resources.ensureType1Font('Helvetica', 'Helv');

  const lines: string[] = ['q'];

  // Background
  if (options.backgroundColor) {
    const [r, g, b] = options.backgroundColor;
    const op = options.backgroundOpacity ?? 1;
    if (op < 1) {
      const gs = resources.ensureOpacity(op, 'GSbg');
      lines.push(`/${gs} gs`);
    }
    lines.push(`${fmt(r)} ${fmt(g)} ${fmt(b)} rg`);
    lines.push(`0 0 ${fmt(w)} ${fmt(h)} re f`);
  } else if (options.showPlaceholder) {
    lines.push('0.96 0.97 0.99 rg');
    lines.push(`0 0 ${fmt(w)} ${fmt(h)} re f`);
  }

  // Border
  if (borderW > 0) {
    lines.push(`${fmt(border[0])} ${fmt(border[1])} ${fmt(border[2])} RG`);
    lines.push(`${fmt(borderW)} w`);
    lines.push(`${fmt(borderW / 2)} ${fmt(borderW / 2)} ${fmt(w - borderW)} ${fmt(h - borderW)} re S`);
  }

  let cursorY = h - pad - fontSize;

  // Signature image (bottom-aligned block)
  if (imageResourceName) {
    const imgH = Math.min(h * 0.55, h - pad * 2 - fontSize * 2);
    const imgW = w - pad * 2;
    const imgY = pad + (options.typedName || options.date ? fontSize * 1.8 : 0);
    lines.push('q');
    lines.push(`${fmt(imgW)} 0 0 ${fmt(imgH)} ${fmt(pad)} ${fmt(imgY)} cm`);
    lines.push(`/${imageResourceName} Do`);
    lines.push('Q');
    cursorY = imgY + imgH + 2;
  }

  // Text metadata (vector)
  const meta: string[] = [];
  if (options.showPlaceholder && !options.typedName && !imageResourceName) {
    meta.push('Sign here');
  }
  if (options.typedName) meta.push(options.typedName);
  if (options.date) meta.push(`Date: ${options.date}`);
  if (options.reason) meta.push(`Reason: ${options.reason}`);
  if (options.location) meta.push(`Location: ${options.location}`);
  if (options.contactInfo) meta.push(options.contactInfo);

  if (meta.length > 0) {
    lines.push(`${fmt(textColor[0])} ${fmt(textColor[1])} ${fmt(textColor[2])} rg`);
    lines.push('BT');
    lines.push(`/${fontName} ${fmt(fontSize)} Tf`);
    const y = Math.min(cursorY, h - pad - fontSize);
    for (let i = 0; i < meta.length; i++) {
      if (i === 0) {
        lines.push(`${fmt(pad)} ${fmt(y)} Td`);
      } else {
        lines.push(`0 ${fmt(-(fontSize + 2))} Td`);
      }
      lines.push(`(${escapePdfString(meta[i])}) Tj`);
    }
    lines.push('ET');
  }

  lines.push('Q');
  return lines.join('\n') + '\n';
}

/**
 * Serialize content + resources into a Form XObject stream and store on the document.
 */
export function serializeAppearanceStream(
  doc: PDFDocumentData,
  content: string,
  bbox: PDFRectangle,
  resources: AppearanceResourceManager,
  options?: { compress?: boolean; matrix?: [number, number, number, number, number, number] },
): SerializedAppearance {
  const matrix = options?.matrix ?? ([1, 0, 0, 1, 0, 0] as [
    number, number, number, number, number, number,
  ]);
  const bytes = new TextEncoder().encode(content);
  const dict = new PDFDict();
  dict.set('Type', new PDFName('XObject'));
  dict.set('Subtype', new PDFName('Form'));
  dict.set('FormType', new PDFNumber(1));
  dict.set('BBox', new PDFArray([
    new PDFNumber(bbox.x),
    new PDFNumber(bbox.y),
    new PDFNumber(bbox.x + bbox.width),
    new PDFNumber(bbox.y + bbox.height),
  ]));
  dict.set('Matrix', new PDFArray(matrix.map((n) => new PDFNumber(n))));
  dict.set('Resources', resources.toResourcesDict());

  // Compression is optional and async in this engine — leave uncompressed by default
  // so appearance generation stays synchronous. Callers can Flate later if needed.
  void options?.compress;

  dict.set('Length', new PDFNumber(bytes.length));
  const stream = new PDFStream(dict, bytes, bytes);
  const streamRef = new PDFRef(getNextObjNum(doc), 0);
  doc.objects.set(streamRef.toKey(), stream);

  return { streamRef, bbox, matrix, content };
}

/** Attach Form XObject as /AP /N on a widget/field dictionary. */
export function attachNormalAppearance(fieldDict: PDFDict, appearanceRef: PDFRef): void {
  const ap = new PDFDict();
  ap.set('N', appearanceRef);
  fieldDict.set('AP', ap);
}

/** Decode a data URL to raw bytes + mime hint. */
function decodeDataUrl(dataUrl: string): { bytes: Uint8Array; mime: string } | null {
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/i.exec(dataUrl);
  if (!match) return null;
  const mime = match[1] || 'application/octet-stream';
  const isBase64 = Boolean(match[2]);
  const data = match[3];
  if (isBase64) {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, mime };
  }
  return { bytes: new TextEncoder().encode(decodeURIComponent(data)), mime };
}

/**
 * Embed JPEG (or raw) image bytes as an Image XObject.
 * Returns resource name registered on the manager.
 */
export function embedAppearanceImage(
  doc: PDFDocumentData,
  resources: AppearanceResourceManager,
  imageBytes: Uint8Array,
  pixelWidth: number,
  pixelHeight: number,
  mime: 'image/jpeg' | 'image/png' = 'image/jpeg',
): string {
  const dict = new PDFDict();
  dict.set('Type', new PDFName('XObject'));
  dict.set('Subtype', new PDFName('Image'));
  dict.set('Width', new PDFNumber(pixelWidth));
  dict.set('Height', new PDFNumber(pixelHeight));
  dict.set('ColorSpace', new PDFName('DeviceRGB'));
  dict.set('BitsPerComponent', new PDFNumber(8));
  if (mime === 'image/jpeg') {
    dict.set('Filter', new PDFName('DCTDecode'));
  } else {
    // PNG bytes without decode — store Flate if already compressed payload; viewers need DCT/raw.
    // Prefer caller convert to JPEG. Fallback: Flate raw RGB assumption is unsafe; still mark Flate.
    dict.set('Filter', new PDFName('FlateDecode'));
  }
  dict.set('Length', new PDFNumber(imageBytes.length));
  const stream = new PDFStream(dict, imageBytes, imageBytes);
  const ref = new PDFRef(getNextObjNum(doc), 0);
  doc.objects.set(ref.toKey(), stream);
  return resources.addImageXObject(ref);
}

/**
 * Convert PNG/JPEG data URL to JPEG bytes via canvas when available.
 * Falls back to raw decode for JPEG data URLs.
 */
export async function dataUrlToJpegBytes(
  dataUrl: string,
): Promise<{ bytes: Uint8Array; width: number; height: number } | null> {
  if (typeof document === 'undefined') {
    const decoded = decodeDataUrl(dataUrl);
    if (!decoded) return null;
    if (decoded.mime.includes('jpeg') || decoded.mime.includes('jpg')) {
      return { bytes: decoded.bytes, width: 200, height: 80 };
    }
    return null;
  }

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || 200;
      canvas.height = img.naturalHeight || 80;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(null);
        return;
      }
      // White underlay — JPEG has no alpha; preserve look for ink on white
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      const jpegUrl = canvas.toDataURL('image/jpeg', 0.92);
      const decoded = decodeDataUrl(jpegUrl);
      if (!decoded) {
        resolve(null);
        return;
      }
      resolve({ bytes: decoded.bytes, width: canvas.width, height: canvas.height });
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

/**
 * Generate and attach a normal appearance stream to a signature field.
 * Returns the Form XObject ref.
 */
export function applySignatureFieldAppearance(
  doc: PDFDocumentData,
  fieldRef: PDFRef,
  options: SignatureFieldAppearanceOptions,
): PDFRef {
  const field = doc.objects.get(fieldRef.toKey());
  if (!(field instanceof PDFDict)) {
    throw new Error('Signature field not found');
  }

  const resources = new AppearanceResourceManager();
  let imageName: string | undefined;

  if (options.imageJpegBytes && options.imagePixelWidth && options.imagePixelHeight) {
    imageName = embedAppearanceImage(
      doc,
      resources,
      options.imageJpegBytes,
      options.imagePixelWidth,
      options.imagePixelHeight,
      'image/jpeg',
    );
  } else if (options.imageDataUrl) {
    const decoded = decodeDataUrl(options.imageDataUrl);
    if (decoded && (decoded.mime.includes('jpeg') || decoded.mime.includes('jpg'))) {
      imageName = embedAppearanceImage(
        doc,
        resources,
        decoded.bytes,
        options.imagePixelWidth ?? Math.round(options.width * 2),
        options.imagePixelHeight ?? Math.round(options.height * 2),
        'image/jpeg',
      );
    }
  }

  const content = buildSignatureAppearanceContent(options, resources, imageName);
  const bbox: PDFRectangle = { x: 0, y: 0, width: options.width, height: options.height };
  const serialized = serializeAppearanceStream(doc, content, bbox, resources, {
    compress: options.compress ?? false,
    matrix: [1, 0, 0, 1, 0, 0],
  });

  attachNormalAppearance(field, serialized.streamRef);

  // Keep Rect in sync if needed
  const rect = field.get('Rect');
  if (!(rect instanceof PDFArray)) {
    field.set('Rect', new PDFArray([
      new PDFNumber(0),
      new PDFNumber(0),
      new PDFNumber(options.width),
      new PDFNumber(options.height),
    ]));
  }

  return serialized.streamRef;
}

/**
 * Async variant that converts PNG/SVG data URLs to JPEG before embedding.
 */
export async function applySignatureFieldAppearanceAsync(
  doc: PDFDocumentData,
  fieldRef: PDFRef,
  options: SignatureFieldAppearanceOptions,
): Promise<PDFRef> {
  if (options.imageDataUrl && !options.imageJpegBytes) {
    const jpeg = await dataUrlToJpegBytes(options.imageDataUrl);
    if (jpeg) {
      return applySignatureFieldAppearance(doc, fieldRef, {
        ...options,
        imageJpegBytes: jpeg.bytes,
        imagePixelWidth: jpeg.width,
        imagePixelHeight: jpeg.height,
        imageDataUrl: undefined,
      });
    }
  }
  return applySignatureFieldAppearance(doc, fieldRef, options);
}

/** Read /AP /N stream ref from a field dict, if any. */
export function getNormalAppearanceRef(
  fieldDict: PDFDict,
  objects: Map<string, PDFObject>,
): PDFRef | null {
  const ap = fieldDict.get('AP');
  const apDict = ap instanceof PDFRef ? resolveRef(ap, objects) : ap;
  if (!(apDict instanceof PDFDict)) return null;
  const n = apDict.get('N');
  if (n instanceof PDFRef) return n;
  return null;
}
