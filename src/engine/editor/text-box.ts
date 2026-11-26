/**
 * Formatted text boxes.
 *
 * One layout routine feeds both the on-screen preview and the PDF writer, so a
 * box breaks lines, aligns, spaces and decorates text identically in both.
 * Glyph advances come from the Standard 14 AFM metrics, which every PDF viewer
 * ships, so the exported file needs no embedded font and looks the same in
 * any reader.
 */

import { PDFDict, PDFName, PDFString, type PDFObject, type PDFPageInfo, PDFRef } from '../types';
import { resolveRef } from '../parser/parser';
import { getStandardFont } from '../fonts/standard14';
import { serializeToString } from './stream-compiler';

export type TextBoxAlign = 'left' | 'center' | 'right' | 'justify';
export type TextBoxList = 'none' | 'bullet' | 'numbered';
export type TextBoxFamily = 'Helvetica' | 'Times' | 'Courier';

export interface TextBoxStyle {
  /** UI family name; mapped onto Helvetica, Times or Courier. */
  fontFamily: string;
  /** Font size in PDF points. */
  fontSize: number;
  /** Text colour as #rrggbb. */
  color: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  /** Highlight (background) colour as #rrggbb, or null for none. */
  highlight: string | null;
  align: TextBoxAlign;
  /** Line height as a multiple of the font size. */
  lineHeight: number;
  /** Extra space after every character, in PDF points (PDF Tc, CSS letter-spacing). */
  letterSpacing: number;
  list: TextBoxList;
}

export const DEFAULT_TEXT_BOX_STYLE: TextBoxStyle = {
  fontFamily: 'Helvetica',
  fontSize: 12,
  color: '#000000',
  bold: false,
  italic: false,
  underline: false,
  strikethrough: false,
  highlight: null,
  align: 'left',
  lineHeight: 1.2,
  letterSpacing: 0,
  list: 'none',
};

export const TEXT_BOX_FONTS: { value: string; label: string }[] = [
  { value: 'Helvetica', label: 'Helvetica' },
  { value: 'Times New Roman', label: 'Times New Roman' },
  { value: 'Courier', label: 'Courier' },
];

export const LINE_HEIGHT_PRESETS = [1, 1.15, 1.2, 1.5, 2];

/** Map any UI family onto one of the three Standard 14 families. */
export function textBoxFamily(family: string): TextBoxFamily {
  const l = family.toLowerCase();
  if (/courier|mono|consolas|lucida console/.test(l)) return 'Courier';
  if (/times|georgia|garamond|palatino|cambria|serif/.test(l) && !/sans/.test(l)) return 'Times';
  return 'Helvetica';
}

/** Standard 14 base font name for a family and style. */
export function textBoxFace(family: string, bold: boolean, italic: boolean): string {
  const f = textBoxFamily(family);
  if (f === 'Times') {
    if (bold && italic) return 'Times-BoldItalic';
    if (bold) return 'Times-Bold';
    if (italic) return 'Times-Italic';
    return 'Times-Roman';
  }
  const suffix = bold && italic ? '-BoldOblique' : bold ? '-Bold' : italic ? '-Oblique' : '';
  return `${f}${suffix}`;
}

/** CSS font-family whose metrics match the Standard 14 family. */
export function textBoxCssFamily(family: string): string {
  switch (textBoxFamily(family)) {
    case 'Times': return '"Times New Roman", Times, "Liberation Serif", serif';
    case 'Courier': return '"Courier New", Courier, "Liberation Mono", monospace';
    default: return 'Helvetica, Arial, "Liberation Sans", sans-serif';
  }
}

/** Unicode → WinAnsiEncoding byte for the characters outside Latin-1. */
const WIN_ANSI_EXTRA: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86,
  0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c,
  0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95,
  0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** AFM widths for the WinAnsi 0x80–0x9F glyphs the Helvetica tables leave at the default. */
const HELVETICA_EXTRA_WIDTHS: Record<number, [number, number]> = {
  // code: [regular, bold]
  0x80: [556, 556], 0x82: [222, 278], 0x84: [333, 500], 0x85: [1000, 1000], 0x86: [556, 556],
  0x87: [556, 556], 0x89: [1000, 1000], 0x91: [222, 278], 0x92: [222, 278], 0x93: [333, 500],
  0x94: [333, 500], 0x95: [350, 350], 0x96: [556, 556], 0x97: [1000, 1000], 0x99: [1000, 1000],
};

/** Encode text as WinAnsi bytes (one char per byte); unsupported characters become '?'. */
export function encodeWinAnsi(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) out += String.fromCharCode(cp);
    else if (WIN_ANSI_EXTRA[cp] != null) out += String.fromCharCode(WIN_ANSI_EXTRA[cp]);
    else if (cp === 0x09) out += ' ';
    else out += '?';
  }
  return out;
}

/** Advance width of one WinAnsi byte in 1/1000 em. */
function glyphWidth(face: string, code: number): number {
  const metrics = getStandardFont(face);
  if (!metrics) return 600;
  if (face.startsWith('Helvetica') && HELVETICA_EXTRA_WIDTHS[code]) {
    return HELVETICA_EXTRA_WIDTHS[code][face.includes('Bold') ? 1 : 0];
  }
  return metrics.widths[code] || metrics.defaultWidth;
}

/**
 * Visible width of a string in points: glyph advances, letter spacing between
 * characters (PDF Tc / CSS letter-spacing, not counted after the last one, so
 * centring and underlines follow the ink) and word spacing after every space
 * (PDF Tw / CSS word-spacing).
 */
export function measureTextBoxString(
  text: string, face: string, fontSize: number, letterSpacing = 0, wordSpacing = 0,
): number {
  const bytes = encodeWinAnsi(text);
  let w = 0;
  for (let i = 0; i < bytes.length; i++) {
    const code = bytes.charCodeAt(i);
    w += (glyphWidth(face, code) * fontSize) / 1000 + letterSpacing;
    if (code === 32) w += wordSpacing;
  }
  return bytes.length > 0 ? w - letterSpacing : w;
}

export interface TextBoxLine {
  text: string;
  /** Left edge of the text from the box's left edge, in points. */
  x: number;
  /** Baseline from the box's top edge, in points (downwards). */
  baseline: number;
  /** Width of the text including letter and word spacing. */
  width: number;
  /** Extra space added to each space character (justify). */
  wordSpacing: number;
  /** List marker ("•" or "3.") drawn at markerX on the first line of a paragraph. */
  marker?: string;
  markerX?: number;
}

export interface TextBoxLayout {
  lines: TextBoxLine[];
  /** Box width (the fixed width when given, else the widest line). */
  width: number;
  height: number;
  face: string;
  /** Ascent above the baseline, in points. */
  ascent: number;
  /** Highlight / selection band height per line, in points. */
  bandHeight: number;
  /** Left indent for list paragraphs (0 when no list). */
  indent: number;
}

/** Fill in missing style fields from the defaults. */
export function resolveTextBoxStyle(style: Partial<TextBoxStyle>): TextBoxStyle {
  const s = { ...DEFAULT_TEXT_BOX_STYLE };
  for (const [k, v] of Object.entries(style)) {
    if (v !== undefined) (s as Record<string, unknown>)[k] = v;
  }
  return s;
}

function wrapParagraph(
  words: string[], maxWidth: number, measure: (s: string) => number,
): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const word of words) {
    const candidate = cur === '' ? word : `${cur} ${word}`;
    if (cur !== '' && measure(candidate) > maxWidth) {
      lines.push(cur);
      cur = word;
    } else {
      cur = candidate;
    }
    // A single word wider than the box is broken by character.
    while (measure(cur) > maxWidth && cur.length > 1) {
      let cut = cur.length - 1;
      while (cut > 1 && measure(cur.slice(0, cut)) > maxWidth) cut--;
      lines.push(cur.slice(0, cut));
      cur = cur.slice(cut);
    }
  }
  lines.push(cur);
  return lines;
}

/**
 * Lay out a text box. `maxWidth` (points) wraps lines; without it each
 * paragraph is one line and the box is as wide as its widest line.
 */
export function layoutTextBox(
  text: string, styleIn: Partial<TextBoxStyle>, maxWidth?: number,
): TextBoxLayout {
  const style = resolveTextBoxStyle(styleIn);
  const size = style.fontSize;
  const face = textBoxFace(style.fontFamily, style.bold, style.italic);
  const metrics = getStandardFont(face)!;
  const emHeight = metrics.ascent - metrics.descent;
  const ascent = (metrics.ascent / emHeight) * size;
  const lineAdvance = size * style.lineHeight;
  const ls = style.letterSpacing;
  const measure = (s: string) => measureTextBoxString(s, face, size, ls);

  const paragraphs = text.replace(/\r\n?/g, '\n').split('\n');
  const markers: (string | undefined)[] = [];
  let n = 0;
  for (const p of paragraphs) {
    if (style.list === 'none' || p.trim() === '') { markers.push(undefined); continue; }
    n += 1;
    markers.push(style.list === 'bullet' ? '\u2022' : `${n}.`);
  }
  const markerGap = size * 0.5;
  let indent = 0;
  if (style.list !== 'none') {
    const widest = markers.reduce((m, mk) => Math.max(m, mk ? measure(mk) : 0), 0);
    indent = Math.max(size * 1.5, widest + markerGap);
  }

  const wrapWidth = maxWidth != null ? Math.max(size, maxWidth - indent) : undefined;
  const raw: { text: string; last: boolean; marker?: string }[] = [];
  paragraphs.forEach((p, pi) => {
    const pieces = wrapWidth != null ? wrapParagraph(p.split(' '), wrapWidth, measure) : [p];
    pieces.forEach((t, i) => raw.push({
      text: t, last: i === pieces.length - 1, marker: i === 0 ? markers[pi] : undefined,
    }));
  });

  const natural = raw.reduce((m, l) => Math.max(m, measure(l.text)), 0);
  const boxWidth = maxWidth ?? natural + indent;
  const contentWidth = boxWidth - indent;
  const halfLeading = (lineAdvance - size) / 2;

  const lines: TextBoxLine[] = raw.map((l, i) => {
    const baseline = i * lineAdvance + halfLeading + ascent;
    let width = measure(l.text);
    let wordSpacing = 0;
    let x = indent;
    const slack = contentWidth - width;
    if (style.align === 'center') x += slack / 2;
    else if (style.align === 'right') x += slack;
    else if (style.align === 'justify' && !l.last && wrapWidth != null) {
      const spaces = (l.text.match(/ /g) || []).length;
      if (spaces > 0 && slack > 0) {
        wordSpacing = slack / spaces;
        width = contentWidth;
      }
    }
    const line: TextBoxLine = { text: l.text, x, baseline, width, wordSpacing };
    if (l.marker) {
      line.marker = l.marker;
      line.markerX = indent - markerGap - measure(l.marker);
    }
    return line;
  });

  return {
    lines,
    width: boxWidth,
    height: Math.max(1, lines.length) * lineAdvance,
    face,
    ascent,
    bandHeight: size,
    indent,
  };
}

/** Underline / strikethrough rectangles relative to a baseline: [offset below baseline, thickness]. */
export function decorationGeometry(fontSize: number) {
  return {
    underline: { offset: fontSize * 0.1, thickness: Math.max(0.5, fontSize * 0.05) },
    strike: { offset: -fontSize * 0.3, thickness: Math.max(0.5, fontSize * 0.05) },
  };
}

function hexToRgb01(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h.padEnd(6, '0');
  return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16) / 255) as [number, number, number];
}

const num = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
};

/** Ensure a WinAnsi Standard 14 font resource exists on the page; returns its name. */
function ensureFaceResource(page: PDFPageInfo, objects: Map<string, PDFObject>, face: string): string {
  const resourcesObj = page.dict.get('Resources');
  let resources = resourcesObj instanceof PDFRef ? resolveRef(resourcesObj, objects) : resourcesObj;
  if (!(resources instanceof PDFDict)) {
    resources = new PDFDict();
    page.dict.set('Resources', resources);
  }
  const fontObj = (resources as PDFDict).get('Font');
  let fontDict = fontObj instanceof PDFRef ? resolveRef(fontObj, objects) : fontObj;
  if (!(fontDict instanceof PDFDict)) {
    fontDict = new PDFDict();
    (resources as PDFDict).set('Font', fontDict);
  }
  const name = `BTB-${face}`;
  if (!(fontDict as PDFDict).has(name)) {
    const f = new PDFDict();
    f.set('Type', new PDFName('Font'));
    f.set('Subtype', new PDFName('Type1'));
    f.set('BaseFont', new PDFName(face));
    f.set('Encoding', new PDFName('WinAnsiEncoding'));
    (fontDict as PDFDict).set(name, f);
  }
  return name;
}

/**
 * Build the content-stream operators that draw a formatted text box whose
 * top-left corner is at (left, top) in PDF user space.
 */
export function buildTextBoxOperators(
  layout: TextBoxLayout, styleIn: Partial<TextBoxStyle>, left: number, top: number, fontResource: string,
): string {
  const style = resolveTextBoxStyle(styleIn);
  const size = style.fontSize;
  const [r, g, b] = hexToRgb01(style.color);
  const deco = decorationGeometry(size);
  const out: string[] = ['q'];

  if (style.highlight) {
    const [hr, hg, hb] = hexToRgb01(style.highlight);
    out.push(`${num(hr)} ${num(hg)} ${num(hb)} rg`);
    for (const l of layout.lines) {
      if (l.text === '' && !l.marker) continue;
      const x0 = left + (l.marker ? l.markerX! : l.x);
      const x1 = left + l.x + l.width;
      const yTop = top - (l.baseline - layout.ascent);
      out.push(`${num(x0)} ${num(yTop - layout.bandHeight)} ${num(x1 - x0)} ${num(layout.bandHeight)} re f`);
    }
  }

  out.push(`${num(r)} ${num(g)} ${num(b)} rg`);
  out.push('BT', `/${fontResource} ${num(size)} Tf`, `${num(style.letterSpacing)} Tc`);
  let curTw = 0;
  out.push('0 Tw');
  for (const l of layout.lines) {
    const y = top - l.baseline;
    if (l.marker) {
      if (curTw !== 0) { out.push('0 Tw'); curTw = 0; }
      out.push(`1 0 0 1 ${num(left + l.markerX!)} ${num(y)} Tm`);
      out.push(`${serializeToString(new PDFString(encodeWinAnsi(l.marker)))} Tj`);
    }
    if (l.text === '') continue;
    if (l.wordSpacing !== curTw) { out.push(`${num(l.wordSpacing)} Tw`); curTw = l.wordSpacing; }
    out.push(`1 0 0 1 ${num(left + l.x)} ${num(y)} Tm`);
    out.push(`${serializeToString(new PDFString(encodeWinAnsi(l.text)))} Tj`);
  }
  out.push('ET');

  for (const l of layout.lines) {
    if (l.text === '') continue;
    const y = top - l.baseline;
    if (style.underline) {
      out.push(`${num(left + l.x)} ${num(y - deco.underline.offset - deco.underline.thickness)} ${num(l.width)} ${num(deco.underline.thickness)} re f`);
    }
    if (style.strikethrough) {
      out.push(`${num(left + l.x)} ${num(y - deco.strike.offset - deco.strike.thickness / 2)} ${num(l.width)} ${num(deco.strike.thickness)} re f`);
    }
  }
  out.push('Q');
  return `\n${out.join('\n')}\n`;
}

/**
 * Append a formatted text box to a page content stream. (left, top) is the
 * box's top-left corner in PDF user space; `maxWidth` wraps lines.
 */
export function insertTextBox(
  contentBytes: Uint8Array,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  text: string,
  style: Partial<TextBoxStyle>,
  left: number,
  top: number,
  maxWidth?: number,
): Uint8Array {
  const layout = layoutTextBox(text, style, maxWidth);
  const resource = ensureFaceResource(page, objects, layout.face);
  // Strings are written with octal escapes, so the operators are pure ASCII.
  const raw = new TextEncoder().encode(buildTextBoxOperators(layout, style, left, top, resource));
  const merged = new Uint8Array(contentBytes.length + raw.length);
  merged.set(contentBytes);
  merged.set(raw, contentBytes.length);
  return merged;
}
