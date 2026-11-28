/**
 * TrueType / OpenType Font Parser
 *
 * Reads embedded TrueType (.ttf) and OpenType (.otf) font data from PDF streams.
 * Extracts:
 *   - Font metrics (head, hhea, hmtx, OS/2)
 *   - Character mapping (cmap)
 *   - Glyph outlines (glyf + loca) for path-based rendering
 *   - Font names (name table)
 *   - PostScript glyph names (post table)
 *
 * This is the lowest level of font handling — reads raw binary font tables.
 */

// ─── Data types ─────────────────────────────────────────────────────────────

export interface TTFFont {
  /** Parsed table directory */
  tables: Map<string, TTFTable>;
  /** Number of glyphs */
  numGlyphs: number;
  /** Units per em (typically 1000 or 2048) */
  unitsPerEm: number;
  /** Font bounding box [xMin, yMin, xMax, yMax] in font units */
  bbox: [number, number, number, number];
  /** Ascent in font units */
  ascent: number;
  /** Descent in font units (negative) */
  descent: number;
  /** Line gap */
  lineGap: number;
  /** Glyph advance widths indexed by glyph ID */
  advanceWidths: Uint16Array;
  /** Left side bearings indexed by glyph ID */
  leftSideBearings: Int16Array;
  /** CMap: character code → glyph ID */
  cmapEntries: Map<number, number>;
  /** PostScript glyph names (glyph ID → name) */
  glyphNames: Map<number, string>;
  /** Font family name */
  familyName: string;
  /** Full font name */
  fullName: string;
  /** Glyph outlines (lazily populated) */
  glyphCache: Map<number, GlyphOutline>;
  /** Raw font data (for re-embedding) */
  rawData: Uint8Array;
  /** Index format for loca table (0 = short, 1 = long) */
  indexToLocFormat: number;
}

export interface TTFTable {
  tag: string;
  checksum: number;
  offset: number;
  length: number;
}

export interface GlyphOutline {
  /** Path commands for rendering */
  commands: GlyphCommand[];
  /** Advance width in font units */
  advanceWidth: number;
  /** Left side bearing */
  lsb: number;
  /** Bounding box [xMin, yMin, xMax, yMax] */
  bbox: [number, number, number, number];
}

export interface GlyphCommand {
  type: 'M' | 'L' | 'Q' | 'C' | 'Z';
  /** For M/L: [x, y], for Q: [cx, cy, x, y], for C: [cx1, cy1, cx2, cy2, x, y] */
  args: number[];
}

// ─── Binary reader ──────────────────────────────────────────────────────────

class BinaryReader {
  private data: DataView;
  private raw: Uint8Array;
  pos: number;

  constructor(data: Uint8Array, offset: number = 0) {
    this.raw = data;
    this.data = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.pos = offset;
  }

  get length(): number { return this.raw.length; }

  readU8(): number {
    return this.data.getUint8(this.pos++);
  }

  readU16(): number {
    const v = this.data.getUint16(this.pos, false); // big-endian
    this.pos += 2;
    return v;
  }

  readI16(): number {
    const v = this.data.getInt16(this.pos, false);
    this.pos += 2;
    return v;
  }

  readU32(): number {
    const v = this.data.getUint32(this.pos, false);
    this.pos += 4;
    return v;
  }

  readI32(): number {
    const v = this.data.getInt32(this.pos, false);
    this.pos += 4;
    return v;
  }

  readFixed(): number {
    return this.readI32() / 65536;
  }

  readTag(): string {
    let s = '';
    for (let i = 0; i < 4; i++) s += String.fromCharCode(this.readU8());
    return s;
  }

  readBytes(count: number): Uint8Array {
    const bytes = this.raw.slice(this.pos, this.pos + count);
    this.pos += count;
    return bytes;
  }

  readString(length: number): string {
    let s = '';
    for (let i = 0; i < length; i++) s += String.fromCharCode(this.readU8());
    return s;
  }

  seek(offset: number): void {
    this.pos = offset;
  }

  skip(count: number): void {
    this.pos += count;
  }

  atEnd(): boolean {
    return this.pos >= this.raw.length;
  }
}

// ─── Main parser ────────────────────────────────────────────────────────────

/**
 * Detect TrueType / OpenType sfnt container signatures.
 */
export function isTrueTypeFontData(data: Uint8Array): boolean {
  if (data.length < 4) return false;
  const sig = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
  return (
    sig === 0x00010000 || // TrueType
    sig === 0x74727565 || // 'true'
    sig === 0x4F54544F    // 'OTTO'
  );
}

/**
 * Parse a TrueType / OpenType font from raw bytes.
 */
export function parseTTF(data: Uint8Array): TTFFont {
  const reader = new BinaryReader(data);

  // Read offset table
  const sfVersion = reader.readU32(); // 0x00010000 for TrueType, 'OTTO' for CFF
  const numTables = reader.readU16();
  reader.skip(6); // searchRange, entrySelector, rangeShift

  // Read table directory
  const tables = new Map<string, TTFTable>();
  for (let i = 0; i < numTables; i++) {
    const tag = reader.readTag();
    const checksum = reader.readU32();
    const offset = reader.readU32();
    const length = reader.readU32();
    tables.set(tag, { tag, checksum, offset, length });
  }

  const font: TTFFont = {
    tables,
    numGlyphs: 0,
    unitsPerEm: 1000,
    bbox: [0, 0, 0, 0],
    ascent: 800,
    descent: -200,
    lineGap: 0,
    advanceWidths: new Uint16Array(0),
    leftSideBearings: new Int16Array(0),
    cmapEntries: new Map(),
    glyphNames: new Map(),
    familyName: '',
    fullName: '',
    glyphCache: new Map(),
    rawData: data,
    indexToLocFormat: 0,
  };

  // Parse required tables
  parseHead(data, tables, font);
  parseMaxp(data, tables, font);
  parseHhea(data, tables, font);
  parseHmtx(data, tables, font);
  parseCmap(data, tables, font);
  parseName(data, tables, font);
  parseOS2(data, tables, font);

  return font;
}

// ─── Table parsers ──────────────────────────────────────────────────────────

function parseHead(data: Uint8Array, tables: Map<string, TTFTable>, font: TTFFont): void {
  const table = tables.get('head');
  if (!table) return;

  const r = new BinaryReader(data, table.offset);
  r.skip(4); // majorVersion, minorVersion
  r.skip(4); // fontRevision (Fixed)
  r.skip(4); // checksumAdjustment
  r.skip(4); // magicNumber
  r.skip(2); // flags
  font.unitsPerEm = r.readU16();
  r.skip(16); // created, modified (LONGDATETIME × 2)
  font.bbox = [r.readI16(), r.readI16(), r.readI16(), r.readI16()];
  r.skip(2); // macStyle
  r.skip(2); // lowestRecPPEM
  r.skip(2); // fontDirectionHint
  font.indexToLocFormat = r.readI16();
}

function parseMaxp(data: Uint8Array, tables: Map<string, TTFTable>, font: TTFFont): void {
  const table = tables.get('maxp');
  if (!table) return;

  const r = new BinaryReader(data, table.offset);
  r.skip(4); // version
  font.numGlyphs = r.readU16();
}

function parseHhea(data: Uint8Array, tables: Map<string, TTFTable>, font: TTFFont): void {
  const table = tables.get('hhea');
  if (!table) return;

  const r = new BinaryReader(data, table.offset);
  r.skip(4); // majorVersion, minorVersion
  font.ascent = r.readI16();
  font.descent = r.readI16();
  font.lineGap = r.readI16();
  // advanceWidthMax, minLeftSideBearing, etc. — we read these from hmtx
}

function parseHmtx(data: Uint8Array, tables: Map<string, TTFTable>, font: TTFFont): void {
  const hheaTable = tables.get('hhea');
  const hmtxTable = tables.get('hmtx');
  if (!hheaTable || !hmtxTable) return;

  // Get numberOfHMetrics from hhea (at offset 34)
  const hheaReader = new BinaryReader(data, hheaTable.offset);
  hheaReader.skip(34);
  const numberOfHMetrics = hheaReader.readU16();

  const r = new BinaryReader(data, hmtxTable.offset);
  font.advanceWidths = new Uint16Array(font.numGlyphs);
  font.leftSideBearings = new Int16Array(font.numGlyphs);

  // Read longHorMetric entries
  let lastAdvanceWidth = 0;
  for (let i = 0; i < numberOfHMetrics && i < font.numGlyphs; i++) {
    font.advanceWidths[i] = r.readU16();
    font.leftSideBearings[i] = r.readI16();
    lastAdvanceWidth = font.advanceWidths[i];
  }

  // Remaining glyphs use the last advanceWidth
  for (let i = numberOfHMetrics; i < font.numGlyphs; i++) {
    font.advanceWidths[i] = lastAdvanceWidth;
    if (!r.atEnd()) {
      font.leftSideBearings[i] = r.readI16();
    }
  }
}

function parseCmap(data: Uint8Array, tables: Map<string, TTFTable>, font: TTFFont): void {
  const table = tables.get('cmap');
  if (!table) return;

  const r = new BinaryReader(data, table.offset);
  r.skip(2); // version
  const numSubtables = r.readU16();

  // Collect usable subtables. Prefer Unicode BMP, but also merge Mac Roman and
  // Microsoft Symbol (3,0) — Symbol subsets often only expose those.
  const subtables: Array<{ offset: number; priority: number }> = [];

  for (let i = 0; i < numSubtables; i++) {
    const platformID = r.readU16();
    const encodingID = r.readU16();
    const offset = r.readU32();

    let priority = 0;
    if (platformID === 3 && encodingID === 1) priority = 10; // Windows Unicode BMP
    else if (platformID === 3 && encodingID === 10) priority = 9; // Windows Unicode full
    else if (platformID === 0) priority = 8; // Unicode
    else if (platformID === 3 && encodingID === 0) priority = 6; // Microsoft Symbol
    else if (platformID === 1 && encodingID === 0) priority = 5; // Mac Roman

    if (priority > 0) {
      subtables.push({ offset: table.offset + offset, priority });
    }
  }

  subtables.sort((a, b) => b.priority - a.priority);

  // Parse highest-priority first, then merge lower ones without overwriting.
  for (const sub of subtables) {
    const before = font.cmapEntries.size;
    const sr = new BinaryReader(data, sub.offset);
    const format = sr.readU16();
    const scratch: TTFFont = before === 0 ? font : {
      ...font,
      cmapEntries: new Map(),
    };

    switch (format) {
      case 0:
        parseCmapFormat0(sr, scratch);
        break;
      case 4:
        parseCmapFormat4(sr, scratch);
        break;
      case 6:
        parseCmapFormat6(sr, scratch);
        break;
      case 12:
        parseCmapFormat12(sr, scratch);
        break;
      default:
        break;
    }

    if (scratch === font) continue;
    for (const [code, gid] of scratch.cmapEntries) {
      if (!font.cmapEntries.has(code)) font.cmapEntries.set(code, gid);
    }
  }
}

/**
 * Reverse-lookup: glyph ID → a cmap character code (prefer Symbol PUA / printable).
 */
export function glyphIdToCmapCode(font: TTFFont, glyphId: number): number | null {
  let best: number | null = null;
  for (const [code, gid] of font.cmapEntries) {
    if (gid !== glyphId) continue;
    if (best == null) best = code;
    if (code >= 0xF020 && code <= 0xF0FF) return code;
    if (code >= 0x20 && code <= 0xFF && (best < 0x20 || best > 0xFF)) best = code;
  }
  return best;
}

function parseCmapFormat0(r: BinaryReader, font: TTFFont): void {
  r.skip(2); // length
  r.skip(2); // language
  for (let i = 0; i < 256; i++) {
    const glyphId = r.readU8();
    if (glyphId > 0) font.cmapEntries.set(i, glyphId);
  }
}

function parseCmapFormat4(r: BinaryReader, font: TTFFont): void {
  const length = r.readU16();
  r.skip(2); // language
  const segCount = r.readU16() / 2;
  r.skip(6); // searchRange, entrySelector, rangeShift

  const endCodes: number[] = [];
  for (let i = 0; i < segCount; i++) endCodes.push(r.readU16());
  r.skip(2); // reservedPad

  const startCodes: number[] = [];
  for (let i = 0; i < segCount; i++) startCodes.push(r.readU16());

  const idDeltas: number[] = [];
  for (let i = 0; i < segCount; i++) idDeltas.push(r.readI16());

  const idRangeOffsetPos = r.pos;
  const idRangeOffsets: number[] = [];
  for (let i = 0; i < segCount; i++) idRangeOffsets.push(r.readU16());

  for (let i = 0; i < segCount; i++) {
    const start = startCodes[i];
    const end = endCodes[i];
    const delta = idDeltas[i];
    const rangeOffset = idRangeOffsets[i];

    if (start === 0xFFFF) continue;

    for (let c = start; c <= end; c++) {
      let glyphId: number;

      if (rangeOffset === 0) {
        glyphId = (c + delta) & 0xFFFF;
      } else {
        const glyphIndexOffset = idRangeOffsetPos + i * 2 + rangeOffset + (c - start) * 2;
        const glyphReader = new BinaryReader(font.rawData, glyphIndexOffset);
        glyphId = glyphReader.readU16();
        if (glyphId !== 0) {
          glyphId = (glyphId + delta) & 0xFFFF;
        }
      }

      if (glyphId !== 0) {
        font.cmapEntries.set(c, glyphId);
      }
    }
  }
}

function parseCmapFormat6(r: BinaryReader, font: TTFFont): void {
  r.skip(2); // length
  r.skip(2); // language
  const firstCode = r.readU16();
  const entryCount = r.readU16();
  for (let i = 0; i < entryCount; i++) {
    const glyphId = r.readU16();
    if (glyphId !== 0) {
      font.cmapEntries.set(firstCode + i, glyphId);
    }
  }
}

function parseCmapFormat12(r: BinaryReader, font: TTFFont): void {
  r.skip(2); // reserved
  r.skip(4); // length
  r.skip(4); // language
  const numGroups = r.readU32();
  for (let i = 0; i < numGroups; i++) {
    const startCharCode = r.readU32();
    const endCharCode = r.readU32();
    const startGlyphID = r.readU32();
    for (let c = startCharCode; c <= endCharCode; c++) {
      font.cmapEntries.set(c, startGlyphID + (c - startCharCode));
    }
  }
}

function parseName(data: Uint8Array, tables: Map<string, TTFTable>, font: TTFFont): void {
  const table = tables.get('name');
  if (!table) return;

  const r = new BinaryReader(data, table.offset);
  r.skip(2); // format
  const count = r.readU16();
  const stringOffset = r.readU16();

  for (let i = 0; i < count; i++) {
    const platformID = r.readU16();
    const encodingID = r.readU16();
    const languageID = r.readU16();
    const nameID = r.readU16();
    const length = r.readU16();
    const offset = r.readU16();

    // Read font family (nameID 1) and full name (nameID 4)
    if (nameID === 1 || nameID === 4) {
      const savedPos = r.pos;
      r.seek(table.offset + stringOffset + offset);

      let name = '';
      if (platformID === 3 || platformID === 0) {
        // Unicode (UTF-16 BE)
        for (let j = 0; j < length; j += 2) {
          name += String.fromCharCode(r.readU16());
        }
      } else {
        // Mac Roman (ASCII subset)
        name = r.readString(length);
      }

      r.seek(savedPos);

      if (nameID === 1 && !font.familyName) font.familyName = name;
      if (nameID === 4 && !font.fullName) font.fullName = name;
    }
  }
}

function parseOS2(data: Uint8Array, tables: Map<string, TTFTable>, font: TTFFont): void {
  const table = tables.get('OS/2');
  if (!table) return;

  const r = new BinaryReader(data, table.offset);
  r.skip(2); // version
  r.skip(2); // xAvgCharWidth
  r.skip(2); // usWeightClass
  r.skip(2); // usWidthClass
  r.skip(2); // fsType
  r.skip(20); // subscript/superscript metrics
  r.skip(2); // yStrikeoutSize
  r.skip(2); // yStrikeoutPosition
  r.skip(2); // sFamilyClass
  r.skip(10); // panose
  r.skip(16); // ulUnicodeRange
  r.skip(4); // achVendID
  r.skip(2); // fsSelection
  r.skip(4); // usFirstCharIndex, usLastCharIndex

  // sTypoAscender, sTypoDescender — more reliable than hhea values
  const typoAscender = r.readI16();
  const typoDescender = r.readI16();

  if (typoAscender !== 0) font.ascent = typoAscender;
  if (typoDescender !== 0) font.descent = typoDescender;
}

// ─── Glyph outline extraction ───────────────────────────────────────────────

/**
 * Get the outline of a glyph by its glyph ID.
 * Parses the glyf table and follows composite glyph references.
 */
export function getGlyphOutline(font: TTFFont, glyphId: number): GlyphOutline | null {
  // Check cache
  const cached = font.glyphCache.get(glyphId);
  if (cached) return cached;

  const glyfTable = font.tables.get('glyf');
  const locaTable = font.tables.get('loca');
  if (!glyfTable || !locaTable) return null;

  // Read glyph offset from loca table
  const locaReader = new BinaryReader(font.rawData, locaTable.offset);
  let glyphOffset: number;
  let nextOffset: number;

  if (font.indexToLocFormat === 0) {
    // Short format (offsets are in words, multiply by 2)
    locaReader.seek(locaTable.offset + glyphId * 2);
    glyphOffset = locaReader.readU16() * 2;
    nextOffset = locaReader.readU16() * 2;
  } else {
    // Long format (offsets are in bytes)
    locaReader.seek(locaTable.offset + glyphId * 4);
    glyphOffset = locaReader.readU32();
    nextOffset = locaReader.readU32();
  }

  // Empty glyph (like space)
  if (glyphOffset === nextOffset) {
    const outline: GlyphOutline = {
      commands: [],
      advanceWidth: font.advanceWidths[glyphId] || 0,
      lsb: font.leftSideBearings[glyphId] || 0,
      bbox: [0, 0, 0, 0],
    };
    font.glyphCache.set(glyphId, outline);
    return outline;
  }

  const r = new BinaryReader(font.rawData, glyfTable.offset + glyphOffset);
  const numberOfContours = r.readI16();
  const xMin = r.readI16();
  const yMin = r.readI16();
  const xMax = r.readI16();
  const yMax = r.readI16();

  let commands: GlyphCommand[];

  if (numberOfContours >= 0) {
    // Simple glyph
    commands = parseSimpleGlyph(r, numberOfContours);
  } else {
    // Composite glyph
    commands = parseCompositeGlyph(r, font);
  }

  const outline: GlyphOutline = {
    commands,
    advanceWidth: font.advanceWidths[glyphId] || 0,
    lsb: font.leftSideBearings[glyphId] || 0,
    bbox: [xMin, yMin, xMax, yMax],
  };

  font.glyphCache.set(glyphId, outline);
  return outline;
}

function parseSimpleGlyph(r: BinaryReader, numberOfContours: number): GlyphCommand[] {
  // Read contour end points
  const endPtsOfContours: number[] = [];
  for (let i = 0; i < numberOfContours; i++) {
    endPtsOfContours.push(r.readU16());
  }

  // Skip instructions
  const instructionLength = r.readU16();
  r.skip(instructionLength);

  const numPoints = numberOfContours > 0
    ? endPtsOfContours[endPtsOfContours.length - 1] + 1
    : 0;

  // Read flags
  const flags: number[] = [];
  for (let i = 0; i < numPoints;) {
    const flag = r.readU8();
    flags.push(flag);
    i++;

    // Repeat flag
    if (flag & 0x08) {
      const repeatCount = r.readU8();
      for (let j = 0; j < repeatCount; j++) {
        flags.push(flag);
        i++;
      }
    }
  }

  // Read x coordinates
  const xCoords: number[] = [];
  let x = 0;
  for (let i = 0; i < numPoints; i++) {
    const flag = flags[i];
    if (flag & 0x02) {
      // 1 byte
      const dx = r.readU8();
      x += (flag & 0x10) ? dx : -dx;
    } else if (flag & 0x10) {
      // Same as previous (no delta)
    } else {
      // 2 bytes (signed)
      x += r.readI16();
    }
    xCoords.push(x);
  }

  // Read y coordinates
  const yCoords: number[] = [];
  let y = 0;
  for (let i = 0; i < numPoints; i++) {
    const flag = flags[i];
    if (flag & 0x04) {
      const dy = r.readU8();
      y += (flag & 0x20) ? dy : -dy;
    } else if (flag & 0x20) {
      // Same as previous
    } else {
      y += r.readI16();
    }
    yCoords.push(y);
  }

  // Convert to path commands
  const commands: GlyphCommand[] = [];
  let contourStart = 0;

  for (let c = 0; c < numberOfContours; c++) {
    const contourEnd = endPtsOfContours[c];
    const n = contourEnd - contourStart + 1;
    if (n <= 0) {
      contourStart = contourEnd + 1;
      continue;
    }
    const px = (k: number) => xCoords[contourStart + k];
    const py = (k: number) => yCoords[contourStart + k];
    const on = (k: number) => !!(flags[contourStart + k] & 0x01);

    // Visit every point exactly once, starting after point n-1 (the standard
    // TrueType walk). Consecutive off-curve points imply an on-curve midpoint.
    if (on(n - 1)) {
      commands.push({ type: 'M', args: [px(n - 1), py(n - 1)] });
    } else if (on(0)) {
      commands.push({ type: 'M', args: [px(0), py(0)] });
    } else {
      commands.push({ type: 'M', args: [(px(n - 1) + px(0)) / 2, (py(n - 1) + py(0)) / 2] });
    }
    for (let k = 0; k < n; k++) {
      if (on(k)) {
        if (k === 0 && !on(n - 1)) continue; // already the start point
        commands.push({ type: 'L', args: [px(k), py(k)] });
        continue;
      }
      const nx = (k + 1) % n;
      const endX = on(nx) ? px(nx) : (px(k) + px(nx)) / 2;
      const endY = on(nx) ? py(nx) : (py(k) + py(nx)) / 2;
      commands.push({ type: 'Q', args: [px(k), py(k), endX, endY] });
      if (on(nx) && nx !== 0) k++; // that on-curve point is the end of this curve
    }

    commands.push({ type: 'Z', args: [] });
    contourStart = contourEnd + 1;
  }

  return commands;
}

function parseCompositeGlyph(r: BinaryReader, font: TTFFont): GlyphCommand[] {
  const commands: GlyphCommand[] = [];
  let moreComponents = true;

  while (moreComponents) {
    const compFlags = r.readU16();
    const glyphIndex = r.readU16();

    // Read arguments (offsets or point numbers)
    let dx = 0, dy = 0;
    if (compFlags & 0x01) {
      // ARG_1_AND_2_ARE_WORDS
      if (compFlags & 0x02) {
        dx = r.readI16();
        dy = r.readI16();
      } else {
        r.skip(4); // Point numbers, not implemented
      }
    } else {
      if (compFlags & 0x02) {
        dx = (r.readU8() << 24) >> 24; // Sign extend
        dy = (r.readU8() << 24) >> 24;
      } else {
        r.skip(2); // Point numbers
      }
    }

    // Read transformation (scale, rotation, etc.)
    let scaleX = 1, scaleY = 1, scale01 = 0, scale10 = 0;
    if (compFlags & 0x08) {
      // WE_HAVE_A_SCALE
      scaleX = scaleY = r.readI16() / 16384;
    } else if (compFlags & 0x40) {
      // WE_HAVE_AN_X_AND_Y_SCALE
      scaleX = r.readI16() / 16384;
      scaleY = r.readI16() / 16384;
    } else if (compFlags & 0x80) {
      // WE_HAVE_A_TWO_BY_TWO
      scaleX = r.readI16() / 16384;
      scale01 = r.readI16() / 16384;
      scale10 = r.readI16() / 16384;
      scaleY = r.readI16() / 16384;
    }

    // Get component glyph outline
    const componentOutline = getGlyphOutline(font, glyphIndex);
    if (componentOutline) {
      // Apply transformation
      for (const cmd of componentOutline.commands) {
        const transformedArgs: number[] = [];
        for (let i = 0; i < cmd.args.length; i += 2) {
          const x = cmd.args[i];
          const y = cmd.args[i + 1];
          transformedArgs.push(
            x * scaleX + y * scale01 + dx,
            x * scale10 + y * scaleY + dy,
          );
        }
        commands.push({ type: cmd.type, args: cmd.type === 'Z' ? [] : transformedArgs });
      }
    }

    moreComponents = !!(compFlags & 0x20); // MORE_COMPONENTS
  }

  return commands;
}

// ─── Utility functions ──────────────────────────────────────────────────────

/**
 * Get the glyph ID for a Unicode character code.
 */
export function charCodeToGlyphId(font: TTFFont, charCode: number): number {
  return font.cmapEntries.get(charCode) ?? 0;
}

/**
 * Get the advance width for a glyph in font units.
 */
export function getGlyphWidth(font: TTFFont, glyphId: number): number {
  if (glyphId < font.advanceWidths.length) {
    return font.advanceWidths[glyphId];
  }
  return font.advanceWidths[font.advanceWidths.length - 1] || 0;
}

/**
 * Convert font units to PDF text space (1/1000 units).
 */
export function fontUnitsToTextSpace(value: number, unitsPerEm: number): number {
  return (value / unitsPerEm) * 1000;
}
