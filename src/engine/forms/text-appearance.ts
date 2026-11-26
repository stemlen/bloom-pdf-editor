/**
 * Appearance streams for text and choice widgets, so the saved value shows in
 * every viewer (and on Bloom's canvas) without relying on NeedAppearances.
 * ISO 32000-2 §12.7.4.3.
 *
 * Values Helvetica/WinAnsi can encode are drawn as text. Anything else
 * (Devanagari and other complex scripts, CJK, emoji) needs a font with its
 * own shaping, which the engine does not carry: those lines are drawn by a
 * host-provided rasterizer (the browser shapes them on a canvas) and placed
 * as transparent images, so every viewer shows the same shaped text.
 */

import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, type PDFDocumentData, type PDFObject } from '../types';
import { resolveRef } from '../parser/parser';
import { getStandardFont } from '../fonts/standard14';
import { getNextObjNum } from '../writer/serializer';
import type { AcroFormWidget } from './types';

/** WinAnsiEncoding bytes 0x80–0x9F (the rest of Latin-1 maps 1:1). */
const WIN_ANSI_HIGH: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

function winAnsiByte(cp: number): number | null {
  if (WIN_ANSI_HIGH[cp] != null) return WIN_ANSI_HIGH[cp];
  if (cp === 0x09) return 0x20;
  if ((cp >= 0x20 && cp < 0x80) || (cp >= 0xa0 && cp <= 0xff)) return cp;
  return null;
}

/** True when every character of `text` has a WinAnsiEncoding (Helvetica) glyph. */
export function isWinAnsiEncodable(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x0a || cp === 0x0d) continue;
    if (winAnsiByte(cp) == null) return false;
  }
  return true;
}

/** Encode one line as a PDF literal string in WinAnsiEncoding; unmappable characters become "?". */
function winAnsiLiteral(line: string): number[] {
  const out: number[] = [0x28];
  for (const ch of line) {
    let b = winAnsiByte(ch.codePointAt(0)!) ?? 0x3f;
    if (b < 0x20) b = 0x20;
    if (b === 0x28 || b === 0x29 || b === 0x5c) out.push(0x5c);
    out.push(b);
  }
  out.push(0x29);
  return out;
}

/** Helvetica advance width of a WinAnsi-encodable line, in points. */
function helveticaWidth(line: string, size: number): number {
  const metrics = getStandardFont('Helvetica');
  let w = 0;
  for (const ch of line) {
    const code = winAnsiByte(ch.codePointAt(0)!) ?? 0x3f;
    w += metrics ? (metrics.widths[code] || metrics.defaultWidth) : 556;
  }
  return (w * size) / 1000;
}

// ─── Complex-script rasterizer (provided by the host) ───────────────────────

/** One line of text drawn by the host, as Flate-compressed image samples. */
export interface RasterTextLine {
  /** Image size in pixels. */
  widthPx: number;
  heightPx: number;
  /** Flate (zlib) compressed DeviceRGB samples, widthPx × heightPx × 3 — the text colour. */
  rgb: Uint8Array;
  /** Flate (zlib) compressed DeviceGray samples, widthPx × heightPx — the text coverage (soft mask). */
  alpha: Uint8Array;
  /** The same samples uncompressed (Bloom's renderer draws streams from their decoded bytes). */
  rgbSamples: Uint8Array;
  alphaSamples: Uint8Array;
  /** Image size in points. */
  widthPt: number;
  heightPt: number;
  /** Distance from the image's bottom edge up to the text baseline, in points. */
  baselinePt: number;
  /** Advance width of the shaped text, in points (for alignment). */
  advancePt: number;
}

export type ComplexTextRasterizer = (
  text: string,
  fontSize: number,
  color: [number, number, number],
) => RasterTextLine | null;

let complexTextRasterizer: ComplexTextRasterizer | null = null;

/** Register (or clear) the host's rasterizer for text Helvetica can't encode. */
export function setComplexTextRasterizer(fn: ComplexTextRasterizer | null): void {
  complexTextRasterizer = fn;
}

export function getComplexTextRasterizer(): ComplexTextRasterizer | null {
  return complexTextRasterizer;
}

/** Image XObject (with a soft mask) for one rasterized line. */
export function rasterLineImage(line: RasterTextLine): { image: PDFStream; smask: PDFStream } {
  const smaskDict = new PDFDict();
  smaskDict.set('Type', new PDFName('XObject'));
  smaskDict.set('Subtype', new PDFName('Image'));
  smaskDict.set('Width', new PDFNumber(line.widthPx));
  smaskDict.set('Height', new PDFNumber(line.heightPx));
  smaskDict.set('ColorSpace', new PDFName('DeviceGray'));
  smaskDict.set('BitsPerComponent', new PDFNumber(8));
  smaskDict.set('Filter', new PDFName('FlateDecode'));
  smaskDict.set('Length', new PDFNumber(line.alpha.length));
  const imgDict = new PDFDict();
  imgDict.set('Type', new PDFName('XObject'));
  imgDict.set('Subtype', new PDFName('Image'));
  imgDict.set('Width', new PDFNumber(line.widthPx));
  imgDict.set('Height', new PDFNumber(line.heightPx));
  imgDict.set('ColorSpace', new PDFName('DeviceRGB'));
  imgDict.set('BitsPerComponent', new PDFNumber(8));
  imgDict.set('Filter', new PDFName('FlateDecode'));
  imgDict.set('Length', new PDFNumber(line.rgb.length));
  return {
    image: new PDFStream(imgDict, line.rgb, line.rgbSamples),
    smask: new PDFStream(smaskDict, line.alpha, line.alphaSamples),
  };
}

// ─── Appearance ─────────────────────────────────────────────────────────────

function parseDa(da: string): { size: number; color: string; rgb: [number, number, number] } {
  const size = Number(/([\d.]+)\s+Tf/.exec(da)?.[1] ?? 0);
  const rgb = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(da);
  const gray = /([\d.]+)\s+g(?:\s|$)/.exec(da);
  if (rgb) return { size, color: `${rgb[1]} ${rgb[2]} ${rgb[3]} rg`, rgb: [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] };
  if (gray) return { size, color: `${gray[1]} g`, rgb: [Number(gray[1]), Number(gray[1]), Number(gray[1])] };
  return { size, color: '0 g', rgb: [0, 0, 0] };
}

/** An /MK colour array (gray, RGB or CMYK) as a fill or stroke operator. */
function mkColor(obj: PDFObject | undefined, stroke: boolean): string | null {
  if (!(obj instanceof PDFArray)) return null;
  const n = obj.items.map((x) => (x instanceof PDFNumber ? x.value : 0));
  const op = (s: string) => (stroke ? s.toUpperCase() : s);
  if (n.length === 1) return `${n[0]} ${op('g')}`;
  if (n.length === 3) return `${n.join(' ')} ${op('rg')}`;
  if (n.length === 4) return `${n.join(' ')} ${op('k')}`;
  return null;
}

/** An inherited field attribute: the widget's own, else its parents'. */
function inherited(dict: PDFDict, key: string, objects: Map<string, PDFObject>): PDFObject | undefined {
  let cur: PDFDict | null = dict;
  for (let depth = 0; cur && depth < 32; depth++) {
    const v = cur.get(key);
    if (v !== undefined) return v;
    const parent = resolveRef(cur.get('Parent') as PDFObject, objects);
    cur = parent instanceof PDFDict ? parent : null;
  }
  return undefined;
}

const fmt = (n: number) => (Math.abs(n) < 1e-9 ? '0' : Number(n.toFixed(3)).toString());

/**
 * Build and attach a /AP /N stream that draws `value` inside the widget, with
 * the widget's /MK background and border. Returns true when (some of) the
 * text had to be rasterized.
 */
export function regenerateTextAppearance(doc: PDFDocumentData, widget: AcroFormWidget, value: string): boolean {
  const w = Math.max(1, widget.rect?.width ?? 100);
  const h = Math.max(1, widget.rect?.height ?? 20);
  const objects = doc.objects;
  const daString = widget.defaultAppearance
    || String((inherited(widget.dict, 'DA', objects) as { value?: string } | undefined)?.value ?? '');
  const { size: daSize, color, rgb } = parseDa(daString);
  const lines = widget.multiline ? value.split(/\r\n|\r|\n/) : [value.replace(/\s*[\r\n]+\s*/g, ' ')];

  const mk = resolveRef(widget.dict.get('MK') as PDFObject, objects);
  const bg = mk instanceof PDFDict ? mkColor(mk.get('BG'), false) : null;
  const bc = mk instanceof PDFDict ? mkColor(mk.get('BC'), true) : null;
  const bs = resolveRef(widget.dict.get('BS') as PDFObject, objects);
  const bsW = bs instanceof PDFDict ? bs.get('W') : undefined;
  const borderWidth = bc ? (bsW instanceof PDFNumber ? bsW.value : 1) : 0;
  const pad = Math.max(2, borderWidth * 2);

  const qObj = inherited(widget.dict, 'Q', objects);
  let acro = doc.catalog.get('AcroForm');
  if (acro instanceof PDFRef) acro = resolveRef(acro, objects);
  const acroQ = acro instanceof PDFDict ? acro.get('Q') : undefined;
  const quadding = qObj instanceof PDFNumber ? qObj.value : acroQ instanceof PDFNumber ? acroQ.value : 0;
  const ffObj = inherited(widget.dict, 'Ff', objects);
  const ff = ffObj instanceof PDFNumber ? ffObj.value : 0;
  const maxLenObj = inherited(widget.dict, 'MaxLen', objects);
  const combCells = (ff & (1 << 24)) && !widget.multiline && maxLenObj instanceof PDFNumber && maxLenObj.value > 0
    ? maxLenObj.value : 0;

  const rasterize = complexTextRasterizer;
  const needsRaster = (line: string) => !!rasterize && !isWinAnsiEncodable(line);

  // Font size: /DA's, or auto — the box height, shrunk until the longest line fits.
  let size = daSize;
  if (size <= 0) {
    size = widget.multiline ? 10 : Math.max(4, Math.min(12, (h - 4) * 0.75));
    if (!widget.multiline && !combCells && !needsRaster(lines[0])) {
      const tw = helveticaWidth(lines[0], size);
      const room = w - pad * 2;
      if (tw > room && tw > 0) size = Math.max(4, size * (room / tw));
    }
  }
  const leading = size * 1.15;

  // Images from the previous appearance are reused, so typing doesn't pile up objects.
  const oldAp = resolveRef(widget.dict.get('AP') as PDFObject, objects);
  const oldN = oldAp instanceof PDFDict ? oldAp.get('N') : undefined;
  const oldStream = oldN instanceof PDFRef ? objects.get(oldN.toKey()) : undefined;
  const reusable: PDFRef[] = [];
  if (oldStream instanceof PDFStream) {
    const res = resolveRef(oldStream.dict.get('Resources') as PDFObject, objects);
    const xo = res instanceof PDFDict ? resolveRef(res.get('XObject') as PDFObject, objects) : null;
    if (xo instanceof PDFDict) {
      for (const [k, v] of xo.entries()) if (k.startsWith('BloomTx') && v instanceof PDFRef) reusable.push(v);
    }
  }
  let nextNum = getNextObjNum(doc);
  const takeRef = () => reusable.shift() ?? new PDFRef(nextNum++, 0);

  const enc = new TextEncoder();
  const parts: number[] = [];
  const push = (s: string) => parts.push(...enc.encode(s));
  if (bg) push(`q ${bg} 0 0 ${fmt(w)} ${fmt(h)} re f Q\n`);
  if (bc && borderWidth > 0) {
    const i = borderWidth / 2;
    push(`q ${bc} ${fmt(borderWidth)} w ${fmt(i)} ${fmt(i)} ${fmt(w - borderWidth)} ${fmt(h - borderWidth)} re S Q\n`);
  }
  push(`/Tx BMC\nq\n${fmt(borderWidth)} ${fmt(borderWidth)} ${fmt(w - borderWidth * 2)} ${fmt(h - borderWidth * 2)} re W n\n`);

  const xobjects = new PDFDict();
  let rasterized = false;
  const firstBaseline = widget.multiline ? h - pad - size * 0.8 : (h - size * 0.72) / 2;
  const alignX = (lineWidth: number) =>
    quadding === 1 ? (w - lineWidth) / 2 : quadding === 2 ? w - pad - lineWidth : pad;

  lines.forEach((line, i) => {
    const baseline = firstBaseline - i * leading;
    const raster = needsRaster(line) ? rasterize!(line, size, rgb) : null;
    if (raster) {
      rasterized = true;
      const { image, smask } = rasterLineImage(raster);
      const imgRef = takeRef();
      const smaskRef = takeRef();
      image.dict.set('SMask', smaskRef);
      objects.set(imgRef.toKey(), image);
      objects.set(smaskRef.toKey(), smask);
      const name = `BloomTx${i}`;
      xobjects.set(name, imgRef);
      // Keep the soft mask listed too, so its ref is found and reused next time.
      xobjects.set(`BloomTxMask${i}`, smaskRef);
      const x = alignX(raster.advancePt);
      push(`q ${fmt(raster.widthPt)} 0 0 ${fmt(raster.heightPt)} ${fmt(x)} ${fmt(baseline - raster.baselinePt)} cm /${name} Do Q\n`);
      return;
    }
    if (combCells) {
      const cell = w / combCells;
      push(`BT\n/Helv ${fmt(size)} Tf\n${color}\n`);
      let prevX = 0;
      [...line].slice(0, combCells).forEach((ch, c) => {
        const x = c * cell + (cell - helveticaWidth(ch, size)) / 2;
        push(c === 0 ? `${fmt(x)} ${fmt(baseline)} Td\n` : `${fmt(x - prevX)} 0 Td\n`);
        prevX = x;
        parts.push(...winAnsiLiteral(ch));
        push(' Tj\n');
      });
      push('ET\n');
      return;
    }
    push(`BT\n/Helv ${fmt(size)} Tf\n${color}\n${fmt(alignX(helveticaWidth(line, size)))} ${fmt(baseline)} Td\n`);
    parts.push(...winAnsiLiteral(line));
    push(' Tj\nET\n');
  });
  push('Q\nEMC\n');
  // Drop images the new appearance no longer uses.
  for (const ref of reusable) objects.delete(ref.toKey());
  const bytes = new Uint8Array(parts);

  const font = new PDFDict();
  font.set('Type', new PDFName('Font'));
  font.set('Subtype', new PDFName('Type1'));
  font.set('BaseFont', new PDFName('Helvetica'));
  font.set('Encoding', new PDFName('WinAnsiEncoding'));
  const fonts = new PDFDict();
  fonts.set('Helv', font);
  const resources = new PDFDict();
  resources.set('Font', fonts);
  if (xobjects.size > 0) resources.set('XObject', xobjects);

  const dict = new PDFDict();
  dict.set('Type', new PDFName('XObject'));
  dict.set('Subtype', new PDFName('Form'));
  dict.set('BBox', new PDFArray([new PDFNumber(0), new PDFNumber(0), new PDFNumber(w), new PDFNumber(h)]));
  dict.set('Resources', resources);
  dict.set('Length', new PDFNumber(bytes.length));
  // Reuse the widget's own /N object when it has one, so typing doesn't pile up streams.
  const ref = oldN instanceof PDFRef && oldStream instanceof PDFStream
    ? oldN
    : new PDFRef(getNextObjNum(doc), 0);
  doc.objects.set(ref.toKey(), new PDFStream(dict, bytes, bytes));

  const ap = new PDFDict();
  ap.set('N', ref);
  widget.dict.set('AP', ap);
  return rasterized;
}
