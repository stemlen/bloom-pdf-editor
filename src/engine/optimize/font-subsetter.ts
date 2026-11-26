/**
 * TrueType Font Subsetting for PDF Optimization.
 *
 * Strategy: zero out unused glyph outlines in the `glyf` table while keeping
 * all glyph IDs in place. This avoids rewriting CIDToGIDMap, cmap, Widths,
 * and Encoding/Differences — making it safe for every font type in the PDF.
 *
 * Steps:
 *   1. Scan page content streams for text operators (Tj, TJ, ', ")
 *   2. Resolve character codes → glyph IDs via each font's cmap / CIDToGIDMap
 *   3. Expand composite glyph references (components)
 *   4. Rebuild glyf + loca tables with unused glyphs zeroed out
 *   5. Reassemble the sfnt binary and replace the FontFile2 stream
 *
 * ISO 32000-2 §9.6.4: Embedded TrueType font programs should contain only
 * the glyphs referenced by the document. This is what Acrobat "Save Optimized" does.
 */

import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFObject,
  type PDFDocumentData,
} from '../types';
import { resolveRef, getPageContentBytes } from '../parser/parser';
import { parseContentStream } from '../content/operator-lexer';
import { applyFilters } from '../parser/filters';
import { flateEncode } from '../parser/filters';
import { isTrueTypeFontData, parseTTF, type TTFFont, type TTFTable } from '../fonts/truetype-parser';

export interface FontSubsetResult {
  /** Number of fonts that were subsetted */
  fontsSubsetted: number;
  /** Total bytes saved from font subsetting */
  bytesSaved: number;
  /** Per-font details */
  details: Array<{
    fontName: string;
    originalSize: number;
    subsetSize: number;
    glyphsKept: number;
    glyphsTotal: number;
  }>;
}

// ─── Glyph collection from content streams ──────────────────────────────────

/**
 * Collect all used glyph IDs per font across all pages.
 * Returns a Map of font stream object key → Set of glyph IDs used.
 *
 * Content is walked with the real content-stream lexer (escaped `\(` `\)` in
 * literal strings, `]` inside TJ strings, q/Q-scoped Tf), including Form
 * XObjects and annotation appearance streams: a glyph drawn anywhere must
 * survive, or it disappears from the optimized file.
 */
function collectUsedGlyphs(
  doc: PDFDocumentData,
): Map<string, { glyphIds: Set<number>; font: TTFFont; streamKey: string; stream: PDFStream }> {
  const result = new Map<string, {
    glyphIds: Set<number>;
    font: TTFFont;
    streamKey: string;
    stream: PDFStream;
  }>();

  const entryFor = (fontInfo: FontInfo) => {
    if (!fontInfo.ttfData || !fontInfo.fontStreamKey) return null;
    let entry = result.get(fontInfo.fontStreamKey);
    if (!entry) {
      try {
        entry = {
          glyphIds: new Set<number>([0]), // Always keep .notdef
          font: parseTTF(fontInfo.ttfData),
          streamKey: fontInfo.fontStreamKey,
          stream: fontInfo.fontStream!,
        };
      } catch {
        return null;
      }
      result.set(fontInfo.fontStreamKey, entry);
    }
    return entry;
  };

  const fontsByResources = new Map<PDFDict, Map<string, FontInfo>>();
  const fontsIn = (resources: PDFDict | undefined) => {
    if (!resources) return new Map<string, FontInfo>();
    let fonts = fontsByResources.get(resources);
    if (!fonts) {
      fonts = new Map(findFontsInResources(resources, doc.objects).map(f => [f.resourceName, f]));
      fontsByResources.set(resources, fonts);
    }
    return fonts;
  };

  const scanned = new Set<PDFStream>();
  const scanForm = (stream: PDFStream, inherited: PDFDict | undefined, depth: number) => {
    if (scanned.has(stream) || depth > 12) return;
    scanned.add(stream);
    const res = stream.dict.get('Resources');
    const resolved = res ? resolveRef(res, doc.objects) : undefined;
    scanContent(stream.getBytes(), resolved instanceof PDFDict ? resolved : inherited, depth + 1);
  };

  const scanContent = (bytes: Uint8Array, resources: PDFDict | undefined, depth: number) => {
    let instructions: ReturnType<typeof parseContentStream>;
    try {
      instructions = parseContentStream(bytes);
    } catch {
      return;
    }
    const fonts = fontsIn(resources);
    let current: FontInfo | null = null;
    const saved: (FontInfo | null)[] = [];
    const add = (str: PDFObject | undefined) => {
      if (!current || !(str instanceof PDFString || str instanceof PDFHexString)) return;
      const entry = entryFor(current);
      if (entry) addCharCodes(codesFromBytes(str.toBytes(), current.isComposite), current, entry.glyphIds, entry.font);
    };
    for (const inst of instructions) {
      const ops = inst.operands;
      switch (inst.operator) {
        case 'q': saved.push(current); break;
        case 'Q': if (saved.length) current = saved.pop()!; break;
        case 'Tf': current = ops[0] instanceof PDFName ? fonts.get(ops[0].name) ?? null : null; break;
        case 'Tj': case "'": add(ops[0]); break;
        case '"': add(ops[2]); break;
        case 'TJ':
          if (ops[0] instanceof PDFArray) for (const item of ops[0].items) add(item);
          break;
        case 'Do': {
          if (!(ops[0] instanceof PDFName) || !resources) break;
          const xobjs = resources.get('XObject');
          const dict = xobjs ? resolveRef(xobjs, doc.objects) : undefined;
          const xobj = dict instanceof PDFDict ? dict.get(ops[0].name) : undefined;
          const form = xobj ? resolveRef(xobj, doc.objects) : undefined;
          if (form instanceof PDFStream && form.dict.getName('Subtype') === 'Form') scanForm(form, resources, depth);
          break;
        }
      }
    }
  };

  for (const page of doc.pages) {
    scanContent(getPageContentBytes(page, doc.objects), page.resources, 0);

    // Annotation appearance streams (form fields, stamps, free text)
    const annots = page.dict.get('Annots');
    const annotArr = annots ? resolveRef(annots, doc.objects) : undefined;
    if (!(annotArr instanceof PDFArray)) continue;
    for (const a of annotArr.items) {
      const annot = resolveRef(a, doc.objects);
      const ap = annot instanceof PDFDict ? annot.get('AP') : undefined;
      const apDict = ap ? resolveRef(ap, doc.objects) : undefined;
      if (!(apDict instanceof PDFDict)) continue;
      for (const key of ['N', 'R', 'D']) {
        const v = apDict.get(key);
        const appearance = v ? resolveRef(v, doc.objects) : undefined;
        if (appearance instanceof PDFStream) {
          scanForm(appearance, page.resources, 0);
        } else if (appearance instanceof PDFDict) {
          for (const [, state] of appearance.entries()) {
            const st = resolveRef(state, doc.objects);
            if (st instanceof PDFStream) scanForm(st, page.resources, 0);
          }
        }
      }
    }
  }

  // Expand composite glyph components
  for (const [, entry] of result) {
    expandCompositeGlyphs(entry.font, entry.glyphIds);
  }

  return result;
}

/** Character codes of a shown string: 2-byte for composite (Identity) fonts, else 1-byte. */
function codesFromBytes(bytes: Uint8Array, isComposite: boolean): number[] {
  const codes: number[] = [];
  if (isComposite) {
    for (let j = 0; j + 1 < bytes.length; j += 2) codes.push((bytes[j] << 8) | bytes[j + 1]);
  } else {
    for (const b of bytes) codes.push(b);
  }
  return codes;
}

function addCharCodes(codes: number[], fontInfo: FontInfo, glyphIds: Set<number>, ttf: TTFFont): void {
  for (const code of codes) {
    if (fontInfo.isComposite && fontInfo.cidToGidMap) {
      // CID font: use CIDToGIDMap
      if (code * 2 + 1 < fontInfo.cidToGidMap.length) {
        const gid = (fontInfo.cidToGidMap[code * 2] << 8) | fontInfo.cidToGidMap[code * 2 + 1];
        if (gid > 0) glyphIds.add(gid);
      }
    } else if (fontInfo.isComposite) {
      // CID without CIDToGIDMap: identity mapping
      if (code < ttf.numGlyphs) glyphIds.add(code);
    } else {
      // Simple font: (3,1)/(1,0) cmap, or a (3,0) symbol cmap at 0xF000 + code
      const gid = ttf.cmapEntries.get(code) ?? ttf.cmapEntries.get(0xf000 + code) ?? 0;
      if (gid > 0) glyphIds.add(gid);
    }
  }
}

interface FontInfo {
  /** Resource name on the page (e.g. "F1") */
  resourceName: string;
  /** The font dictionary */
  fontDict: PDFDict;
  /** Whether this is a composite (Type0/CID) font */
  isComposite: boolean;
  /** Raw embedded TrueType bytes (null if not embedded or not TrueType) */
  ttfData: Uint8Array | null;
  /** Object key for the font file stream */
  fontStreamKey: string | null;
  /** The font file stream object */
  fontStream: PDFStream | null;
  /** CIDToGIDMap as binary data (for CID fonts) */
  cidToGidMap: Uint8Array | null;
  /** cmap from TrueType font (char code → glyph ID) */
  encoding: string | null;
  /** Differences array for encoding overrides */
  differences: Map<number, string>;
}

function findFontsInResources(resources: PDFDict, objects: Map<string, PDFObject>): FontInfo[] {
  const result: FontInfo[] = [];

  const fontDictRef = resources.get('Font');
  if (!fontDictRef) return result;

  const fontDict = resolveRef(fontDictRef, objects);
  if (!(fontDict instanceof PDFDict)) return result;

  for (const [name, ref] of fontDict.entries()) {
    const font = resolveRef(ref, objects);
    if (!(font instanceof PDFDict)) continue;

    const subtype = font.getName('Subtype');
    const isComposite = subtype === 'Type0';

    const info: FontInfo = {
      resourceName: name,
      fontDict: font,
      isComposite,
      ttfData: null,
      fontStreamKey: null,
      fontStream: null,
      cidToGidMap: null,
      encoding: font.getName('Encoding') ?? null,
      differences: new Map(),
    };

    // Parse encoding differences
    const encodingObj = font.get('Encoding');
    if (encodingObj) {
      const enc = resolveRef(encodingObj, objects);
      if (enc instanceof PDFDict) {
        const diffs = enc.getArray('Differences');
        if (diffs) {
          let code = 0;
          for (let i = 0; i < diffs.length; i++) {
            const item = diffs.get(i);
            if (item instanceof PDFNumber) {
              code = item.value;
            } else if (item instanceof PDFName) {
              info.differences.set(code, item.name);
              code++;
            }
          }
        }
      }
    }

    // Find the embedded font file
    let descriptorDict: PDFDict | null = null;

    if (isComposite) {
      // Type0 → DescendantFonts[0] → FontDescriptor
      const descFontsRef = font.get('DescendantFonts');
      if (descFontsRef) {
        const descFonts = resolveRef(descFontsRef, objects);
        if (descFonts instanceof PDFArray && descFonts.length > 0) {
          const cidFont = resolveRef(descFonts.get(0)!, objects);
          if (cidFont instanceof PDFDict) {
            // Check CIDToGIDMap
            const cidToGidRef = cidFont.get('CIDToGIDMap');
            if (cidToGidRef) {
              const resolved = resolveRef(cidToGidRef, objects);
              if (resolved instanceof PDFStream) {
                info.cidToGidMap = resolved.getBytes();
              }
            }
            const fdRef = cidFont.get('FontDescriptor');
            if (fdRef) {
              const fd = resolveRef(fdRef, objects);
              if (fd instanceof PDFDict) descriptorDict = fd;
            }
          }
        }
      }
    } else {
      // Simple font → FontDescriptor
      const fdRef = font.get('FontDescriptor');
      if (fdRef) {
        const fd = resolveRef(fdRef, objects);
        if (fd instanceof PDFDict) descriptorDict = fd;
      }
    }

    if (descriptorDict) {
      // Look for FontFile2 (TrueType) — this is what we can subset
      for (const ffKey of ['FontFile2', 'FontFile3']) {
        const ffRef = descriptorDict.get(ffKey);
        if (!ffRef) continue;

        // Get the object key for the font stream
        if (ffRef instanceof PDFRef) {
          info.fontStreamKey = ffRef.toKey();
        }

        const ffStream = resolveRef(ffRef, objects);
        if (ffStream instanceof PDFStream) {
          const bytes = ffStream.getBytes();
          if (isTrueTypeFontData(bytes)) {
            info.ttfData = bytes;
            info.fontStream = ffStream;
            if (!info.fontStreamKey && ffRef instanceof PDFRef) {
              info.fontStreamKey = ffRef.toKey();
            }
            break;
          }
        }
      }
    }

    if (info.ttfData) {
      result.push(info);
    }
  }

  return result;
}

// ─── Composite glyph expansion ──────────────────────────────────────────────

/**
 * Walk the glyf table for composite glyphs and add component glyph IDs
 * to the used set. This ensures accented characters (é = e + ´) keep
 * all their component glyphs.
 */
function expandCompositeGlyphs(ttf: TTFFont, glyphIds: Set<number>): void {
  const glyfTable = ttf.tables.get('glyf');
  const locaTable = ttf.tables.get('loca');
  if (!glyfTable || !locaTable) return;

  const data = ttf.rawData;
  const toCheck = [...glyphIds];
  const visited = new Set<number>();

  while (toCheck.length > 0) {
    const gid = toCheck.pop()!;
    if (visited.has(gid)) continue;
    visited.add(gid);

    const [offset, nextOffset] = getGlyphOffsets(ttf, gid);
    if (offset === nextOffset) continue; // Empty glyph

    const glyfOffset = glyfTable.offset + offset;
    if (glyfOffset + 10 > data.length) continue;

    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const numberOfContours = dv.getInt16(glyfOffset, false);

    if (numberOfContours >= 0) continue; // Simple glyph, no components

    // Composite glyph — parse component references
    let pos = glyfOffset + 10; // Skip header (numberOfContours + bbox)
    const MORE_COMPONENTS = 0x0020;
    const ARG_1_AND_2_ARE_WORDS = 0x0001;
    const WE_HAVE_A_SCALE = 0x0008;
    const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
    const WE_HAVE_A_TWO_BY_TWO = 0x0080;

    let moreComponents = true;
    while (moreComponents && pos + 4 <= data.length) {
      const flags = dv.getUint16(pos, false);
      const componentGlyphId = dv.getUint16(pos + 2, false);
      pos += 4;

      glyphIds.add(componentGlyphId);
      toCheck.push(componentGlyphId);

      // Skip arguments
      if (flags & ARG_1_AND_2_ARE_WORDS) {
        pos += 4;
      } else {
        pos += 2;
      }

      // Skip transformation
      if (flags & WE_HAVE_A_SCALE) pos += 2;
      else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) pos += 4;
      else if (flags & WE_HAVE_A_TWO_BY_TWO) pos += 8;

      moreComponents = !!(flags & MORE_COMPONENTS);
    }
  }
}

function getGlyphOffsets(ttf: TTFFont, glyphId: number): [number, number] {
  const locaTable = ttf.tables.get('loca');
  if (!locaTable) return [0, 0];

  const data = ttf.rawData;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);

  if (ttf.indexToLocFormat === 0) {
    // Short format
    const base = locaTable.offset + glyphId * 2;
    if (base + 4 > data.length) return [0, 0];
    return [dv.getUint16(base, false) * 2, dv.getUint16(base + 2, false) * 2];
  } else {
    // Long format
    const base = locaTable.offset + glyphId * 4;
    if (base + 8 > data.length) return [0, 0];
    return [dv.getUint32(base, false), dv.getUint32(base + 4, false)];
  }
}

// ─── sfnt rebuilder ─────────────────────────────────────────────────────────

/**
 * Rebuild a TrueType font binary, zeroing out unused glyph outlines.
 */
function buildSubsetFont(ttf: TTFFont, usedGlyphIds: Set<number>): Uint8Array {
  const data = ttf.rawData;
  const glyfTable = ttf.tables.get('glyf');
  const locaTable = ttf.tables.get('loca');

  if (!glyfTable || !locaTable) return data; // Can't subset without glyf/loca

  // Build new glyf table with unused glyphs zeroed
  const newGlyfParts: Uint8Array[] = [];
  const newOffsets: number[] = [];
  let currentOffset = 0;

  for (let gid = 0; gid < ttf.numGlyphs; gid++) {
    newOffsets.push(currentOffset);

    const [startOff, endOff] = getGlyphOffsets(ttf, gid);
    const glyphLen = endOff - startOff;

    if (glyphLen > 0 && usedGlyphIds.has(gid)) {
      // Keep this glyph
      const glyphData = data.slice(glyfTable.offset + startOff, glyfTable.offset + endOff);
      newGlyfParts.push(glyphData);
      currentOffset += glyphLen;
    }
    // Unused glyphs: offset stays the same (zero-length entry)
  }
  newOffsets.push(currentOffset); // Final offset (required by loca)

  // Pad glyf to 4-byte boundary
  const glyfPadding = (4 - (currentOffset % 4)) % 4;
  const newGlyfLen = currentOffset + glyfPadding;

  // Build new glyf bytes
  const newGlyf = new Uint8Array(newGlyfLen);
  let writePos = 0;
  for (const part of newGlyfParts) {
    newGlyf.set(part, writePos);
    writePos += part.length;
  }

  // Decide loca format based on offsets
  const useLongLoca = currentOffset > 0xFFFF * 2;
  const newLocaLen = useLongLoca
    ? (ttf.numGlyphs + 1) * 4
    : (ttf.numGlyphs + 1) * 2;
  // Pad loca to 4-byte boundary
  const locaPadding = (4 - (newLocaLen % 4)) % 4;
  const newLoca = new Uint8Array(newLocaLen + locaPadding);
  const locaDv = new DataView(newLoca.buffer);

  for (let i = 0; i <= ttf.numGlyphs; i++) {
    const off = newOffsets[i] ?? currentOffset;
    if (useLongLoca) {
      locaDv.setUint32(i * 4, off, false);
    } else {
      locaDv.setUint16(i * 2, Math.floor(off / 2), false);
    }
  }

  // Reassemble the sfnt file
  // Collect all tables, replacing glyf and loca
  const tables: Array<{ tag: string; data: Uint8Array }> = [];

  // Required table order for optimal compatibility
  const tableOrder = [
    'head', 'hhea', 'maxp', 'OS/2', 'name', 'cmap', 'post',
    'cvt ', 'fpgm', 'prep', 'gasp',
    'loca', 'glyf',
    'hmtx', 'kern', 'GPOS', 'GSUB', 'GDEF',
  ];

  const processedTags = new Set<string>();

  // Add tables in preferred order
  for (const tag of tableOrder) {
    const table = ttf.tables.get(tag);
    if (!table) continue;
    processedTags.add(tag);

    if (tag === 'glyf') {
      tables.push({ tag, data: newGlyf });
    } else if (tag === 'loca') {
      tables.push({ tag, data: newLoca });
    } else if (tag === 'head') {
      // Update indexToLocFormat in head table
      const headData = data.slice(table.offset, table.offset + table.length);
      const headCopy = new Uint8Array(headData);
      const headDv = new DataView(headCopy.buffer);
      headDv.setInt16(50, useLongLoca ? 1 : 0, false); // indexToLocFormat at offset 50
      tables.push({ tag, data: headCopy });
    } else {
      tables.push({ tag, data: data.slice(table.offset, table.offset + table.length) });
    }
  }

  // Add any remaining tables not in our preferred order
  for (const [tag, table] of ttf.tables) {
    if (processedTags.has(tag)) continue;
    if (tag === 'glyf' || tag === 'loca') continue;
    tables.push({ tag, data: data.slice(table.offset, table.offset + table.length) });
  }

  return assembleSfnt(data, tables);
}

/**
 * Assemble sfnt binary from table data.
 */
function assembleSfnt(
  original: Uint8Array,
  tables: Array<{ tag: string; data: Uint8Array }>,
): Uint8Array {
  const numTables = tables.length;

  // Calculate searchRange, entrySelector, rangeShift
  let entrySelector = 0;
  let searchRange = 1;
  while (searchRange * 2 <= numTables) {
    searchRange *= 2;
    entrySelector++;
  }
  searchRange *= 16;
  const rangeShift = numTables * 16 - searchRange;

  // Header: 12 bytes + 16 bytes per table record
  const headerSize = 12 + numTables * 16;

  // Calculate total size
  let totalSize = headerSize;
  for (const table of tables) {
    // Pad each table to 4-byte boundary
    totalSize += table.data.length + ((4 - (table.data.length % 4)) % 4);
  }

  const result = new Uint8Array(totalSize);
  const dv = new DataView(result.buffer);

  // Detect sfVersion from original
  const origDv = new DataView(original.buffer, original.byteOffset, original.byteLength);
  const sfVersion = origDv.getUint32(0, false);

  // Write offset table header
  dv.setUint32(0, sfVersion, false);
  dv.setUint16(4, numTables, false);
  dv.setUint16(6, searchRange, false);
  dv.setUint16(8, entrySelector, false);
  dv.setUint16(10, rangeShift, false);

  // Write table directory and data
  let dataOffset = headerSize;
  for (let i = 0; i < tables.length; i++) {
    const table = tables[i];
    const recordOffset = 12 + i * 16;

    // Write tag
    for (let j = 0; j < 4; j++) {
      result[recordOffset + j] = table.tag.charCodeAt(j);
    }

    // Calculate checksum
    const checksum = calcTableChecksum(table.data);
    dv.setUint32(recordOffset + 4, checksum, false);

    // Write offset and length
    dv.setUint32(recordOffset + 8, dataOffset, false);
    dv.setUint32(recordOffset + 12, table.data.length, false);

    // Write table data
    result.set(table.data, dataOffset);
    dataOffset += table.data.length + ((4 - (table.data.length % 4)) % 4);
  }

  // Update head checkSumAdjustment
  const headIdx = tables.findIndex(t => t.tag === 'head');
  if (headIdx >= 0) {
    const headRecordOffset = 12 + headIdx * 16;
    const headDataOffset = dv.getUint32(headRecordOffset + 8, false);
    // Set checksumAdjustment to 0 first
    dv.setUint32(headDataOffset + 8, 0, false);
    // Calculate full file checksum
    const fullChecksum = calcTableChecksum(result);
    dv.setUint32(headDataOffset + 8, (0xB1B0AFBA - fullChecksum) >>> 0, false);
  }

  return result;
}

function calcTableChecksum(data: Uint8Array): number {
  // Pad to 4-byte aligned length
  const aligned = new Uint8Array(data.length + ((4 - (data.length % 4)) % 4));
  aligned.set(data);
  const dv = new DataView(aligned.buffer);
  let sum = 0;
  for (let i = 0; i < aligned.length; i += 4) {
    sum = (sum + dv.getUint32(i, false)) >>> 0;
  }
  return sum;
}

// ─── Main entry point ───────────────────────────────────────────────────────

/**
 * Subset all embedded TrueType fonts in the document, removing unused glyph
 * outlines. Modifies font streams in-place.
 */
export async function subsetFonts(doc: PDFDocumentData): Promise<FontSubsetResult> {
  const result: FontSubsetResult = {
    fontsSubsetted: 0,
    bytesSaved: 0,
    details: [],
  };

  const usedGlyphs = collectUsedGlyphs(doc);

  for (const [streamKey, entry] of usedGlyphs) {
    const { glyphIds, font, stream } = entry;
    const originalData = font.rawData;

    // Don't bother if we're using most of the glyphs
    if (glyphIds.size >= font.numGlyphs * 0.9) continue;

    // Don't bother for tiny fonts
    if (originalData.length < 4096) continue;

    try {
      const subsetData = buildSubsetFont(font, glyphIds);

      // Only use if actually smaller
      if (subsetData.length >= originalData.length) continue;

      const saved = originalData.length - subsetData.length;

      // Flate-compress the subset font
      const compressed = await flateEncode(subsetData);

      // Replace the font stream in the document
      stream.rawBytes = compressed;
      stream.decodedBytes = subsetData;
      stream.dict.set('Length', new PDFNumber(compressed.length));
      stream.dict.set('Length1', new PDFNumber(subsetData.length));
      stream.dict.set('Filter', new PDFName('FlateDecode'));
      stream.dict.delete('DecodeParms');

      result.fontsSubsetted++;
      result.bytesSaved += saved;
      result.details.push({
        fontName: font.familyName || font.fullName || streamKey,
        originalSize: originalData.length,
        subsetSize: subsetData.length,
        glyphsKept: glyphIds.size,
        glyphsTotal: font.numGlyphs,
      });
    } catch (err) {
      console.warn(`[Font Subset] Failed to subset font at ${streamKey}:`, err);
    }
  }

  return result;
}
