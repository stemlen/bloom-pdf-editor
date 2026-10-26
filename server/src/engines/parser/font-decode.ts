import { createId } from '../../utils/id.js';
import { resolve } from './document-parser.js';
import { decodeStream } from './filters.js';
import { defaultCodeBytes, parseCMap, type CMapData } from './cmap.js';
import { PdfArray, PdfDict, PdfName, PdfRef, PdfStream, type PdfPrimitive } from './pdf-objects.js';
import type { RawFont } from './raw-model.js';

/** Font metrics + Unicode maps used during content extraction. */
export interface LoadedFont {
  resourceName: string;
  baseFont: string;
  subtype: string;
  encoding: string;
  isComposite: boolean;
  codeBytes: number;
  toUnicode: Map<number, string>;
  toCID: Map<number, number>;
  widths: Map<number, number>;
  defaultWidth: number;
  differences: Map<number, string>;
}

const WIN_ANSI: Record<number, number> = {
  0x80: 0x20ac,
  0x82: 0x201a,
  0x83: 0x0192,
  0x84: 0x201e,
  0x85: 0x2026,
  0x86: 0x2020,
  0x87: 0x2021,
  0x88: 0x02c6,
  0x89: 0x2030,
  0x8a: 0x0160,
  0x8b: 0x2039,
  0x8c: 0x0152,
  0x8e: 0x017d,
  0x91: 0x2018,
  0x92: 0x2019,
  0x93: 0x201c,
  0x94: 0x201d,
  0x95: 0x2022,
  0x96: 0x2013,
  0x97: 0x2014,
  0x98: 0x02dc,
  0x99: 0x2122,
  0x9a: 0x0161,
  0x9b: 0x203a,
  0x9c: 0x0153,
  0x9e: 0x017e,
  0x9f: 0x0178,
};

const AGL: Record<string, string> = {
  space: ' ',
  period: '.',
  comma: ',',
  hyphen: '-',
  endash: '\u2013',
  emdash: '\u2014',
  bullet: '\u2022',
  quotesingle: "'",
  quotedblleft: '\u201c',
  quotedblright: '\u201d',
  quoteleft: '\u2018',
  quoteright: '\u2019',
  parenleft: '(',
  parenright: ')',
  ampersand: '&',
  asterisk: '*',
  slash: '/',
  colon: ':',
  semicolon: ';',
};

export function latin1ToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

export async function loadPageFonts(
  resources: PdfDict | null,
  objects: Map<string, PdfPrimitive>,
  fontsOut: RawFont[],
): Promise<Map<string, LoadedFont>> {
  const map = new Map<string, LoadedFont>();
  if (!resources) return map;

  let fontDict = resources.getDict('Font');
  const fontRef = resources.getRef('Font');
  if (!fontDict && fontRef) {
    const resolved = resolve(objects, fontRef);
    if (resolved instanceof PdfDict) fontDict = resolved;
  }
  if (!fontDict) return map;

  for (const [resourceName, value] of fontDict.entries()) {
    let dict = value;
    if (value instanceof PdfRef) dict = resolve(objects, value);
    if (!(dict instanceof PdfDict)) continue;

    const loaded = await loadOneFont(resourceName, dict, objects);
    map.set(resourceName, loaded);
    fontsOut.push({
      id: createId('font'),
      name: resourceName,
      baseFont: loaded.baseFont,
      subtype: loaded.subtype,
      encoding: loaded.encoding,
    });
  }
  return map;
}

async function loadOneFont(
  resourceName: string,
  dict: PdfDict,
  objects: Map<string, PdfPrimitive>,
): Promise<LoadedFont> {
  const baseFont = dict.getName('BaseFont') ?? resourceName;
  const subtype = dict.getName('Subtype') ?? 'Type1';
  let encoding = '';
  let differences = new Map<number, string>();
  const encObj = dict.get('Encoding');
  if (encObj instanceof PdfName) {
    encoding = encObj.value;
  } else if (encObj instanceof PdfRef) {
    const resolved = resolve(objects, encObj);
    if (resolved instanceof PdfName) encoding = resolved.value;
    else if (resolved instanceof PdfDict) {
      encoding = resolved.getName('BaseEncoding') ?? 'WinAnsiEncoding';
      differences = parseDifferences(resolved, objects);
    }
  } else if (encObj instanceof PdfDict) {
    encoding = encObj.getName('BaseEncoding') ?? 'WinAnsiEncoding';
    differences = parseDifferences(encObj, objects);
  }

  const isComposite = subtype === 'Type0';
  let toUnicode = new Map<number, string>();
  let toCID = new Map<number, number>();
  let cmap: CMapData | null = null;

  const tu = await resolveStream(dict.get('ToUnicode'), objects);
  if (tu) {
    try {
      cmap = parseCMap(tu);
      toUnicode = cmap.toUnicode;
      toCID = cmap.toCID;
    } catch {
      /* ignore broken cmap */
    }
  }

  let widths = new Map<number, number>();
  let defaultWidth = 500;
  let descendant: PdfDict | null = null;

  const df = dict.get('DescendantFonts');
  if (df instanceof PdfArray && df.length > 0) {
    let d0 = df.get(0);
    if (d0 instanceof PdfRef) d0 = resolve(objects, d0);
    if (d0 instanceof PdfDict) descendant = d0;
  } else if (df instanceof PdfRef) {
    const arr = resolve(objects, df);
    if (arr instanceof PdfArray && arr.length > 0) {
      let d0 = arr.get(0);
      if (d0 instanceof PdfRef) d0 = resolve(objects, d0);
      if (d0 instanceof PdfDict) descendant = d0;
    }
  }

  const metricsDict = descendant ?? dict;
  if (descendant) {
    const enc = dict.getName('Encoding') ?? encoding;
    if (enc) encoding = enc;
    const dw = metricsDict.getNumber('DW');
    if (dw != null) defaultWidth = dw;
    widths = parseCidWidths(metricsDict, objects);
  } else {
    widths = parseSimpleWidths(metricsDict, objects);
    const fd = resolveDict(metricsDict.get('FontDescriptor'), objects);
    const missing = fd?.getNumber('MissingWidth');
    if (missing != null) defaultWidth = missing;
  }

  if (!encoding && isComposite) encoding = 'Identity-H';

  return {
    resourceName,
    baseFont,
    subtype,
    encoding,
    isComposite,
    codeBytes: defaultCodeBytes(cmap, isComposite),
    toUnicode,
    toCID,
    widths,
    defaultWidth,
    differences,
  };
}

function parseDifferences(enc: PdfDict, objects: Map<string, PdfPrimitive>): Map<number, string> {
  const out = new Map<number, string>();
  let diffs = enc.get('Differences');
  if (diffs instanceof PdfRef) diffs = resolve(objects, diffs);
  if (!(diffs instanceof PdfArray)) return out;
  let code = 0;
  for (let i = 0; i < diffs.length; i++) {
    const item = diffs.get(i);
    if (typeof item === 'number') code = item;
    else if (item instanceof PdfName) {
      out.set(code, item.value);
      code += 1;
    }
  }
  return out;
}

function parseSimpleWidths(
  dict: PdfDict,
  objects: Map<string, PdfPrimitive>,
): Map<number, number> {
  const widths = new Map<number, number>();
  const first = dict.getNumber('FirstChar') ?? 0;
  let w = dict.get('Widths');
  if (w instanceof PdfRef) w = resolve(objects, w);
  if (!(w instanceof PdfArray)) return widths;
  for (let i = 0; i < w.length; i++) {
    const v = w.get(i);
    if (typeof v === 'number') widths.set(first + i, v);
  }
  return widths;
}

function parseCidWidths(
  dict: PdfDict,
  objects: Map<string, PdfPrimitive>,
): Map<number, number> {
  const widths = new Map<number, number>();
  let w = dict.get('W');
  if (w instanceof PdfRef) w = resolve(objects, w);
  if (!(w instanceof PdfArray)) return widths;

  let i = 0;
  while (i < w.length) {
    const c1 = w.get(i);
    if (typeof c1 !== 'number') {
      i += 1;
      continue;
    }
    const next = w.get(i + 1);
    if (next instanceof PdfArray || (next instanceof PdfRef && resolve(objects, next) instanceof PdfArray)) {
      const arr = next instanceof PdfArray ? next : (resolve(objects, next as PdfRef) as PdfArray);
      for (let j = 0; j < arr.length; j++) {
        const wv = arr.get(j);
        if (typeof wv === 'number') widths.set(c1 + j, wv);
      }
      i += 2;
    } else if (typeof next === 'number' && typeof w.get(i + 2) === 'number') {
      const c2 = next;
      const wv = w.get(i + 2) as number;
      for (let c = c1; c <= c2; c++) widths.set(c, wv);
      i += 3;
    } else {
      i += 1;
    }
  }
  return widths;
}

async function resolveStream(
  value: PdfPrimitive | undefined | null,
  objects: Map<string, PdfPrimitive>,
): Promise<Uint8Array | null> {
  if (!value) return null;
  let obj: PdfPrimitive = value;
  if (obj instanceof PdfRef) obj = resolve(objects, obj);
  if (obj instanceof PdfStream) {
    try {
      return await decodeStream(obj.rawBytes, obj.dict);
    } catch {
      return obj.rawBytes;
    }
  }
  return null;
}

function resolveDict(
  value: PdfPrimitive | undefined | null,
  objects: Map<string, PdfPrimitive>,
): PdfDict | null {
  if (!value) return null;
  let obj: PdfPrimitive = value;
  if (obj instanceof PdfRef) obj = resolve(objects, obj);
  return obj instanceof PdfDict ? obj : null;
}

export interface DecodedGlyph {
  charCode: number;
  unicode: string;
  width1000: number;
}

/** Decode a PDF text string (latin1 bytes) into glyphs using font maps. */
export function decodeTextString(raw: string, font: LoadedFont | undefined): DecodedGlyph[] {
  const bytes = latin1ToBytes(raw);
  const glyphs: DecodedGlyph[] = [];
  if (bytes.length === 0) return glyphs;

  const isComposite = font?.isComposite ?? false;
  const codeBytes = font?.codeBytes ?? (isComposite ? 2 : 1);
  let idx = 0;

  while (idx < bytes.length) {
    let charCode: number;
    if (isComposite || codeBytes >= 2) {
      if (idx + 1 < bytes.length) {
        charCode = (bytes[idx]! << 8) | bytes[idx + 1]!;
        idx += 2;
      } else {
        charCode = bytes[idx]!;
        idx += 1;
      }
    } else {
      charCode = bytes[idx]!;
      idx += 1;
    }

    const unicode = mapCharToUnicode(charCode, font, isComposite);
    // Skip null/control from broken Identity-H half-bytes (except tab/newline)
    if (!unicode || (unicode.length === 1 && unicode.charCodeAt(0) === 0)) {
      continue;
    }

    const widthKey =
      isComposite && font?.toCID.has(charCode) ? font.toCID.get(charCode)! : charCode;
    let width1000 = font?.widths.get(widthKey);
    if (width1000 === undefined) width1000 = font?.widths.get(charCode);
    if (width1000 === undefined && unicode) {
      width1000 = font?.widths.get(unicode.charCodeAt(0));
    }
    width1000 = width1000 ?? font?.defaultWidth ?? 500;

    glyphs.push({ charCode, unicode, width1000 });
  }
  return glyphs;
}

function mapCharToUnicode(
  charCode: number,
  font: LoadedFont | undefined,
  isComposite: boolean,
): string {
  if (!font) {
    return charCode <= 0xff ? String.fromCharCode(charCode) : String.fromCharCode(charCode & 0xff);
  }

  const diffName = !isComposite ? font.differences.get(charCode) : undefined;
  if (diffName) {
    if (AGL[diffName]) return AGL[diffName]!;
    if (diffName.length === 1) return diffName;
  }

  const fromTu = font.toUnicode.get(charCode);
  if (fromTu) return fromTu;

  if (!isComposite) {
    if (
      (font.encoding === 'WinAnsiEncoding' ||
        font.encoding === 'MacRomanEncoding' ||
        !font.encoding) &&
      WIN_ANSI[charCode]
    ) {
      return String.fromCodePoint(WIN_ANSI[charCode]!);
    }
    if (charCode >= 0x20 && charCode <= 0xff) return String.fromCharCode(charCode);
  }

  // Composite without ToUnicode: last resort — low byte as Latin-1 (often wrong)
  if (charCode <= 0xff) return String.fromCharCode(charCode);
  const lo = charCode & 0xff;
  if (lo >= 0x20 && lo <= 0x7e) return String.fromCharCode(lo);
  return '';
}
