/**
 * Content Stream Interpreter
 *
 * Walks the parsed content stream instructions and maintains the full
 * PDF graphics state machine. Produces a display list of positioned
 * text runs, paths, and image references with their exact bounding boxes.
 *
 * This is the heart of the text extraction and layout understanding engine.
 * Every text character that appears on a PDF page is ultimately positioned
 * by this interpreter.
 */

import { parseContentStream, type CSInstruction } from './operator-lexer';
import { parseCMap } from '../fonts/cmap-parser';
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFStream,
  PDFString,
} from '../types';
import type { PDFPageInfo } from '../types';
import { resolveRef, getResource } from '../parser/parser';
import { getStandardFont } from '../fonts/standard14';
import {
  isSuspiciousDingbatToUnicode,
  isSymbolFont,
  isZapfDingbatsFont,
  symbolCharToUnicode,
  unicodeFromGlyphId,
  zapfDingbatsCharToUnicode,
  ZAPF_DINGBATS_GLYPH_TO_UNICODE,
} from '../fonts/dingbat-encodings';
import { parseTTF, isTrueTypeFontData } from '../fonts/truetype-parser';
import { isCFFData, wrapCFFInOTF } from '../fonts/cff-wrapper';
import {
  normalizeIndicText,
  reorderIndicGlyphs,
  repairIndicRuns,
  isLegacyIndicFont,
  convertKrutiDevToUnicode,
} from '../fonts/indic-normalizer';

// ─── Graphics State ─────────────────────────────────────────────────────────

export interface Matrix {
  a: number; b: number;  // | a b 0 |
  c: number; d: number;  // | c d 0 |
  e: number; f: number;  // | e f 1 |
}

function identityMatrix(): Matrix {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

function multiplyMatrices(m1: Matrix, m2: Matrix): Matrix {
  return {
    a: m1.a * m2.a + m1.b * m2.c,
    b: m1.a * m2.b + m1.b * m2.d,
    c: m1.c * m2.a + m1.d * m2.c,
    d: m1.c * m2.b + m1.d * m2.d,
    e: m1.e * m2.a + m1.f * m2.c + m2.e,
    f: m1.e * m2.b + m1.f * m2.d + m2.f,
  };
}

function transformPoint(m: Matrix, x: number, y: number): [number, number] {
  return [
    m.a * x + m.c * y + m.e,
    m.b * x + m.d * y + m.f,
  ];
}

export interface GraphicsState {
  ctm: Matrix;                  // Current Transformation Matrix
  // Color state
  fillColor: [number, number, number]; // RGB
  strokeColor: [number, number, number];
  fillAlpha: number;
  strokeAlpha: number;
  blendMode: string;
  softMask: PDFDict | null;
  // Line state
  lineWidth: number;
  lineCap: number;
  lineJoin: number;
  miterLimit: number;
  dashPattern: number[];
  dashPhase: number;
  // Text state
  textFont: string;             // Font resource name (e.g., 'F1')
  textFontSize: number;
  charSpacing: number;
  wordSpacing: number;
  horizontalScaling: number;    // Tz: percentage (default 100)
  textLeading: number;          // TL
  textRenderMode: number;       // Tr
  textRise: number;             // Ts
  // Clipping
  clipPaths: ClipPathNode[];
}

export interface ClipPathNode {
  segments: PathSegment[];
  windingRule: 'nonzero' | 'evenodd';
}

function defaultGraphicsState(): GraphicsState {
  return {
    ctm: identityMatrix(),
    fillColor: [0, 0, 0],
    strokeColor: [0, 0, 0],
    fillAlpha: 1,
    strokeAlpha: 1,
    lineWidth: 1,
    lineCap: 0,
    lineJoin: 0,
    miterLimit: 10,
    dashPattern: [],
    dashPhase: 0,
    textFont: '',
    textFontSize: 12,
    charSpacing: 0,
    wordSpacing: 0,
    horizontalScaling: 100,
    textLeading: 0,
    textRenderMode: 0,
    textRise: 0,
    blendMode: 'Normal',
    softMask: null,
    clipPaths: [],
  };
}

function cloneGraphicsState(gs: GraphicsState): GraphicsState {
  return {
    ...gs,
    ctm: { ...gs.ctm },
    fillColor: [...gs.fillColor] as [number, number, number],
    strokeColor: [...gs.strokeColor] as [number, number, number],
    dashPattern: [...gs.dashPattern],
    clipPaths: [...gs.clipPaths],
  };
}

// ─── Display list items ─────────────────────────────────────────────────────

export interface TextRun {
  type: 'text';
  /** The Unicode text content */
  text: string;
  /** Individual glyph positions */
  glyphs: GlyphPosition[];
  /** Original text-showing instruction indices that produced this run */
  sourceInstructionIndices?: number[];
  /** Bounding box in page space (PDF coordinates: origin bottom-left) */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Font resource name */
  fontName: string;
  fontSize: number;
  /** The full transformation matrix at the time of rendering */
  textMatrix: Matrix;
  /** Color */
  fillColor: [number, number, number];
  fillAlpha: number;
  /** Is underlined */
  isUnderline?: boolean;
  blendMode: string;
  softMask: PDFDict | null;
  clipPaths: ClipPathNode[];
}

export interface GlyphPosition {
  /** Character code as stored in the PDF */
  charCode: number;
  /** Unicode string for this glyph */
  unicode: string;
  /** X position in page space */
  x: number;
  /** Y position in page space */
  y: number;
  /** Advance width in page space */
  width: number;
  /** Font size in page space */
  fontSize: number;
  /** Width of the glyph in Text Space (w0/1000) */
  textSpaceWidth: number;
  /** Text Rendering Matrix (T_rm) which exactly places and scales the glyph in User Space */
  tRm: { a: number; b: number; c: number; d: number; e: number; f: number };
  /**
   * True when `unicode` comes from a marked-content /ActualText span (PDF 14.9.4):
   * the first glyph of the span carries the whole replacement text and the rest
   * carry ''. Such text is already in logical order and must not be reordered.
   */
  actualText?: boolean;
  /**
   * Pen x (tRm.e) where the PDF draws this glyph, kept when Indic repair moves
   * the glyph's logical position onto its pre-base vowel sign.
   */
  originalE?: number;
}

/** Open /ActualText span: the replacement text goes to the first glyph shown inside it. */
interface ActualTextSpan {
  text: string;
  consumed: boolean;
}

/** Decode a PDF text string (UTF-16BE with BOM, UTF-8 with BOM, or PDFDocEncoding ≈ Latin-1). */
function decodePdfTextString(obj: PDFObject | undefined): string | null {
  let bytes: Uint8Array;
  if (obj instanceof PDFString || obj instanceof PDFHexString) bytes = obj.toBytes();
  else return null;
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let s = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return s;
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

export interface PathSegment {
  type: 'M' | 'L' | 'C' | 'Z'; // moveTo, lineTo, curveTo, closePath
  points: number[]; // [x,y] for M/L, [x1,y1,x2,y2,x3,y3] for C
}

export interface PathItem {
  type: 'path';
  segments: PathSegment[];
  strokeColor: [number, number, number] | null;
  fillColor: [number, number, number] | null;
  strokeAlpha: number;
  fillAlpha: number;
  lineWidth: number;
  paintType: 'stroke' | 'fill' | 'both' | 'none';
  x: number;
  y: number;
  width: number;
  height: number;
  blendMode: string;
  softMask: PDFDict | null;
  clipPaths: ClipPathNode[];
}

export interface ImageItem {
  type: 'image';
  /** Resource name from /Do operator */
  name: string;
  /** Transform matrix positioning the image */
  ctm: Matrix;
  x: number;
  y: number;
  width: number;
  height: number;
  blendMode: string;
  softMask: PDFDict | null;
  clipPaths: ClipPathNode[];
  /** Index of the Do instruction in the content stream (for precise edit/delete). */
  sourceInstructionIndex?: number;
}

export interface FormItem {
  type: 'form';
  /** Resource name from /Do operator */
  name: string;
  /** Transform matrix positioning the form */
  ctm: Matrix;
  blendMode: string;
  softMask: PDFDict | null;
  clipPaths: ClipPathNode[];
}

export interface ShadingItem {
  type: 'shading';
  name: string;
  ctm: Matrix;
  blendMode: string;
  softMask: PDFDict | null;
  clipPaths: ClipPathNode[];
}

export type DisplayItem = TextRun | PathItem | ImageItem | FormItem | ShadingItem;

// ─── Font info cache ────────────────────────────────────────────────────────

export interface FontInfo {
  name: string;
  baseFont: string;
  subtype: string; // Type1, TrueType, Type0, CIDFontType2, etc.
  encoding: string;
  isComposite: boolean;
  /** Maps char code → Unicode string */
  toUnicode: Map<number, string> | null;
  /** Maps char code → CID for composite fonts */
  toCID: Map<number, number> | null;
  /** Glyph widths: code → width in 1/1000 units of font size */
  widths: Map<number, number>;
  /** Default width for missing entries */
  defaultWidth: number;
  /** First char code with a width entry */
  firstChar: number;
  /** Last char code with a width entry */
  lastChar: number;
  /** Encoding Differences: charCode → glyph name */
  differences: Map<number, string>;
  /**
   * Identity-H / embedded-font fallback: CID or glyph ID → Unicode.
   * Used when ToUnicode is missing (e.g. Symbol bullet GID → "•").
   */
  cidToUnicode: Map<number, string> | null;
}

// ─── WinAnsiEncoding (Windows-1252) byte → Unicode mapping for 0x80–0x9F ────
// These 32 bytes differ from direct Unicode code points.
const WIN_ANSI_TO_UNICODE: Record<number, number> = {
  0x80: 0x20AC, // € Euro sign
  0x82: 0x201A, // ‚ Single low-9 quotation mark
  0x83: 0x0192, // ƒ Latin small letter f with hook
  0x84: 0x201E, // „ Double low-9 quotation mark
  0x85: 0x2026, // … Horizontal ellipsis
  0x86: 0x2020, // † Dagger
  0x87: 0x2021, // ‡ Double dagger
  0x88: 0x02C6, // ˆ Modifier letter circumflex accent
  0x89: 0x2030, // ‰ Per mille sign
  0x8A: 0x0160, // Š Latin capital letter S with caron
  0x8B: 0x2039, // ‹ Single left-pointing angle quotation mark
  0x8C: 0x0152, // Œ Latin capital ligature OE
  0x8E: 0x017D, // Ž Latin capital letter Z with caron
  0x91: 0x2018, // ' Left single quotation mark
  0x92: 0x2019, // ' Right single quotation mark
  0x93: 0x201C, // " Left double quotation mark
  0x94: 0x201D, // " Right double quotation mark
  0x95: 0x2022, // • Bullet
  0x96: 0x2013, // – En dash
  0x97: 0x2014, // — Em dash
  0x98: 0x02DC, // ˜ Small tilde
  0x99: 0x2122, // ™ Trade mark sign
  0x9A: 0x0161, // š Latin small letter s with caron
  0x9B: 0x203A, // › Single right-pointing angle quotation mark
  0x9C: 0x0153, // œ Latin small ligature oe
  0x9E: 0x017E, // ž Latin small letter z with caron
  0x9F: 0x0178, // Ÿ Latin capital letter Y with diaeresis
};

// ─── Adobe Glyph Name → Unicode mapping (common subset) ─────────────────────
const GLYPH_NAME_TO_UNICODE: Record<string, string> = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#',
  dollar: '$', percent: '%', ampersand: '&', quotesingle: "'",
  parenleft: '(', parenright: ')', asterisk: '*', plus: '+',
  comma: ',', hyphen: '-', period: '.', slash: '/',
  zero: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  colon: ':', semicolon: ';', less: '<', equal: '=',
  greater: '>', question: '?', at: '@',
  A: 'A', B: 'B', C: 'C', D: 'D', E: 'E', F: 'F', G: 'G',
  H: 'H', I: 'I', J: 'J', K: 'K', L: 'L', M: 'M', N: 'N',
  O: 'O', P: 'P', Q: 'Q', R: 'R', S: 'S', T: 'T', U: 'U',
  V: 'V', W: 'W', X: 'X', Y: 'Y', Z: 'Z',
  bracketleft: '[', backslash: '\\', bracketright: ']',
  asciicircum: '^', underscore: '_', grave: '`',
  a: 'a', b: 'b', c: 'c', d: 'd', e: 'e', f: 'f', g: 'g',
  h: 'h', i: 'i', j: 'j', k: 'k', l: 'l', m: 'm', n: 'n',
  o: 'o', p: 'p', q: 'q', r: 'r', s: 's', t: 't', u: 'u',
  v: 'v', w: 'w', x: 'x', y: 'y', z: 'z',
  braceleft: '{', bar: '|', braceright: '}', asciitilde: '~',
  // Extended Latin
  Agrave: 'À', Aacute: 'Á', Acircumflex: 'Â', Atilde: 'Ã',
  Adieresis: 'Ä', Aring: 'Å', AE: 'Æ', Ccedilla: 'Ç',
  Egrave: 'È', Eacute: 'É', Ecircumflex: 'Ê', Edieresis: 'Ë',
  Igrave: 'Ì', Iacute: 'Í', Icircumflex: 'Î', Idieresis: 'Ï',
  Eth: 'Ð', Ntilde: 'Ñ', Ograve: 'Ò', Oacute: 'Ó',
  Ocircumflex: 'Ô', Otilde: 'Õ', Odieresis: 'Ö', multiply: '×',
  Oslash: 'Ø', Ugrave: 'Ù', Uacute: 'Ú', Ucircumflex: 'Û',
  Udieresis: 'Ü', Yacute: 'Ý', Thorn: 'Þ', germandbls: 'ß',
  agrave: 'à', aacute: 'á', acircumflex: 'â', atilde: 'ã',
  adieresis: 'ä', aring: 'å', ae: 'æ', ccedilla: 'ç',
  egrave: 'è', eacute: 'é', ecircumflex: 'ê', edieresis: 'ë',
  igrave: 'ì', iacute: 'í', icircumflex: 'î', idieresis: 'ï',
  eth: 'ð', ntilde: 'ñ', ograve: 'ò', oacute: 'ó',
  ocircumflex: 'ô', otilde: 'õ', odieresis: 'ö', divide: '÷',
  oslash: 'ø', ugrave: 'ù', uacute: 'ú', ucircumflex: 'û',
  udieresis: 'ü', yacute: 'ý', thorn: 'þ', ydieresis: 'ÿ',
  // Symbols and punctuation
  bullet: '\u2022', endash: '\u2013', emdash: '\u2014',
  ellipsis: '\u2026', quotedblleft: '\u201C', quotedblright: '\u201D',
  quoteleft: '\u2018', quoteright: '\u2019',
  quotesinglbase: '\u201A', quotedblbase: '\u201E',
  dagger: '\u2020', daggerdbl: '\u2021', perthousand: '\u2030',
  guilsinglleft: '\u2039', guilsinglright: '\u203A',
  guillemotleft: '\u00AB', guillemotright: '\u00BB',
  fi: 'fi', fl: 'fl', ff: 'ff', ffi: 'ffi', ffl: 'ffl',
  trademark: '\u2122', copyright: '\u00A9', registered: '\u00AE',
  degree: '\u00B0', plusminus: '\u00B1', mu: '\u00B5',
  paragraph: '\u00B6', section: '\u00A7', Euro: '\u20AC',
  sterling: '\u00A3', yen: '\u00A5', cent: '\u00A2',
  currency: '\u00A4', florin: '\u0192',
  fraction: '\u2044', minus: '\u2212',
  dotlessi: '\u0131', lslash: '\u0142', Lslash: '\u0141',
  OE: '\u0152', oe: '\u0153', Scaron: '\u0160', scaron: '\u0161',
  Zcaron: '\u017D', zcaron: '\u017E', Ydieresis: '\u0178',
  brokenbar: '\u00A6', exclamdown: '\u00A1', questiondown: '\u00BF',
  logicalnot: '\u00AC', ordfeminine: '\u00AA', ordmasculine: '\u00BA',
  onehalf: '\u00BD', onequarter: '\u00BC', threequarters: '\u00BE',
  onesuperior: '\u00B9', twosuperior: '\u00B2', threesuperior: '\u00B3',
  nbspace: '\u00A0', circumflex: '\u02C6', tilde: '\u02DC',
  macron: '\u00AF', breve: '\u02D8', dotaccent: '\u02D9',
  ring: '\u02DA', cedilla: '\u00B8', hungarumlaut: '\u02DD',
  ogonek: '\u02DB', caron: '\u02C7',
};

/**
 * Convert an Adobe glyph name to its Unicode character.
 * Falls back to empty string if unknown.
 */
function glyphNameToUnicode(name: string): string {
  // Direct lookup
  if (GLYPH_NAME_TO_UNICODE[name]) return GLYPH_NAME_TO_UNICODE[name];
  if (ZAPF_DINGBATS_GLYPH_TO_UNICODE[name]) return ZAPF_DINGBATS_GLYPH_TO_UNICODE[name];
  // Try uniXXXX format (e.g., uni2022 → U+2022)
  if (name.startsWith('uni') && name.length === 7) {
    const code = parseInt(name.substring(3), 16);
    if (!isNaN(code) && code > 0) return String.fromCodePoint(code);
  }
  return '';
}

/** Symbols that broken ToUnicode cmaps often emit instead of quotes/punctuation. */
function isObscureSymbol(ch: string): boolean {
  if (!ch || ch.length === 0) return true;
  const cp = ch.codePointAt(0) ?? 0;
  // § ¶ † ‡ ※ ¤ and other marks that rarely appear mid-word in form labels.
  // NOTE: U+2022 (•) bullet is NOT obscure — it's a legitimate list marker.
  // Treating it as obscure caused bullets to be converted to apostrophes.
  return (
    cp === 0x00A7 || cp === 0x00B6 || cp === 0x00A4 ||
    cp === 0x2020 || cp === 0x2021 ||
    cp === 0x203B || cp === 0x00A6 || cp === 0x00AC
  );
}

/**
 * Map a byte value to Unicode using the specified encoding.
 * Handles the critical WinAnsiEncoding 0x80–0x9F range that
 * String.fromCharCode gets wrong.
 */
function encodingCharToUnicode(charCode: number, encoding: string): string {
  // WinAnsiEncoding 0x80–0x9F range has special Unicode mappings.
  // Many PDF producers use these byte values regardless of the stated encoding,
  // so we apply this mapping universally for the 0x80–0x9F range as a first check.
  if (charCode >= 0x80 && charCode <= 0x9F) {
    const mapped = WIN_ANSI_TO_UNICODE[charCode];
    if (mapped) return String.fromCodePoint(mapped);
  }
  // For all other byte values and encodings, direct mapping works
  return String.fromCharCode(charCode);
}

// ─── Interpreter ────────────────────────────────────────────────────────────

export interface InterpreterResult {
  displayList: DisplayItem[];
  textRuns: TextRun[];
  fonts: Map<string, FontInfo>;
}

/**
 * Interpret a page's content streams and produce a display list.
 *
 * @param contentBytes Decoded content stream bytes (concatenated if multiple)
 * @param page Page info for dimensions and resources
 * @param objects Full document object map for resolving references
 */
export function interpretPage(
  contentBytes: Uint8Array,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
): InterpreterResult {
  const instructions = parseContentStream(contentBytes);
  const displayList: DisplayItem[] = [];
  const rawTextRuns: TextRun[] = [];
  const fonts = new Map<string, FontInfo>();

  // State machine
  let gs = defaultGraphicsState();
  const gsStack: GraphicsState[] = [];

  // Text state
  let textMatrix = identityMatrix();     // Tm: text matrix
  let textLineMatrix = identityMatrix(); // For T* and TD tracking
  let inTextBlock = false;

  // Path construction
  let currentPath: PathSegment[] = [];
  let pathStartX = 0;
  let pathStartY = 0;

  // Marked-content nesting (BMC/BDC … EMC). Entries carry an /ActualText span or null.
  const markedContent: (ActualTextSpan | null)[] = [];
  /** Outermost open /ActualText span — it replaces everything shown inside it. */
  const activeActualText = (): ActualTextSpan | undefined => {
    for (const mc of markedContent) if (mc) return mc;
    return undefined;
  };

  // Pre-load fonts from resources
  loadFonts(page.resources, objects, fonts);

  function num(obj: PDFObject | undefined): number {
    return obj instanceof PDFNumber ? obj.value : 0;
  }

  function nameStr(obj: PDFObject | undefined): string {
    return obj instanceof PDFName ? obj.name : '';
  }

  for (let i = 0; i < instructions.length; i++) {
    const inst = instructions[i];
    const ops = inst.operands;

    switch (inst.operator) {
      // ── Graphics state ──────────────────────────────────────────────
      case 'q':
        gsStack.push(cloneGraphicsState(gs));
        break;

      case 'Q':
        if (gsStack.length > 0) gs = gsStack.pop()!;
        break;

      case 'cm': {
        // Concatenate matrix: a b c d e f cm
        const m: Matrix = {
          a: num(ops[0]), b: num(ops[1]),
          c: num(ops[2]), d: num(ops[3]),
          e: num(ops[4]), f: num(ops[5]),
        };
        gs.ctm = multiplyMatrices(m, gs.ctm);
        break;
      }

      case 'w':
        gs.lineWidth = num(ops[0]);
        break;

      case 'J':
        gs.lineCap = num(ops[0]);
        break;

      case 'j':
        gs.lineJoin = num(ops[0]);
        break;

      case 'M':
        gs.miterLimit = num(ops[0]);
        break;

      case 'd': {
        // Dash pattern: [array] phase d
        const arr = ops[0] instanceof PDFArray ? ops[0].asNumbers() : [];
        gs.dashPattern = arr;
        gs.dashPhase = num(ops[1]);
        break;
      }

      case 'gs': {
        // Extended graphics state from resource dictionary
        const gsName = nameStr(ops[0]);
        const gsDict = getResource(page.resources, 'ExtGState', gsName, objects);
        if (gsDict instanceof PDFDict) {
          applyExtGState(gsDict, gs, objects);
        }
        break;
      }

      // ── Color operators ─────────────────────────────────────────────
      case 'g':
        gs.fillColor = [num(ops[0]), num(ops[0]), num(ops[0])];
        break;

      case 'G':
        gs.strokeColor = [num(ops[0]), num(ops[0]), num(ops[0])];
        break;

      case 'rg':
        gs.fillColor = [num(ops[0]), num(ops[1]), num(ops[2])];
        break;

      case 'RG':
        gs.strokeColor = [num(ops[0]), num(ops[1]), num(ops[2])];
        break;

      case 'k': {
        // CMYK fill → approximate RGB
        const [c, m, y, k] = [num(ops[0]), num(ops[1]), num(ops[2]), num(ops[3])];
        gs.fillColor = cmykToRgb(c, m, y, k);
        break;
      }

      case 'K': {
        const [c, m, y, k] = [num(ops[0]), num(ops[1]), num(ops[2]), num(ops[3])];
        gs.strokeColor = cmykToRgb(c, m, y, k);
        break;
      }

      case 'sc':
      case 'scn':
        // Set fill color (generic — assume RGB if 3 operands, gray if 1)
        if (ops.length >= 3) gs.fillColor = [num(ops[0]), num(ops[1]), num(ops[2])];
        else if (ops.length >= 1) gs.fillColor = [num(ops[0]), num(ops[0]), num(ops[0])];
        break;

      case 'SC':
      case 'SCN':
        if (ops.length >= 3) gs.strokeColor = [num(ops[0]), num(ops[1]), num(ops[2])];
        else if (ops.length >= 1) gs.strokeColor = [num(ops[0]), num(ops[0]), num(ops[0])];
        break;

      // ── Text state ──────────────────────────────────────────────────
      case 'Tc':
        gs.charSpacing = num(ops[0]);
        break;

      case 'Tw':
        gs.wordSpacing = num(ops[0]);
        break;

      case 'Tz':
        gs.horizontalScaling = num(ops[0]);
        break;

      case 'TL':
        gs.textLeading = num(ops[0]);
        break;

      case 'Tf':
        gs.textFont = nameStr(ops[0]);
        gs.textFontSize = num(ops[1]);
        break;

      case 'Tr':
        gs.textRenderMode = num(ops[0]);
        break;

      case 'Ts':
        gs.textRise = num(ops[0]);
        break;

      // ── Text blocks ─────────────────────────────────────────────────
      case 'BT':
        inTextBlock = true;
        textMatrix = identityMatrix();
        textLineMatrix = identityMatrix();
        break;

      case 'ET':
        inTextBlock = false;
        break;

      // ── Text positioning ────────────────────────────────────────────
      case 'Td': {
        // Move text position: tx ty Td
        const tx = num(ops[0]);
        const ty = num(ops[1]);
        const m: Matrix = { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
        textLineMatrix = multiplyMatrices(m, textLineMatrix);
        textMatrix = { ...textLineMatrix };
        break;
      }

      case 'TD': {
        // Same as Td but also sets TL = -ty
        const tx = num(ops[0]);
        const ty = num(ops[1]);
        gs.textLeading = -ty;
        const m: Matrix = { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
        textLineMatrix = multiplyMatrices(m, textLineMatrix);
        textMatrix = { ...textLineMatrix };
        break;
      }

      case 'Tm': {
        // Set text matrix directly: a b c d e f Tm
        textMatrix = {
          a: num(ops[0]), b: num(ops[1]),
          c: num(ops[2]), d: num(ops[3]),
          e: num(ops[4]), f: num(ops[5]),
        };
        textLineMatrix = { ...textMatrix };
        break;
      }

      case 'T*': {
        // Move to start of next line (equivalent to 0 -TL Td)
        const m: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: -gs.textLeading };
        textLineMatrix = multiplyMatrices(m, textLineMatrix);
        textMatrix = { ...textLineMatrix };
        break;
      }

      // ── Text showing ────────────────────────────────────────────────
      case 'Tj': {
        // Show a text string
        const strObj = ops[0];
        if (strObj) {
          const result = showTextString(strObj, gs, textMatrix, fonts, objects, page, i, activeActualText());
          if (result) {
            displayList.push(result.run);
            rawTextRuns.push(result.run);
            textMatrix = result.newTextMatrix;
          }
        }
        break;
      }

      case 'TJ': {
        // Show text with individual glyph positioning
        // Operand is an array of strings and numbers
        const arr = ops[0];
        if (arr instanceof PDFArray) {
          let currentGlyphs: GlyphPosition[] = [];
          let currentText = '';
          let firstRun: TextRun | null = null;

          const flushChunk = () => {
            if (firstRun && currentGlyphs.length > 0) {
              let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
              for (let k = 0; k < currentGlyphs.length; k++) {
                const g = currentGlyphs[k];
                if (g.x < minX) minX = g.x;
                if (g.y < minY) minY = g.y;
                if (g.x + g.width > maxX) maxX = g.x + g.width;
                if (g.y + g.fontSize > maxY) maxY = g.y + g.fontSize;
              }
              const run: TextRun = {
                ...firstRun,
                text: currentText,
                glyphs: currentGlyphs,
                x: minX,
                y: minY,
                width: maxX - minX,
                height: maxY - minY,
              };
              displayList.push(run);
              rawTextRuns.push(run);
            }
            currentGlyphs = [];
            currentText = '';
            firstRun = null;
          };

          for (let j = 0; j < arr.length; j++) {
            const item = arr.get(j)!;
            if (item instanceof PDFNumber) {
              // Negative number = move right, positive = move left (in thousandths of text space unit)
              const displacement = -item.value / 1000 * gs.textFontSize * (gs.horizontalScaling / 100);

              // Detect large gap (column jump / table cell separator) to separate runs cleanly
              const isColumnJump = Math.abs(item.value) > 400 || Math.abs(displacement) > Math.max(gs.textFontSize * 1.25, 10);
              if (isColumnJump && currentGlyphs.length > 0) {
                flushChunk();
              }

              textMatrix = {
                ...textMatrix,
                e: textMatrix.e + displacement * textMatrix.a,
                f: textMatrix.f + displacement * textMatrix.b,
              };
            } else {
              const result = showTextString(item, gs, textMatrix, fonts, objects, page, i, activeActualText());
              if (result) {
                if (!firstRun) firstRun = result.run;
                currentGlyphs.push(...result.run.glyphs);
                currentText += result.run.text;
                textMatrix = result.newTextMatrix;
              }
            }
          }
          flushChunk();
        }
        break;
      }

      case "'": {
        // Move to next line and show text: equivalent to T* then Tj
        const m: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: -gs.textLeading };
        textLineMatrix = multiplyMatrices(m, textLineMatrix);
        textMatrix = { ...textLineMatrix };
        const strObj = ops[0];
        if (strObj) {
          const result = showTextString(strObj, gs, textMatrix, fonts, objects, page, i, activeActualText());
          if (result) {
            displayList.push(result.run);
            rawTextRuns.push(result.run);
            textMatrix = result.newTextMatrix;
          }
        }
        break;
      }

      case '"': {
        // Set word/char spacing, move to next line, show text
        gs.wordSpacing = num(ops[0]);
        gs.charSpacing = num(ops[1]);
        const m: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: -gs.textLeading };
        textLineMatrix = multiplyMatrices(m, textLineMatrix);
        textMatrix = { ...textLineMatrix };
        const strObj = ops[2];
        if (strObj) {
          const result = showTextString(strObj, gs, textMatrix, fonts, objects, page, i, activeActualText());
          if (result) {
            displayList.push(result.run);
            rawTextRuns.push(result.run);
            textMatrix = result.newTextMatrix;
          }
        }
        break;
      }

      // ── Path construction ───────────────────────────────────────────
      case 'm': {
        const [x, y] = transformPoint(gs.ctm, num(ops[0]), num(ops[1]));
        currentPath.push({ type: 'M', points: [x, y] });
        pathStartX = x;
        pathStartY = y;
        break;
      }

      case 'l': {
        const [x, y] = transformPoint(gs.ctm, num(ops[0]), num(ops[1]));
        currentPath.push({ type: 'L', points: [x, y] });
        break;
      }

      case 'c': {
        const [x1, y1] = transformPoint(gs.ctm, num(ops[0]), num(ops[1]));
        const [x2, y2] = transformPoint(gs.ctm, num(ops[2]), num(ops[3]));
        const [x3, y3] = transformPoint(gs.ctm, num(ops[4]), num(ops[5]));
        currentPath.push({ type: 'C', points: [x1, y1, x2, y2, x3, y3] });
        break;
      }

      case 'v': {
        // Current point as first control point
        const lastSeg = currentPath[currentPath.length - 1];
        const cx = lastSeg ? lastSeg.points[lastSeg.points.length - 2] : 0;
        const cy = lastSeg ? lastSeg.points[lastSeg.points.length - 1] : 0;
        const [x2, y2] = transformPoint(gs.ctm, num(ops[0]), num(ops[1]));
        const [x3, y3] = transformPoint(gs.ctm, num(ops[2]), num(ops[3]));
        currentPath.push({ type: 'C', points: [cx, cy, x2, y2, x3, y3] });
        break;
      }

      case 'y': {
        // End point as second control point
        const [x1, y1] = transformPoint(gs.ctm, num(ops[0]), num(ops[1]));
        const [x3, y3] = transformPoint(gs.ctm, num(ops[2]), num(ops[3]));
        currentPath.push({ type: 'C', points: [x1, y1, x3, y3, x3, y3] });
        break;
      }

      case 'h':
        currentPath.push({ type: 'Z', points: [] });
        break;

      case 're': {
        // Rectangle: x y width height re
        const rx = num(ops[0]);
        const ry = num(ops[1]);
        const rw = num(ops[2]);
        const rh = num(ops[3]);
        const [p1x, p1y] = transformPoint(gs.ctm, rx, ry);
        const [p2x, p2y] = transformPoint(gs.ctm, rx + rw, ry);
        const [p3x, p3y] = transformPoint(gs.ctm, rx + rw, ry + rh);
        const [p4x, p4y] = transformPoint(gs.ctm, rx, ry + rh);
        currentPath.push({ type: 'M', points: [p1x, p1y] });
        currentPath.push({ type: 'L', points: [p2x, p2y] });
        currentPath.push({ type: 'L', points: [p3x, p3y] });
        currentPath.push({ type: 'L', points: [p4x, p4y] });
        currentPath.push({ type: 'Z', points: [] });
        break;
      }

      // ── Path painting ───────────────────────────────────────────────
      case 'S': emitPath('stroke'); break;
      case 's': { currentPath.push({ type: 'Z', points: [] }); emitPath('stroke'); break; }
      case 'f': case 'F': emitPath('fill'); break;
      case 'f*': emitPath('fill'); break;
      case 'B': emitPath('both'); break;
      case 'B*': emitPath('both'); break;
      case 'b': { currentPath.push({ type: 'Z', points: [] }); emitPath('both'); break; }
      case 'b*': { currentPath.push({ type: 'Z', points: [] }); emitPath('both'); break; }
      case 'W': {
        // Per PDF spec §8.5.4: W modifies the clipping path by intersecting
        // the current path with it. Only add non-degenerate clip paths.
        const wSegments = [...currentPath];
        if (wSegments.length > 0 && !isDegenerateClipPath(wSegments)) {
          gs.clipPaths = [...gs.clipPaths, { segments: wSegments, windingRule: 'nonzero' as const }];
        }
        break;
      }
      case 'W*': {
        const wsSegments = [...currentPath];
        if (wsSegments.length > 0 && !isDegenerateClipPath(wsSegments)) {
          gs.clipPaths = [...gs.clipPaths, { segments: wsSegments, windingRule: 'evenodd' as const }];
        }
        break;
      }
      case 'n': { currentPath = []; break; } // Discard path

      // ── XObjects ────────────────────────────────────────────────────
      case 'Do': {
        const xobjName = nameStr(ops[0]);
        if (xobjName) {
          const xobj = getResource(page.resources, 'XObject', xobjName, objects);
          if (xobj instanceof PDFStream) {
            const subtype = xobj.dict.getName('Subtype');
            if (subtype === 'Image') {
              const imgW = xobj.dict.getNumber('Width') ?? 1;
              const imgH = xobj.dict.getNumber('Height') ?? 1;
              const [x, y] = transformPoint(gs.ctm, 0, 0);
              const [x2, y2] = transformPoint(gs.ctm, 1, 1);
              displayList.push({
                type: 'image',
                name: xobjName,
                ctm: { ...gs.ctm },
                x: Math.min(x, x2),
                y: Math.min(y, y2),
                width: Math.abs(x2 - x),
                height: Math.abs(y2 - y),
                blendMode: gs.blendMode,
                softMask: gs.softMask,
                clipPaths: [...gs.clipPaths],
                sourceInstructionIndex: i,
              });
            } else if (subtype === 'Form') {
              displayList.push({
                type: 'form',
                name: xobjName,
                ctm: { ...gs.ctm },
                blendMode: gs.blendMode,
                softMask: gs.softMask,
                clipPaths: [...gs.clipPaths],
              });
            }
          }
        }
        break;
      }

      // ── Shading ─────────────────────────────────────────────────────
      case 'sh': {
        const shName = nameStr(ops[0]);
        if (shName) {
          displayList.push({
            type: 'shading',
            name: shName,
            ctm: { ...gs.ctm },
            blendMode: gs.blendMode,
            softMask: gs.softMask,
            clipPaths: [...gs.clipPaths],
          });
        }
        break;
      }

      // ── Marked content ──────────────────────────────────────────────
      // Only /ActualText matters for layout: Chromium/Skia wraps every Indic
      // cluster whose glyphs have no 1:1 ToUnicode (conjuncts, reph, ि) in
      // `/Span <</ActualText (…)>> BDC … EMC`; without it the text is lossy.
      case 'BMC':
        markedContent.push(null);
        break;
      case 'BDC': {
        let props: PDFObject | undefined = ops[1];
        if (props instanceof PDFName) props = getResource(page.resources, 'Properties', props.name, objects);
        else if (props instanceof PDFRef) props = resolveRef(props, objects);
        const actual = props instanceof PDFDict ? decodePdfTextString(props.get('ActualText')) : null;
        markedContent.push(actual !== null ? { text: actual, consumed: false } : null);
        break;
      }
      case 'EMC':
        markedContent.pop();
        break;
      case 'MP': case 'DP':
        break;

      // ── Compatibility (skip) ────────────────────────────────────────
      case 'BX': case 'EX':
        break;

      default:
        break;
    }
  }

  function emitPath(paintType: 'stroke' | 'fill' | 'both' | 'none') {
    if (currentPath.length === 0) return;

    const bounds = computePathBounds(currentPath);
    displayList.push({
      type: 'path',
      segments: [...currentPath],
      strokeColor: paintType === 'fill' ? null : [...gs.strokeColor] as [number, number, number],
      fillColor: paintType === 'stroke' ? null : [...gs.fillColor] as [number, number, number],
      strokeAlpha: gs.strokeAlpha,
      fillAlpha: gs.fillAlpha,
      lineWidth: gs.lineWidth,
      paintType,
      blendMode: gs.blendMode,
      softMask: gs.softMask,
      clipPaths: [...gs.clipPaths],
      ...bounds,
    });
    currentPath = [];
  }

  // Apostrophe often arrives as its own Tj ("FATHER" + "§" + "S NAME")
  repairApostrophesAcrossRuns(rawTextRuns);

  // Normalize Devanagari / Indic text runs and syllable order
  repairIndicRuns(rawTextRuns);

  // Merge adjacent text runs on the same baseline to eliminate gaps
  // caused by font-substitution width mismatches between runs.
  mergeAdjacentTextRuns(displayList, rawTextRuns);

  return { displayList, textRuns: rawTextRuns, fonts };
}

/**
 * Merge consecutive text runs that share the same baseline and have a small gap.
 *
 * When a bold run like "sprint boards" is followed by a regular run ", burndown"
 * and they're on the same line, the browser's substitute font for the bold text
 * may be narrower than the PDF's embedded font, creating a visible gap before
 * the comma. Merging them into one run lets the renderer draw them as a single
 * chunk with unified scaling, eliminating the gap.
 */
function mergeAdjacentTextRuns(displayList: DisplayItem[], rawTextRuns: TextRun[]): void {
  let i = 0;
  while (i < displayList.length - 1) {
    const a = displayList[i];
    const b = displayList[i + 1];

    if (a.type !== 'text' || b.type !== 'text') {
      i++;
      continue;
    }

    const runA = a as TextRun;
    const runB = b as TextRun;

    // Skip empty runs
    if (runA.glyphs.length === 0 || runB.glyphs.length === 0) {
      i++;
      continue;
    }

    // Must be on the same baseline (within 0.5pt)
    const baselineA = runA.glyphs[runA.glyphs.length - 1].tRm.f;
    const baselineB = runB.glyphs[0].tRm.f;
    if (Math.abs(baselineA - baselineB) > 0.5) {
      i++;
      continue;
    }

    // Must have a small gap between them (< 0.3 × fontSize)
    const lastGlyphA = runA.glyphs[runA.glyphs.length - 1];
    const firstGlyphB = runB.glyphs[0];
    const fs = runA.fontSize || 12;
    const gapX = firstGlyphB.tRm.e - (lastGlyphA.tRm.e + lastGlyphA.width);

    // Only merge when gap is small (positive) — don't merge overlapping or distant runs
    if (gapX < -fs * 0.05 || gapX > fs * 0.3) {
      i++;
      continue;
    }

    // Must share the same font (merging bold+regular and drawing as one face
    // breaks measureText scaling and recreates gaps before punctuation).
    if (runA.fontName !== runB.fontName) {
      i++;
      continue;
    }

    // Must share the same font size (within 10%)
    const fsB = runB.fontSize || 12;
    if (Math.abs(fs - fsB) / Math.max(fs, fsB) > 0.1) {
      i++;
      continue;
    }

    // Merge B into A — must keep BOTH runs' content-stream indices so edits
    // clear every Tj/TJ fragment. Dropping B's indices leaves ghost text
    // (e.g. "SHASHANK …RATHOUR" + leftover " KUMAR RATHOUR").
    const mergedGlyphs = [...runA.glyphs, ...runB.glyphs];
    const mergedText = runA.text + runB.text;
    const minX = Math.min(runA.x, runB.x);
    const minY = Math.min(runA.y, runB.y);
    const maxX = Math.max(runA.x + runA.width, runB.x + runB.width);
    const maxY = Math.max(runA.y + runA.height, runB.y + runB.height);
    const sourceInstructionIndices = [
      ...(runA.sourceInstructionIndices ?? []),
      ...(runB.sourceInstructionIndices ?? []),
    ];

    const merged: TextRun = {
      ...runA,
      text: mergedText,
      glyphs: mergedGlyphs,
      sourceInstructionIndices: sourceInstructionIndices.length > 0
        ? sourceInstructionIndices
        : undefined,
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    };

    // Replace A with merged, remove B
    displayList[i] = merged;
    displayList.splice(i + 1, 1);

    // Update rawTextRuns
    const idxA = rawTextRuns.indexOf(runA);
    const idxB = rawTextRuns.indexOf(runB);
    if (idxA >= 0) rawTextRuns[idxA] = merged;
    if (idxB >= 0) rawTextRuns.splice(idxB, 1);

    // Don't advance i — check if the merged run can merge with the next one too
  }
}

// ─── Clip path helpers ──────────────────────────────────────────────────────

/**
 * Detect degenerate clip paths that have zero or near-zero area.
 * Such clips would make everything invisible and are usually an artifact
 * of malformed content streams or empty re/m/l sequences.
 */
function isDegenerateClipPath(segments: PathSegment[]): boolean {
  // An empty path is degenerate
  if (segments.length === 0) return true;

  // Collect all points to compute bounds
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let hasPoints = false;

  for (const seg of segments) {
    for (let i = 0; i < seg.points.length; i += 2) {
      const x = seg.points[i];
      const y = seg.points[i + 1];
      if (!isFinite(x) || !isFinite(y)) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      hasPoints = true;
    }
  }

  if (!hasPoints) return true;

  // A clip region smaller than 0.5 user units in either dimension is degenerate
  const width = maxX - minX;
  const height = maxY - minY;
  if (width < 0.5 || height < 0.5) return true;

  return false;
}

// ─── Text rendering helpers ─────────────────────────────────────────────────

interface ShowTextResult {
  run: TextRun;
  newTextMatrix: Matrix;
}

function showTextString(
  strObj: PDFObject,
  gs: GraphicsState,
  textMatrix: Matrix,
  fonts: Map<string, FontInfo>,
  objects: Map<string, PDFObject>,
  page: PDFPageInfo,
  sourceInstructionIndex?: number,
  actualText?: ActualTextSpan,
): ShowTextResult | null {
  const font = fonts.get(gs.textFont);

  // Extract raw bytes from string
  let rawBytes: Uint8Array;
  if (strObj instanceof PDFString) {
    rawBytes = strObj.toBytes();
  } else if (strObj instanceof PDFHexString) {
    rawBytes = strObj.toBytes();
  } else {
    return null;
  }

  if (rawBytes.length === 0) return null;

  let glyphs: GlyphPosition[] = [];
  let text = '';
  let totalWidth = 0;
  const fontSize = gs.textFontSize;
  const hScale = gs.horizontalScaling / 100;

  const isComposite = font?.isComposite ?? false;
  let idx = 0;

  while (idx < rawBytes.length) {
    let charCode: number;

    if (isComposite) {
      // Composite fonts use 2-byte character codes
      if (idx + 1 < rawBytes.length) {
        charCode = (rawBytes[idx] << 8) | rawBytes[idx + 1];
        idx += 2;
      } else {
        charCode = rawBytes[idx];
        idx += 1;
      }
    } else {
      charCode = rawBytes[idx];
      idx += 1;
    }

    // Map to Unicode.
    // Differences→AGL often matches the drawn glyph better than a broken ToUnicode
    // (e.g. apostrophe glyph mapped to U+00A7 § on certificate PDFs). Prefer
    // Differences when present; fall back to ToUnicode, then encoding tables.
    let unicode: string;
    const diffName = !isComposite ? font?.differences?.get(charCode) : undefined;
    const fromDiff = diffName ? glyphNameToUnicode(diffName) : '';
    const fromToUnicode = font?.toUnicode?.get(charCode);

    // ZapfDingbats: PDF viewers always use the dingbat encoding for this font.
    // Broken ToUnicode often maps bullets to Latin "x"/"l" — ignore those.
    const dingbatMapped =
      font && isZapfDingbatsFont(font.baseFont)
        ? zapfDingbatsCharToUnicode(charCode, font.differences)
        : null;

    // Simple Symbol fonts: SymbolSetEncoding (byte 183 = •, not Latin letters).
    const symbolMapped =
      !dingbatMapped && font && isSymbolFont(font.baseFont) && !isComposite
        ? symbolCharToUnicode(charCode, font.differences)
        : null;

    // Identity-H Symbol/CID without ToUnicode: char code is often a glyph ID.
    // Reverse the embedded cmap (e.g. GID 120 → Symbol byte 183 → •).
    const cidMapped =
      !dingbatMapped && !symbolMapped && font?.cidToUnicode?.has(charCode)
        ? font.cidToUnicode.get(charCode)!
        : null;

    if (dingbatMapped) {
      if (fromToUnicode && !isSuspiciousDingbatToUnicode(fromToUnicode)) {
        unicode = fromToUnicode;
      } else {
        unicode = dingbatMapped;
      }
    } else if (symbolMapped) {
      if (fromToUnicode && !isSuspiciousDingbatToUnicode(fromToUnicode)) {
        unicode = fromToUnicode;
      } else {
        unicode = symbolMapped;
      }
    } else if (cidMapped && (!fromToUnicode || isSuspiciousDingbatToUnicode(fromToUnicode))) {
      unicode = cidMapped;
    } else if (fromDiff) {
      unicode = fromDiff;
      // If Differences and ToUnicode disagree and ToUnicode looks like real text
      // while Differences yielded an obscure symbol, keep ToUnicode — but never
      // let ToUnicode override a clear punctuation/letter glyph name with §/¶.
      if (
        fromToUnicode &&
        fromToUnicode !== fromDiff &&
        isObscureSymbol(fromDiff) &&
        !isObscureSymbol(fromToUnicode)
      ) {
        unicode = fromToUnicode;
      }
    } else if (fromToUnicode) {
      unicode = fromToUnicode;
      // Broken ToUnicode sometimes maps quotesingle-slot bytes to §. Prefer
      // WinAnsi/encoding when the cmap yields an obscure symbol for a byte that
      // encoding would treat as a quote or ASCII punctuation.
      if (isObscureSymbol(unicode) && !isComposite) {
        const fromEnc = encodingCharToUnicode(charCode, font?.encoding ?? 'StandardEncoding');
        if (fromEnc && fromEnc !== unicode && !isObscureSymbol(fromEnc)) {
          unicode = fromEnc;
        } else if (charCode === 0x27 || charCode === 0x91 || charCode === 0x92) {
          unicode = charCode === 0x91 ? '\u2018' : charCode === 0x92 ? '\u2019' : "'";
        }
      }
    } else if (!isComposite) {
      // Use encoding-aware mapping (handles WinAnsi 0x80–0x9F correctly)
      unicode = encodingCharToUnicode(charCode, font?.encoding ?? 'StandardEncoding');
      // If result is a C0/C1 control character, it's likely a mis-mapped byte.
      // Fall back to WinAnsi mapping as a heuristic.
      const cp = unicode.codePointAt(0) ?? 0;
      if (cp > 0 && cp < 0x20 && charCode >= 0x80) {
        const winAnsiMapped = WIN_ANSI_TO_UNICODE[charCode];
        if (winAnsiMapped) unicode = String.fromCodePoint(winAnsiMapped);
      }
    } else {
      unicode = String.fromCharCode(charCode);
    }

    // /ActualText replaces the whole span: the first glyph carries it, the rest nothing.
    if (actualText) {
      unicode = actualText.consumed ? '' : actualText.text;
      actualText.consumed = true;
    }

    // Get glyph width (in 1/1000 units of font size)
    const widthKey = isComposite
      ? (font?.encoding !== 'Identity-H' && font?.toCID?.has(charCode)
          ? font.toCID.get(charCode)!
          : charCode)
      : charCode;
    let glyphWidth1000 = font?.widths.get(widthKey);
    if (glyphWidth1000 === undefined && isComposite) {
      glyphWidth1000 = font?.widths.get(charCode);
    }
    if (glyphWidth1000 === undefined && unicode && font?.widths) {
      // If widths were populated from TTF cmap, they are keyed by Unicode, not charCode/CID
      const unicodeCodePoint = unicode.charCodeAt(0);
      glyphWidth1000 = font.widths.get(unicodeCodePoint);
    }
    glyphWidth1000 = glyphWidth1000 ?? font?.defaultWidth ?? 500;

    const glyphWidth = (glyphWidth1000 / 1000) * fontSize * hScale;

    // Compute Trm: T_state * Tm * CTM
    // T_state = [fontSize * hScale, 0, 0, fontSize, 0, textRise]
    const tState: Matrix = {
      a: fontSize * hScale, b: 0,
      c: 0, d: fontSize,
      e: 0, f: gs.textRise,
    };
    const tRm = multiplyMatrices(multiplyMatrices(tState, textMatrix), gs.ctm);

    glyphs.push({
      charCode,
      unicode,
      x: tRm.e,
      y: tRm.f,
      width: (glyphWidth1000 / 1000) * Math.abs(tRm.a || tRm.d),
      fontSize: Math.abs(tRm.d || tRm.a),
      textSpaceWidth: glyphWidth1000 / 1000,
      tRm,
      ...(actualText ? { actualText: true } : {}),
    });

    text += unicode;

    // Advance text position
    let advance = (glyphWidth1000 / 1000) * fontSize + gs.charSpacing;
    // PDF spec: word spacing applies to character code 32 only
    if (charCode === 32) advance += gs.wordSpacing;
    advance *= hScale;

    totalWidth += advance;

    // Update text matrix for next glyph
    textMatrix = {
      ...textMatrix,
      e: textMatrix.e + advance * textMatrix.a,
      f: textMatrix.f + advance * textMatrix.b,
    };
  }

  if (glyphs.length === 0) return null;

  repairObscureApostropheGlyphs(glyphs);

  const isLegacy = font && isLegacyIndicFont(font.baseFont) && !isComposite;
  if (isLegacy) {
    const rawText = glyphs.map(g => g.unicode).join('');
    const convertedText = convertKrutiDevToUnicode(rawText);
    text = convertedText;
  } else {
    glyphs = reorderIndicGlyphs(glyphs);
    text = normalizeIndicText(glyphs.map(g => g.unicode).join(''));
  }

  // Compute bounding box
  const effectiveMatrix = multiplyMatrices(textMatrix, gs.ctm);
  const startX = glyphs[0].x;
  const startY = glyphs[0].y;
  const endGlyph = glyphs[glyphs.length - 1];
  const runWidth = (endGlyph.x + endGlyph.width) - startX;
  const runHeight = fontSize * Math.abs(effectiveMatrix.d || effectiveMatrix.a || 1);

  return {
    run: {
      type: 'text',
      text,
      glyphs,
      sourceInstructionIndices: sourceInstructionIndex !== undefined ? [sourceInstructionIndex] : undefined,
      x: startX,
      y: startY,
      width: Math.abs(runWidth) || totalWidth,
      height: runHeight,
      fontName: gs.textFont,
      fontSize,
      textMatrix: { ...effectiveMatrix },
      fillColor: [...gs.fillColor] as [number, number, number],
      fillAlpha: gs.fillAlpha,
      blendMode: gs.blendMode,
      softMask: gs.softMask,
      clipPaths: [...gs.clipPaths],
    },
    newTextMatrix: textMatrix,
  };
}

/** Obscure-symbol glyph eligible for apostrophe repair (never /ActualText output, which is authoritative). */
function isObscureGlyph(g: GlyphPosition): boolean {
  return !g.actualText && isObscureSymbol(g.unicode);
}

/**
 * Broken ToUnicode/Differences often map apostrophes to §/¶.
 * - Mid-word between letters → '
 * - Lone glyph run that is only an obscure mark → ' (apostrophe is often its own Tj)
 */
function repairObscureApostropheGlyphs(glyphs: GlyphPosition[]): void {
  if (glyphs.length === 0) return;

  const onlyObscure = glyphs.every(
    g => !g.actualText && (!g.unicode || g.unicode === ' ' || g.unicode === '\u00A0' || isObscureSymbol(g.unicode)),
  );
  if (onlyObscure) {
    for (let gi = 0; gi < glyphs.length; gi++) {
      if (isObscureGlyph(glyphs[gi])) {
        glyphs[gi] = { ...glyphs[gi], unicode: "'" };
      }
    }
    return;
  }

  for (let gi = 0; gi < glyphs.length; gi++) {
    if (!isObscureGlyph(glyphs[gi])) continue;
    const prev = gi > 0 ? glyphs[gi - 1].unicode : '';
    const next = gi + 1 < glyphs.length ? glyphs[gi + 1].unicode : '';
    const prevLetter = /[A-Za-z]/.test(prev.slice(-1));
    const nextLetter = /[A-Za-z]/.test(next.charAt(0));
    if (prevLetter && nextLetter) {
      glyphs[gi] = { ...glyphs[gi], unicode: "'" };
    }
  }
}

/**
 * Second pass: apostrophe often arrives as its own text run between
 * "FATHER" and "S NAME". Repair using neighboring runs on the same baseline.
 */
function repairApostrophesAcrossRuns(runs: TextRun[]): void {
  for (let i = 0; i < runs.length; i++) {
    repairObscureApostropheGlyphs(runs[i].glyphs);
    runs[i].text = runs[i].glyphs.map(g => g.unicode).join('');
  }

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (run.glyphs.length === 0) continue;
    const onlyObscure = run.glyphs.every(isObscureGlyph);
    if (!onlyObscure && !run.glyphs.some(isObscureGlyph)) continue;

    // Find nearest letter glyphs on the same baseline to the left/right
    const baseline = run.glyphs[0].tRm.f;
    const fs = run.fontSize || 12;
    let leftLetter = false;
    let rightLetter = false;

    for (let j = i - 1; j >= 0; j--) {
      const other = runs[j];
      if (other.glyphs.length === 0) continue;
      if (Math.abs(other.glyphs[other.glyphs.length - 1].tRm.f - baseline) > fs * 0.35) continue;
      const gap = run.glyphs[0].tRm.e - (other.glyphs[other.glyphs.length - 1].tRm.e + other.glyphs[other.glyphs.length - 1].width);
      if (gap > fs * 2) break;
      const ch = other.glyphs[other.glyphs.length - 1].unicode.slice(-1);
      if (/[A-Za-z]/.test(ch)) { leftLetter = true; break; }
      if (ch.trim()) break;
    }
    for (let j = i + 1; j < runs.length; j++) {
      const other = runs[j];
      if (other.glyphs.length === 0) continue;
      if (Math.abs(other.glyphs[0].tRm.f - baseline) > fs * 0.35) continue;
      const gap = other.glyphs[0].tRm.e - (run.glyphs[run.glyphs.length - 1].tRm.e + run.glyphs[run.glyphs.length - 1].width);
      if (gap > fs * 2) break;
      const ch = other.glyphs[0].unicode.charAt(0);
      if (/[A-Za-z]/.test(ch)) { rightLetter = true; break; }
      if (ch.trim()) break;
    }

    if (leftLetter && rightLetter) {
      for (let gi = 0; gi < run.glyphs.length; gi++) {
        if (isObscureGlyph(run.glyphs[gi])) {
          run.glyphs[gi] = { ...run.glyphs[gi], unicode: "'" };
        }
      }
      run.text = run.glyphs.map(g => g.unicode).join('');
    }
  }
}

function mergeEditableTextRuns(runs: TextRun[]): TextRun[] {
  const merged: TextRun[] = [];

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    const previous = merged[merged.length - 1];

    if (!previous || !canMergeTextRuns(previous, run)) {
      merged.push({
        ...run,
        glyphs: [...run.glyphs],
        sourceInstructionIndices: run.sourceInstructionIndices ? [...run.sourceInstructionIndices] : undefined,
      });
      continue;
    }

    const glyphs = [...previous.glyphs, ...run.glyphs];
    const sourceInstructionIndices = [
      ...(previous.sourceInstructionIndices ?? []),
      ...(run.sourceInstructionIndices ?? []),
    ];

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let g = 0; g < glyphs.length; g++) {
      const glyph = glyphs[g];
      if (glyph.x < minX) minX = glyph.x;
      if (glyph.y < minY) minY = glyph.y;
      if (glyph.x + glyph.width > maxX) maxX = glyph.x + glyph.width;
      if (glyph.y + glyph.fontSize > maxY) maxY = glyph.y + glyph.fontSize;
    }

    merged[merged.length - 1] = {
      ...previous,
      text: previous.text + run.text,
      glyphs,
      sourceInstructionIndices,
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
      textMatrix: run.textMatrix,
    };
  }

  return merged;
}

function canMergeTextRuns(previous: TextRun, next: TextRun): boolean {
  if (previous.fontName !== next.fontName) return false;
  if (previous.fontSize !== next.fontSize) return false;
  if (previous.fillAlpha !== next.fillAlpha) return false;
  if (previous.isUnderline !== next.isUnderline) return false;
  if (previous.blendMode !== next.blendMode) return false;
  if (previous.softMask !== next.softMask) return false;
  if (previous.clipPaths.length !== next.clipPaths.length) return false;

  const prevColor = previous.fillColor;
  const nextColor = next.fillColor;
  if (prevColor[0] !== nextColor[0] || prevColor[1] !== nextColor[1] || prevColor[2] !== nextColor[2]) {
    return false;
  }

  if (previous.glyphs.length === 0 || next.glyphs.length === 0) return false;

  const prevLast = previous.glyphs[previous.glyphs.length - 1];
  const nextFirst = next.glyphs[0];
  const baselineDelta = Math.abs(prevLast.y - nextFirst.y);
  const lineThreshold = Math.max(2, Math.max(previous.fontSize, next.fontSize) * 0.35);
  if (baselineDelta > lineThreshold) return false;

  const prevRight = prevLast.x + prevLast.width;
  const nextLeft = nextFirst.x;
  const gap = nextLeft - prevRight;
  // Only merge truly adjacent fragments (same TJ/Tj chunk). Justified inter-word
  // gaps are often much larger — merging them breaks editing and layout.
  const gapThreshold = Math.max(3, Math.max(previous.fontSize, next.fontSize) * 0.35);

  return gap >= -1 && gap <= gapThreshold;
}

// advanceTextMatrix removed — text matrix is now returned from showTextString

// ─── Font loading ───────────────────────────────────────────────────────────

function loadFonts(
  resources: PDFDict,
  objects: Map<string, PDFObject>,
  fonts: Map<string, FontInfo>,
): void {
  const fontDict = resources.get('Font');
  if (!fontDict) return;

  const resolved = resolveRef(fontDict, objects);
  if (!(resolved instanceof PDFDict)) return;

  const entries = Array.from(resolved.entries());
  for (let i = 0; i < entries.length; i++) {
    const [name, ref] = entries[i];
    const fontObj = resolveRef(ref, objects);
    if (!(fontObj instanceof PDFDict)) continue;

    const info = parseFontDict(name, fontObj, objects);
    fonts.set(name, info);
  }
}

function parseFontDict(
  name: string,
  dict: PDFDict,
  objects: Map<string, PDFObject>,
): FontInfo {
  const subtype = dict.getName('Subtype') ?? 'Type1';
  const baseFont = dict.getName('BaseFont') ?? '';
  const isComposite = subtype === 'Type0';

  // Parse widths
  const widths = new Map<number, number>();
  let defaultWidth = 1000;
  let firstChar = 0;
  let lastChar = 255;

  if (isComposite) {
    // Type0 font — look at descendant CIDFont
    const descFonts = dict.getArray('DescendantFonts');
    if (descFonts && descFonts.length > 0) {
      const cidFontRef = descFonts.get(0)!;
      const cidFont = resolveRef(cidFontRef, objects);
      if (cidFont instanceof PDFDict) {
        defaultWidth = cidFont.getNumber('DW') ?? 1000;

        // Parse W array: [cid [w1 w2 ...]] or [cidFirst cidLast w]
        const wArray = cidFont.get('W');
        const resolvedW = wArray ? resolveRef(wArray, objects) : undefined;
        if (resolvedW instanceof PDFArray) {
          parseCIDWidths(resolvedW, widths);
        }
      }
    }
  } else {
    // Simple font
    firstChar = dict.getNumber('FirstChar') ?? 0;
    lastChar = dict.getNumber('LastChar') ?? 255;
    const widthsArray = dict.get('Widths');
    const resolvedWidths = widthsArray ? resolveRef(widthsArray, objects) : undefined;
    if (resolvedWidths instanceof PDFArray) {
      const nums = resolvedWidths.asNumbers();
      for (let i = 0; i < nums.length; i++) {
        if (!isNaN(nums[i])) {
          widths.set(firstChar + i, nums[i]);
        }
      }
    }

    // MissingWidth from FontDescriptor (PDF spec default 0)
    const fdRef = dict.get('FontDescriptor');
    if (fdRef) {
      const fd = resolveRef(fdRef, objects);
      if (fd instanceof PDFDict) {
        const missing = fd.getNumber('MissingWidth');
        if (missing != null) defaultWidth = missing;
      }
    }

    // If no explicit widths, check standard 14 font metrics
    if (widths.size === 0) {
      const stdMetrics = getStandardFont(baseFont);
      if (stdMetrics) {
        for (let i = 0; i < 256; i++) {
          widths.set(i, stdMetrics.widths[i]);
        }
        defaultWidth = stdMetrics.defaultWidth;
      } else if (defaultWidth === 1000) {
        defaultWidth = 600; // Reasonable fallback when no MissingWidth
      }
    } else if (defaultWidth === 1000) {
      // Widths present but no MissingWidth — use mid-range fallback for holes
      defaultWidth = 600;
    }
  }

  // Parse ToUnicode CMap
  let toUnicode: Map<number, string> | null = null;
  const toUnicodeRef = dict.get('ToUnicode');
  if (toUnicodeRef) {
    const toUnicodeObj = resolveRef(toUnicodeRef, objects);
    if (toUnicodeObj instanceof PDFStream) {
      toUnicode = parseToUnicodeCMap(toUnicodeObj.getBytes());
    }
  }

  let toCID: Map<number, number> | null = null;

  // Parse encoding for simple fonts
  let encoding = 'StandardEncoding';
  const differences = new Map<number, string>();
  const encodingObj = dict.get('Encoding');
  if (encodingObj) {
    const resolved = resolveRef(encodingObj, objects);
    if (resolved instanceof PDFName) {
      encoding = resolved.name;
    } else if (resolved instanceof PDFStream) {
      const cmap = parseCMap(resolved.getBytes());
      toCID = cmap.toCID;
      if (!toUnicode && cmap.toUnicode.size > 0) {
        toUnicode = cmap.toUnicode;
      }
    } else if (resolved instanceof PDFDict) {
      encoding = resolved.getName('BaseEncoding') ?? 'WinAnsiEncoding';
      // Parse /Differences array for custom encoding
      const diffsArr = resolved.get('Differences');
      const resolvedDiffs = diffsArr ? resolveRef(diffsArr, objects) : undefined;
      if (resolvedDiffs instanceof PDFArray) {
        let currentCode = 0;
        for (let di = 0; di < resolvedDiffs.length; di++) {
          const item = resolvedDiffs.get(di)!;
          if (item instanceof PDFNumber) {
            currentCode = item.value;
          } else if (item instanceof PDFName) {
            differences.set(currentCode, item.name);
            currentCode++;
          }
        }
      }
    }
  }

  // Identity-H embedded fonts without ToUnicode: build CID/GID → Unicode via cmap.
  // Critical for Symbol subsets where CID 120 is a bullet glyph, not Latin "x".
  let cidToUnicode: Map<number, string> | null = null;
  if (isComposite && (!toUnicode || toUnicode.size === 0)) {
    cidToUnicode = buildCidToUnicodeFromEmbeddedFont(dict, objects, baseFont);
  }

  return {
    name,
    baseFont,
    subtype,
    encoding,
    isComposite,
    toUnicode,
    toCID,
    widths,
    defaultWidth,
    firstChar,
    lastChar,
    differences,
    cidToUnicode,
  };
}

/**
 * For Identity-H CIDFonts, reverse the embedded TTF cmap so glyph IDs used as
 * char codes map to drawable Unicode (Symbol bullets, etc.).
 */
function buildCidToUnicodeFromEmbeddedFont(
  dict: PDFDict,
  objects: Map<string, PDFObject>,
  baseFont: string,
): Map<number, string> | null {
  const descFonts = dict.getArray('DescendantFonts');
  if (!descFonts || descFonts.length === 0) return null;

  const cidFont = resolveRef(descFonts.get(0)!, objects);
  if (!(cidFont instanceof PDFDict)) return null;

  const fdRef = cidFont.get('FontDescriptor') ?? dict.get('FontDescriptor');
  if (!fdRef) return null;
  const fd = resolveRef(fdRef, objects);
  if (!(fd instanceof PDFDict)) return null;

  const fontFile = fd.get('FontFile2') ?? fd.get('FontFile3') ?? fd.get('FontFile');
  if (!fontFile) return null;
  const fontStream = resolveRef(fontFile, objects);
  if (!(fontStream instanceof PDFStream)) return null;

  let fontBytes = fontStream.getBytes();
  if (!isTrueTypeFontData(fontBytes) && isCFFData(fontBytes)) {
    try {
      const wrapped = wrapCFFInOTF(fontBytes, { familyName: baseFont });
      if (wrapped && isTrueTypeFontData(wrapped)) fontBytes = wrapped;
    } catch {}
  }
  if (!isTrueTypeFontData(fontBytes)) return null;

  let ttf;
  try {
    ttf = parseTTF(fontBytes);
  } catch {
    return null;
  }

  // Optional CIDToGIDMap
  const cidToGid = new Map<number, number>();
  const cidToGidRef = cidFont.get('CIDToGIDMap');
  if (cidToGidRef) {
    const resolved = resolveRef(cidToGidRef, objects);
    if (resolved instanceof PDFStream) {
      const mapData = resolved.getBytes();
      for (let cid = 0; cid * 2 + 1 < mapData.length; cid++) {
        const gid = (mapData[cid * 2] << 8) | mapData[cid * 2 + 1];
        if (gid !== 0) cidToGid.set(cid, gid);
      }
    }
  }

  const out = new Map<number, string>();

  // Only map glyphs that appear in the cmap (cheap + covers Symbol subsets).
  if (cidToGid.size > 0) {
    for (const [cid, gid] of cidToGid) {
      const uni = unicodeFromGlyphId(gid, ttf.cmapEntries, baseFont);
      if (uni) out.set(cid, uni);
    }
  } else {
    const gids = new Set<number>(ttf.cmapEntries.values());
    for (const gid of gids) {
      const uni = unicodeFromGlyphId(gid, ttf.cmapEntries, baseFont);
      if (uni) out.set(gid, uni); // Identity: CID = GID
    }
  }

  return out.size > 0 ? out : null;
}

/**
 * Parse CID font width array (W entry).
 * Format alternates between:
 *   cidFirst [w1 w2 w3 ...] — consecutive widths starting at cidFirst
 *   cidFirst cidLast w       — same width for range
 */
function parseCIDWidths(wArray: PDFArray, widths: Map<number, number>): void {
  let i = 0;
  while (i < wArray.length) {
    const first = wArray.get(i);
    if (!(first instanceof PDFNumber)) { i++; continue; }

    const second = wArray.get(i + 1);
    if (second instanceof PDFArray) {
      // cidFirst [w1 w2 ...]
      const cid = first.value;
      const ws = second.asNumbers();
      for (let j = 0; j < ws.length; j++) {
        if (!isNaN(ws[j])) widths.set(cid + j, ws[j]);
      }
      i += 2;
    } else if (second instanceof PDFNumber) {
      // cidFirst cidLast w
      const cidFirst = first.value;
      const cidLast = second.value;
      const w = wArray.get(i + 2);
      const width = w instanceof PDFNumber ? w.value : 1000;
      for (let cid = cidFirst; cid <= cidLast; cid++) {
        widths.set(cid, width);
      }
      i += 3;
    } else {
      i++;
    }
  }
}

// ─── ToUnicode CMap parser ──────────────────────────────────────────────────

/**
 * Parse a ToUnicode CMap stream to build a charCode → Unicode mapping.
 * Handles beginbfchar and beginbfrange sections.
 */
function parseToUnicodeCMap(data: Uint8Array): Map<number, string> {
  const map = new Map<number, string>();
  const text = new TextDecoder('latin1').decode(data);

  // Parse beginbfchar ... endbfchar
  const bfcharRegex = /beginbfchar\s*([\s\S]*?)endbfchar/g;
  let match: RegExpExecArray | null;

  while ((match = bfcharRegex.exec(text)) !== null) {
    const block = match[1];
    const lineRegex = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
    let lineMatch: RegExpExecArray | null;
    while ((lineMatch = lineRegex.exec(block)) !== null) {
      const charCode = parseInt(lineMatch[1], 16);
      const unicode = hexToUnicodeString(lineMatch[2]);
      map.set(charCode, unicode);
    }
  }

  // Parse beginbfrange ... endbfrange
  const bfrangeRegex = /beginbfrange\s*([\s\S]*?)endbfrange/g;

  while ((match = bfrangeRegex.exec(text)) !== null) {
    const block = match[1];
    // Two formats:
    // <start> <end> <unicodeStart>
    // <start> <end> [<u1> <u2> ...]
    const rangeRegex = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([\s\S]*?)\])/g;
    let rangeMatch: RegExpExecArray | null;

    while ((rangeMatch = rangeRegex.exec(block)) !== null) {
      const startCode = parseInt(rangeMatch[1], 16);
      const endCode = parseInt(rangeMatch[2], 16);

      if (rangeMatch[3]) {
        // <start> <end> <unicodeStart> — sequential mapping
        let unicodeStart = parseInt(rangeMatch[3], 16);
        for (let code = startCode; code <= endCode; code++) {
          map.set(code, String.fromCodePoint(unicodeStart++));
        }
      } else if (rangeMatch[4]) {
        // <start> <end> [<u1> <u2> ...] — explicit array
        const arrayContent = rangeMatch[4];
        const hexValues = arrayContent.match(/<([0-9a-fA-F]+)>/g) ?? [];
        for (let j = 0; j < hexValues.length && startCode + j <= endCode; j++) {
          const hex = hexValues[j].replace(/[<>]/g, '');
          map.set(startCode + j, hexToUnicodeString(hex));
        }
      }
    }
  }

  return map;
}

function hexToUnicodeString(hex: string): string {
  let result = '';
  // Each pair of 4 hex digits is a Unicode code point
  for (let i = 0; i < hex.length; i += 4) {
    if (i + 4 <= hex.length) {
      result += String.fromCodePoint(parseInt(hex.substring(i, i + 4), 16));
    } else {
      // Remaining 2 digits — single byte
      result += String.fromCodePoint(parseInt(hex.substring(i), 16));
    }
  }
  return result;
}

// ─── Extended Graphics State ────────────────────────────────────────────────

function applyExtGState(
  dict: PDFDict,
  gs: GraphicsState,
  objects: Map<string, PDFObject>,
): void {
  const ca = dict.getNumber('ca');  // Fill alpha
  if (ca !== undefined) gs.fillAlpha = ca;

  const CA = dict.getNumber('CA');  // Stroke alpha
  if (CA !== undefined) gs.strokeAlpha = CA;

  const LW = dict.getNumber('LW');
  if (LW !== undefined) gs.lineWidth = LW;

  const LC = dict.getNumber('LC');
  if (LC !== undefined) gs.lineCap = LC;

  const LJ = dict.getNumber('LJ');
  if (LJ !== undefined) gs.lineJoin = LJ;

  const ML = dict.getNumber('ML');
  if (ML !== undefined) gs.miterLimit = ML;

  // Font from ExtGState
  const fontArr = dict.getArray('Font');
  if (fontArr && fontArr.length >= 2) {
    const fontName = fontArr.get(0);
    const fontSize = fontArr.get(1);
    if (fontName instanceof PDFName) gs.textFont = fontName.name;
    if (fontSize instanceof PDFNumber) gs.textFontSize = fontSize.value;
  }

  // Blend Mode
  const bmObj = dict.get('BM');
  if (bmObj instanceof PDFName) {
    gs.blendMode = bmObj.name;
  } else if (bmObj instanceof PDFArray && bmObj.length > 0) {
    const first = bmObj.get(0);
    if (first instanceof PDFName) gs.blendMode = first.name;
  }

  // Soft Mask
  const smaskObj = dict.get('SMask');
  if (smaskObj instanceof PDFName && smaskObj.name === 'None') {
    gs.softMask = null;
  } else if (smaskObj) {
    const resolvedSMask = resolveRef(smaskObj, objects);
    if (resolvedSMask instanceof PDFDict) {
      gs.softMask = resolvedSMask;
    }
  }
}

// ─── Path bounds computation ────────────────────────────────────────────────

function computePathBounds(segments: PathSegment[]): {
  x: number; y: number; width: number; height: number;
} {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const seg of segments) {
    for (let i = 0; i < seg.points.length; i += 2) {
      const x = seg.points[i];
      const y = seg.points[i + 1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (!isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

// ─── Color conversion ───────────────────────────────────────────────────────

function cmykToRgb(c: number, m: number, y: number, k: number): [number, number, number] {
  return [
    (1 - c) * (1 - k),
    (1 - m) * (1 - k),
    (1 - y) * (1 - k),
  ];
}
