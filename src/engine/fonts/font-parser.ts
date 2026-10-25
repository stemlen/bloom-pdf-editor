/**
 * PDF Font Parser — High-Level Font Loading
 *
 * Orchestrates the extraction of font information from PDF font dictionaries.
 * Delegates to:
 *   - standard14.ts for built-in font metrics
 *   - cmap-parser.ts for ToUnicode and CIDToGID mappings
 *   - truetype-parser.ts for embedded TrueType/OpenType font data
 *
 * Produces a unified FontData structure used by the renderer and editor.
 */

import {
  PDFDict,
  PDFArray,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFStream,
  PDFString,
} from '../types';
import { resolveRef } from '../parser/parser';
import { getStandardFont, type StandardFontMetrics } from './standard14';
import { parseCMap, type CMapData } from './cmap-parser';
import { parseTTF, isTrueTypeFontData, charCodeToGlyphId, getGlyphWidth, fontUnitsToTextSpace, type TTFFont } from './truetype-parser';
import { isCFFData, wrapCFFInOTF } from './cff-wrapper';
import {
  isSuspiciousDingbatToUnicode,
  isSymbolFont,
  isZapfDingbatsFont,
  symbolCharToUnicode,
  unicodeFromGlyphId,
  zapfDingbatsCharToUnicode,
  ZAPF_DINGBATS_GLYPH_TO_UNICODE,
} from './dingbat-encodings';
import { INDIC_FONT_FALLBACKS, isLegacyIndicFont } from './indic-normalizer';

// ─── Font data structure ────────────────────────────────────────────────────

export interface FontData {
  /** Resource name (e.g., 'F1') */
  name: string;
  /** Base font name (e.g., 'Helvetica', 'BCDEAF+ArialMT') */
  baseFont: string;
  /** Font subtype: Type1, TrueType, Type0, Type3, CIDFontType0, CIDFontType2 */
  subtype: string;
  /** Is this a composite (CID) font? */
  isComposite: boolean;
  /** Encoding name (StandardEncoding, WinAnsiEncoding, etc.) */
  encoding: string;
  /** Encoding differences array: charCode → glyphName */
  differences: Map<number, string>;
  /** Character code → Unicode mapping */
  toUnicode: Map<number, string>;
  /** Character code → glyph width in 1/1000 units */
  widths: Map<number, number>;
  /** Default width for unmapped characters */
  defaultWidth: number;
  /** FirstChar (for simple fonts) */
  firstChar?: number;
  /** LastChar (for simple fonts) */
  lastChar?: number;
  /** Standard 14 font metrics (if applicable) */
  standardMetrics?: StandardFontMetrics | null;
  /** Parsed TrueType font data (if embedded) */
  ttfFont?: TTFFont | null;
  /** Raw font file bytes (for CSS FontFace registration) */
  fontBytes?: Uint8Array | null;
  /** Font descriptor metrics */
  ascent?: number;
  descent?: number;
  /** Italic angle */
  italicAngle?: number;
  /** Font flags (bit field) */
  flags?: number;
  /** FontWeight from FontDescriptor (100–900), if present */
  fontWeight?: number | null;
  /** CSS font string for canvas rendering */
  cssFontString?: string;
  /** Type 3 Font Matrix */
  fontMatrix?: number[] | null;
  /** Type 3 Character Procedures: charName → PDFStream */
  charProcs?: Map<string, PDFStream> | null;
}

// ─── Main font loading function ─────────────────────────────────────────────

/**
 * Load all fonts from a page's Resources dictionary.
 * Returns a Map of resource name → FontData.
 */
export function loadPageFonts(
  resources: PDFDict,
  objects: Map<string, PDFObject>,
): Map<string, FontData> {
  const result = new Map<string, FontData>();

  const fontDictRef = resources.get('Font');
  if (!fontDictRef) return result;

  const fontDict = resolveRef(fontDictRef, objects);
  if (!(fontDict instanceof PDFDict)) return result;

  const entries = Array.from(fontDict.entries());
  for (let i = 0; i < entries.length; i++) {
    const [name, ref] = entries[i];
    const fontObj = resolveRef(ref, objects);
    if (fontObj instanceof PDFDict) {
      const fontData = loadFont(name, fontObj, objects);
      result.set(name, fontData);
    }
  }

  return result;
}

/**
 * Load a single font from its PDF dictionary.
 */
export function loadFont(
  name: string,
  dict: PDFDict,
  objects: Map<string, PDFObject>,
): FontData {
  const subtype = dict.getName('Subtype') ?? 'Type1';
  const baseFont = dict.getName('BaseFont') ?? '';
  const isComposite = subtype === 'Type0';

  const fontData: FontData = {
    name,
    baseFont,
    subtype,
    isComposite,
    encoding: 'StandardEncoding',
    differences: new Map(),
    toUnicode: new Map(),
    widths: new Map(),
    defaultWidth: 1000,
    firstChar: 0,
    lastChar: 255,
    standardMetrics: null,
    ttfFont: null,
    fontBytes: null,
    ascent: 800,
    descent: -200,
    italicAngle: 0,
    flags: 0,
    fontWeight: null,
    cssFontString: '12px sans-serif',
    fontMatrix: null,
    charProcs: null,
  };

  // 1. Check for standard 14 font
  fontData.standardMetrics = getStandardFont(baseFont);
  if (fontData.standardMetrics) {
    // Populate widths from standard metrics
    for (let i = 0; i < 256; i++) {
      fontData.widths.set(i, fontData.standardMetrics.widths[i]);
    }
    fontData.defaultWidth = fontData.standardMetrics.defaultWidth;
    fontData.ascent = fontData.standardMetrics.ascent;
    fontData.descent = fontData.standardMetrics.descent;
  }

  // 2. Parse encoding
  loadEncoding(dict, objects, fontData);

  // 3. Parse ToUnicode CMap
  loadToUnicode(dict, objects, fontData);

  // 4. Parse widths
  if (isComposite) {
    loadCompositeWidths(dict, objects, fontData);
  } else {
    loadSimpleWidths(dict, objects, fontData);
    // MissingWidth: fallback for char codes absent from /Widths (PDF 9.7.4.3)
    const fdEarly = dict.get('FontDescriptor');
    if (fdEarly) {
      const fd = resolveRef(fdEarly, objects);
      if (fd instanceof PDFDict) {
        const missing = fd.getNumber('MissingWidth');
        if (missing != null) fontData.defaultWidth = missing;
      }
    }
  }

  // 5. Parse font descriptor (for embedded font data)
  loadFontDescriptor(dict, objects, fontData);

  // 6. For composite fonts, also parse descendant CIDFont
  if (isComposite) {
    loadDescendantFont(dict, objects, fontData);
  }

  // 6.5 For Type3 fonts, parse FontMatrix and CharProcs
  if (subtype === 'Type3') {
    const matrixArr = dict.getArray('FontMatrix');
    if (matrixArr) {
      fontData.fontMatrix = matrixArr.asNumbers();
    }
    const charProcsDictRef = dict.get('CharProcs');
    const charProcsDict = charProcsDictRef ? resolveRef(charProcsDictRef, objects) : undefined;
    if (charProcsDict instanceof PDFDict) {
      fontData.charProcs = new Map();
      const entries = Array.from(charProcsDict.entries());
      for (const [charName, streamRef] of entries) {
        const stream = resolveRef(streamRef, objects);
        if (stream instanceof PDFStream) {
          fontData.charProcs.set(charName, stream);
        }
      }
    }
  }

  // 7. Build CSS font string
  fontData.cssFontString = buildCSSFont(fontData);

  if (fontData.widths.size === 0) {
    console.warn(`[Font Parser] WARNING: Font ${name} (${baseFont}) has no widths! Standard: ${!!fontData.standardMetrics}, isComposite: ${isComposite}`);
  }

  return fontData;
}

// ─── Encoding ───────────────────────────────────────────────────────────────

function loadEncoding(
  dict: PDFDict,
  objects: Map<string, PDFObject>,
  fontData: FontData,
): void {
  const encodingObj = dict.get('Encoding');
  if (!encodingObj) return;

  const resolved = resolveRef(encodingObj, objects);

  if (resolved instanceof PDFName) {
    fontData.encoding = resolved.name;
    return;
  }

  if (resolved instanceof PDFDict) {
    // Encoding dictionary with optional Differences array
    const baseName = resolved.getName('BaseEncoding');
    if (baseName) fontData.encoding = baseName;

    const diffsArr = resolved.get('Differences');
    const resolvedDiffs = diffsArr ? resolveRef(diffsArr, objects) : undefined;
    if (resolvedDiffs instanceof PDFArray) {
      let currentCode = 0;
      for (let i = 0; i < resolvedDiffs.length; i++) {
        const item = resolvedDiffs.get(i)!;
        if (item instanceof PDFNumber) {
          currentCode = item.value;
        } else if (item instanceof PDFName) {
          fontData.differences.set(currentCode, item.name);
          currentCode++;
        }
      }
    }
  }
}

// ─── ToUnicode ──────────────────────────────────────────────────────────────

function loadToUnicode(
  dict: PDFDict,
  objects: Map<string, PDFObject>,
  fontData: FontData,
): void {
  const toUnicodeRef = dict.get('ToUnicode');
  if (!toUnicodeRef) return;

  const toUnicodeObj = resolveRef(toUnicodeRef, objects);
  if (!(toUnicodeObj instanceof PDFStream)) return;

  const cmapData = parseCMap(toUnicodeObj.getBytes());
  fontData.toUnicode = cmapData.toUnicode;
}

// ─── Simple font widths ─────────────────────────────────────────────────────

function resolveNumber(dict: PDFDict, key: string, objects: Map<string, PDFObject>): number | undefined {
  const ref = dict.get(key);
  if (!ref) return undefined;
  const obj = resolveRef(ref, objects);
  return obj instanceof PDFNumber ? obj.value : undefined;
}

function loadSimpleWidths(
  dict: PDFDict,
  objects: Map<string, PDFObject>,
  fontData: FontData,
): void {
  fontData.firstChar = resolveNumber(dict, 'FirstChar', objects) ?? 0;
  fontData.lastChar = resolveNumber(dict, 'LastChar', objects) ?? 255;

  const widthsRef = dict.get('Widths');
  if (!widthsRef) return;

  const widthsArr = resolveRef(widthsRef, objects);
  if (!(widthsArr instanceof PDFArray)) return;

  const nums: number[] = [];
  for (let i = 0; i < widthsArr.length; i++) {
    const raw = widthsArr.get(i);
    const obj = raw ? resolveRef(raw, objects) : undefined;
    if (obj instanceof PDFNumber) {
      nums.push(obj.value);
    } else {
      nums.push(NaN);
    }
  }

  for (let i = 0; i < nums.length; i++) {
    if (!isNaN(nums[i])) {
      fontData.widths.set(fontData.firstChar + i, nums[i]);
    }
  }
}

// ─── Composite (CID) font widths ────────────────────────────────────────────

function loadCompositeWidths(
  dict: PDFDict,
  objects: Map<string, PDFObject>,
  fontData: FontData,
): void {
  const descFontsRef = dict.get('DescendantFonts');
  if (!descFontsRef) return;

  const descFonts = resolveRef(descFontsRef, objects);
  if (!(descFonts instanceof PDFArray) || descFonts.length === 0) return;

  const cidFontRef = descFonts.get(0)!;
  const cidFont = resolveRef(cidFontRef, objects);
  if (!(cidFont instanceof PDFDict)) return;

  fontData.defaultWidth = resolveNumber(cidFont, 'DW', objects) ?? 1000;

  // Parse W array
  const wRef = cidFont.get('W');
  if (!wRef) return;

  const wArr = resolveRef(wRef, objects);
  if (!(wArr instanceof PDFArray)) return;

  let i = 0;
  while (i < wArr.length) {
    const firstRaw = wArr.get(i);
    const first = firstRaw ? resolveRef(firstRaw, objects) : undefined;
    if (!(first instanceof PDFNumber)) { i++; continue; }

    const secondRaw = wArr.get(i + 1);
    const second = secondRaw ? resolveRef(secondRaw, objects) : undefined;

    if (second instanceof PDFArray) {
      // cidFirst [w1 w2 ...] — consecutive widths
      const cid = first.value;
      for (let j = 0; j < second.length; j++) {
        const wRaw = second.get(j);
        const w = wRaw ? resolveRef(wRaw, objects) : undefined;
        if (w instanceof PDFNumber) {
          fontData.widths.set(cid + j, w.value);
        }
      }
      i += 2;
    } else if (second instanceof PDFNumber) {
      // cidFirst cidLast w — range with same width
      const cidFirst = first.value;
      const cidLast = second.value;
      const wObjRaw = wArr.get(i + 2);
      const wObj = wObjRaw ? resolveRef(wObjRaw, objects) : undefined;
      const width = wObj instanceof PDFNumber ? wObj.value : fontData.defaultWidth;
      for (let cid = cidFirst; cid <= cidLast; cid++) {
        fontData.widths.set(cid, width);
      }
      i += 3;
    } else {
      i++;
    }
  }
}

// ─── Font descriptor ────────────────────────────────────────────────────────

function loadFontDescriptor(
  dict: PDFDict,
  objects: Map<string, PDFObject>,
  fontData: FontData,
): void {
  const fdRef = dict.get('FontDescriptor');
  if (!fdRef) return;

  const fd = resolveRef(fdRef, objects);
  if (!(fd instanceof PDFDict)) return;

  fontData.ascent = fd.getNumber('Ascent') ?? fontData.ascent;
  fontData.descent = fd.getNumber('Descent') ?? fontData.descent;
  fontData.italicAngle = fd.getNumber('ItalicAngle') ?? 0;
  fontData.flags = fd.getNumber('Flags') ?? 0;
  const weight = fd.getNumber('FontWeight');
  if (weight != null) fontData.fontWeight = weight;

  const fontFile = fd.get('FontFile') ?? fd.get('FontFile2') ?? fd.get('FontFile3');
  if (fontFile) {
    const fontStream = resolveRef(fontFile, objects);
    if (fontStream instanceof PDFStream) {
      let fontBytes = fontStream.getBytes();

      // If raw CFF stream (Type1C / CIDFontType0C / FontFile3), wrap in OpenType (OTTO) container
      if (!isTrueTypeFontData(fontBytes) && isCFFData(fontBytes)) {
        try {
          const wrapped = wrapCFFInOTF(fontBytes, {
            familyName: fontData.baseFont,
            ascent: fontData.ascent,
            descent: fontData.descent,
            weight: fontData.fontWeight,
            italicAngle: fontData.italicAngle,
            widths: fontData.widths,
          });
          if (wrapped && isTrueTypeFontData(wrapped)) {
            fontBytes = wrapped;
          }
        } catch (e) {
          console.warn(`[Font Parser] Failed to wrap CFF font for ${fontData.baseFont}:`, e);
        }
      }

      if (isTrueTypeFontData(fontBytes)) {
        fontData.fontBytes = fontBytes;
        try {
          fontData.ttfFont = parseTTF(fontBytes);

          // Populate widths from embedded font if not already set
          if (fontData.widths.size === 0 && fontData.ttfFont) {
            populateWidthsFromTTF(fontData);
          }
        } catch (e) {
          console.warn(`[Font Parser] Failed to parse embedded font for ${fontData.baseFont}:`, e);
        }
      } else {
        fontData.fontBytes = null;
      }
    }
  }
}

// ─── Descendant font (for Type0) ────────────────────────────────────────────

function loadDescendantFont(
  dict: PDFDict,
  objects: Map<string, PDFObject>,
  fontData: FontData,
): void {
  const descFontsRef = dict.get('DescendantFonts');
  if (!descFontsRef) return;

  const descFonts = resolveRef(descFontsRef, objects);
  if (!(descFonts instanceof PDFArray) || descFonts.length === 0) return;

  const cidFontRef = descFonts.get(0)!;
  const cidFont = resolveRef(cidFontRef, objects);
  if (!(cidFont instanceof PDFDict)) return;

  // Get CIDFont subtype
  const cidSubtype = cidFont.getName('Subtype');
  if (cidSubtype) fontData.subtype = cidSubtype;

  // Load font descriptor from CIDFont if not found on Type0 dict
  if (!fontData.ttfFont) {
    loadFontDescriptor(cidFont, objects, fontData);
  }

  // CIDToGIDMap (maps CID → glyph ID in TrueType font)
  const cidToGidRef = cidFont.get('CIDToGIDMap');
  if (cidToGidRef) {
    const resolved = resolveRef(cidToGidRef, objects);
    if (resolved instanceof PDFStream) {
      // Binary map: each 2-byte entry maps CID index to glyph ID
      const mapData = resolved.getBytes();
      if (fontData.ttfFont && mapData.length >= 2) {
        for (let cid = 0; cid < mapData.length / 2; cid++) {
          const gid = (mapData[cid * 2] << 8) | mapData[cid * 2 + 1];
          if (gid !== 0 && fontData.ttfFont) {
            // Get width from TrueType font
            const widthFU = getGlyphWidth(fontData.ttfFont, gid);
            const width1000 = fontUnitsToTextSpace(widthFU, fontData.ttfFont.unitsPerEm);
            fontData.widths.set(cid, width1000);
          }
        }
      }
    }
  } else {
    // No CIDToGIDMap: treat it as /Identity (CID = GID, no mapping needed).
    // Populate widths directly from TrueType font for all CIDs if W array was missing or incomplete
    if (fontData.ttfFont && fontData.widths.size === 0) {
      const numGlyphs = fontData.ttfFont.numGlyphs;
      for (let cid = 0; cid < numGlyphs; cid++) {
        const widthFU = getGlyphWidth(fontData.ttfFont, cid);
        const width1000 = fontUnitsToTextSpace(widthFU, fontData.ttfFont.unitsPerEm);
        fontData.widths.set(cid, width1000);
      }
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isTrueTypeData(data: Uint8Array): boolean {
  return isTrueTypeFontData(data);
}

function populateWidthsFromTTF(fontData: FontData): void {
  if (!fontData.ttfFont) return;

  const ttf = fontData.ttfFont;
  const entries = Array.from(ttf.cmapEntries.entries());
  for (let i = 0; i < entries.length; i++) {
    const [charCode, glyphId] = entries[i];
    const widthFU = getGlyphWidth(ttf, glyphId);
    fontData.widths.set(charCode, fontUnitsToTextSpace(widthFU, ttf.unitsPerEm));
  }
}

function buildCSSFont(fontData: FontData): string {
  const std = fontData.standardMetrics;
  if (std) {
    const weight = std.isBold ? 'bold' : 'normal';
    const style = std.isItalic ? 'italic' : 'normal';
    return `${style} ${weight} 10px ${std.cssFamily}`;
  }

  // Infer from base font name
  const lower = fontData.baseFont.toLowerCase();
  const weight = lower.includes('bold') ? 'bold' : 'normal';
  const style = (lower.includes('italic') || lower.includes('oblique')) ? 'italic' : 'normal';

  // Try to match to a system font
  let family = `sans-serif, ${INDIC_FONT_FALLBACKS}`;
  if (
    isLegacyIndicFont(fontData.baseFont) ||
    lower.includes('mangal') ||
    lower.includes('nirmala') ||
    lower.includes('deva') ||
    lower.includes('hindi')
  ) {
    family = `${INDIC_FONT_FALLBACKS}`;
  } else if (lower.includes('courier') || lower.includes('mono')) {
    family = `"Courier New", Courier, monospace, ${INDIC_FONT_FALLBACKS}`;
  } else if (lower.includes('times') || lower.includes('roman') || lower.includes('serif')) {
    family = `"Times New Roman", Times, "Noto Serif Devanagari", ${INDIC_FONT_FALLBACKS}`;
  } else if (lower.includes('helv') || lower.includes('arial')) {
    family = `Helvetica, Arial, ${INDIC_FONT_FALLBACKS}`;
  }

  return `${style} ${weight} 10px ${family}`;
}

// ─── Character → Unicode resolution ─────────────────────────────────────────

/**
 * Resolve a character code to its Unicode string representation.
 * Tries multiple strategies in order of reliability:
 *   1. ToUnicode CMap (most reliable)
 *   2. Encoding differences
 *   3. Standard encoding
 *   4. Direct mapping (Latin-1)
 */
export function charCodeToUnicode(charCode: number, fontData: FontData): string {
  // ZapfDingbats: never trust Latin ToUnicode ("x"/"l" for bullets)
  if (isZapfDingbatsFont(fontData.baseFont)) {
    const dingbat = zapfDingbatsCharToUnicode(charCode, fontData.differences);
    if (dingbat) {
      const fromCMap = fontData.toUnicode.get(charCode);
      if (fromCMap && !isSuspiciousDingbatToUnicode(fromCMap)) return fromCMap;
      return dingbat;
    }
  }

  // Simple Symbol fonts use SymbolSetEncoding (bullet = 183, not Latin "x")
  if (isSymbolFont(fontData.baseFont) && !fontData.isComposite) {
    const sym = symbolCharToUnicode(charCode, fontData.differences);
    if (sym) {
      const fromCMap = fontData.toUnicode.get(charCode);
      if (fromCMap && !isSuspiciousDingbatToUnicode(fromCMap)) return fromCMap;
      return sym;
    }
  }

  // Prefer Encoding Differences→AGL when present — matches drawn glyphs better
  // than broken ToUnicode maps (apostrophe → § on some certificate PDFs).
  const glyphName = fontData.differences.get(charCode);
  if (glyphName) {
    const fromDiff = glyphNameToUnicode(glyphName);
    if (fromDiff) {
      const fromCMap = fontData.toUnicode.get(charCode);
      if (
        fromCMap &&
        fromCMap !== fromDiff &&
        isObscureSymbolChar(fromDiff) &&
        !isObscureSymbolChar(fromCMap)
      ) {
        return fromCMap;
      }
      return fromDiff;
    }
  }

  // ToUnicode CMap
  const fromCMap = fontData.toUnicode.get(charCode);
  if (fromCMap) {
    if (isObscureSymbolChar(fromCMap)) {
      if (charCode === 0x27) return "'";
      if (charCode === 0x91) return '\u2018';
      if (charCode === 0x92) return '\u2019';
    }
    return fromCMap;
  }

  // Identity-H / embedded TTF without ToUnicode: CID often equals glyph ID
  if (fontData.isComposite && fontData.ttfFont) {
    const fromGlyph = unicodeFromGlyphId(
      charCode,
      fontData.ttfFont.cmapEntries,
      fontData.baseFont,
    );
    if (fromGlyph) return fromGlyph;
  }

  // WinAnsiEncoding 0x80–0x9F range has special Unicode mappings.
  // Many PDF producers use these byte values regardless of the stated encoding.
  if (charCode >= 0x80 && charCode <= 0x9F) {
    const winAnsiMap: Record<number, number> = {
      0x80: 0x20AC, 0x82: 0x201A, 0x83: 0x0192, 0x84: 0x201E,
      0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02C6,
      0x89: 0x2030, 0x8A: 0x0160, 0x8B: 0x2039, 0x8C: 0x0152,
      0x8E: 0x017D, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201C,
      0x94: 0x201D, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
      0x98: 0x02DC, 0x99: 0x2122, 0x9A: 0x0161, 0x9B: 0x203A,
      0x9C: 0x0153, 0x9E: 0x017E, 0x9F: 0x0178,
    };
    const mapped = winAnsiMap[charCode];
    if (mapped) return String.fromCodePoint(mapped);
  }

  // For non-composite fonts with standard range
  if (!fontData.isComposite && charCode >= 0x20 && charCode <= 0x7e) {
    return String.fromCharCode(charCode);
  }

  // Direct mapping
  return String.fromCharCode(charCode);
}

function isObscureSymbolChar(ch: string): boolean {
  if (!ch || ch.length === 0) return true;
  const cp = ch.codePointAt(0) ?? 0;
  return (
    cp === 0x00A7 || cp === 0x00B6 || cp === 0x00A4 ||
    cp === 0x2020 || cp === 0x2021 || cp === 0x2022 ||
    cp === 0x203B || cp === 0x00A6 || cp === 0x00AC
  );
}

/**
 * Map common Adobe glyph names to Unicode characters.
 * This is a subset of the Adobe Glyph List.
 */
function glyphNameToUnicode(name: string): string | null {
  const map: Record<string, string> = {
    'space': ' ', 'exclam': '!', 'quotedbl': '"', 'numbersign': '#',
    'dollar': '$', 'percent': '%', 'ampersand': '&', 'quotesingle': "'",
    'parenleft': '(', 'parenright': ')', 'asterisk': '*', 'plus': '+',
    'comma': ',', 'hyphen': '-', 'period': '.', 'slash': '/',
    'zero': '0', 'one': '1', 'two': '2', 'three': '3',
    'four': '4', 'five': '5', 'six': '6', 'seven': '7',
    'eight': '8', 'nine': '9', 'colon': ':', 'semicolon': ';',
    'less': '<', 'equal': '=', 'greater': '>', 'question': '?',
    'at': '@',
    'A': 'A', 'B': 'B', 'C': 'C', 'D': 'D', 'E': 'E', 'F': 'F',
    'G': 'G', 'H': 'H', 'I': 'I', 'J': 'J', 'K': 'K', 'L': 'L',
    'M': 'M', 'N': 'N', 'O': 'O', 'P': 'P', 'Q': 'Q', 'R': 'R',
    'S': 'S', 'T': 'T', 'U': 'U', 'V': 'V', 'W': 'W', 'X': 'X',
    'Y': 'Y', 'Z': 'Z',
    'bracketleft': '[', 'backslash': '\\', 'bracketright': ']',
    'asciicircum': '^', 'underscore': '_', 'grave': '`',
    'a': 'a', 'b': 'b', 'c': 'c', 'd': 'd', 'e': 'e', 'f': 'f',
    'g': 'g', 'h': 'h', 'i': 'i', 'j': 'j', 'k': 'k', 'l': 'l',
    'm': 'm', 'n': 'n', 'o': 'o', 'p': 'p', 'q': 'q', 'r': 'r',
    's': 's', 't': 't', 'u': 'u', 'v': 'v', 'w': 'w', 'x': 'x',
    'y': 'y', 'z': 'z',
    'braceleft': '{', 'bar': '|', 'braceright': '}', 'asciitilde': '~',
    // Extended Latin
    'bullet': '\u2022', 'endash': '\u2013', 'emdash': '\u2014',
    'quotedblleft': '\u201C', 'quotedblright': '\u201D',
    'quoteleft': '\u2018', 'quoteright': '\u2019',
    'fi': '\uFB01', 'fl': '\uFB02',
    'ellipsis': '\u2026', 'trademark': '\u2122',
    'copyright': '\u00A9', 'registered': '\u00AE',
    'degree': '\u00B0', 'plusminus': '\u00B1',
    'mu': '\u00B5', 'paragraph': '\u00B6',
    'section': '\u00A7',
    // Accented characters
    'Agrave': '\u00C0', 'Aacute': '\u00C1', 'Acircumflex': '\u00C2',
    'Atilde': '\u00C3', 'Adieresis': '\u00C4', 'Aring': '\u00C5',
    'AE': '\u00C6', 'Ccedilla': '\u00C7',
    'Egrave': '\u00C8', 'Eacute': '\u00C9', 'Ecircumflex': '\u00CA',
    'Edieresis': '\u00CB',
    'Igrave': '\u00CC', 'Iacute': '\u00CD', 'Icircumflex': '\u00CE',
    'Idieresis': '\u00CF',
    'Ntilde': '\u00D1',
    'Ograve': '\u00D2', 'Oacute': '\u00D3', 'Ocircumflex': '\u00D4',
    'Otilde': '\u00D5', 'Odieresis': '\u00D6',
    'Ugrave': '\u00D9', 'Uacute': '\u00DA', 'Ucircumflex': '\u00DB',
    'Udieresis': '\u00DC',
    'agrave': '\u00E0', 'aacute': '\u00E1', 'acircumflex': '\u00E2',
    'atilde': '\u00E3', 'adieresis': '\u00E4', 'aring': '\u00E5',
    'ae': '\u00E6', 'ccedilla': '\u00E7',
    'egrave': '\u00E8', 'eacute': '\u00E9', 'ecircumflex': '\u00EA',
    'edieresis': '\u00EB',
    'igrave': '\u00EC', 'iacute': '\u00ED', 'icircumflex': '\u00EE',
    'idieresis': '\u00EF',
    'ntilde': '\u00F1',
    'ograve': '\u00F2', 'oacute': '\u00F3', 'ocircumflex': '\u00F4',
    'otilde': '\u00F5', 'odieresis': '\u00F6',
    'ugrave': '\u00F9', 'uacute': '\u00FA', 'ucircumflex': '\u00FB',
    'udieresis': '\u00FC',
  };

  return map[name] ?? ZAPF_DINGBATS_GLYPH_TO_UNICODE[name] ?? null;
}
