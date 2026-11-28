/**
 * PDF Cross-Reference Table/Stream Parser
 *
 * Handles all xref formats:
 *   - Traditional xref tables (PDF 1.0+)
 *   - Cross-reference streams (PDF 1.5+)
 *   - Incremental updates (multiple xref sections chained via /Prev)
 *   - Hybrid xref (table + stream in same file)
 *
 * The xref maps object numbers to byte offsets in the file,
 * allowing random access to any indirect object.
 */

import { PDFLexer, TokenType } from './lexer';
import {
  PDFDict,
  PDFArray,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFBoolean,
  PDFString,
  PDFHexString,
  PDFNull,
  PDFStream,
  type PDFObject,
  type XRefEntry,
  type XRefTable,
} from '../types';
import { applyFilters } from './filters';

// ─── Find startxref ─────────────────────────────────────────────────────────

/**
 * Find the byte offset of the most recent xref section.
 * Per PDF spec, the file ends with:
 *   startxref
 *   <offset>
 *   %%EOF
 *
 * We search backward from end of file to find "startxref".
 */
export function findStartXref(data: Uint8Array): number {
  const lexer = new PDFLexer(data);

  // Search backward from end for "startxref"
  const pos = lexer.searchBackward('startxref');
  if (pos === -1) {
    throw new Error('Cannot find startxref — file may be corrupted or not a PDF');
  }

  // Position after "startxref"
  lexer.position = pos + 'startxref'.length;
  lexer.skipWhitespaceAndComments();

  // Read the offset value
  const token = lexer.nextToken();
  if (!token || token.type !== TokenType.Integer) {
    throw new Error('Invalid startxref value');
  }

  return token.value as number;
}

// ─── Parse traditional xref table ───────────────────────────────────────────

/**
 * Parse a traditional xref table starting at the given byte offset.
 * Format:
 *   xref
 *   0 6          ← subsection: start_obj_num count
 *   0000000000 65535 f   ← offset gen type
 *   0000000009 00000 n
 *   ...
 *   trailer
 *   << /Size 6 /Root 1 0 R >>
 */
export function parseXrefTable(data: Uint8Array, offset: number): XRefTable {
  const lexer = new PDFLexer(data, offset);

  // Read "xref" keyword
  lexer.skipWhitespaceAndComments();
  const xrefKeyword = lexer.nextToken();
  if (!xrefKeyword || xrefKeyword.value !== 'xref') {
    throw new Error(`Expected 'xref' keyword at offset ${offset}, got: ${xrefKeyword?.value}`);
  }

  const entries = new Map<string, XRefEntry>();

  // Read subsections until we hit "trailer"
  while (true) {
    lexer.skipWhitespaceAndComments();

    // Peek to see if we've hit "trailer"
    const savedPos = lexer.position;
    const nextTok = lexer.nextToken();

    if (!nextTok || nextTok.value === 'trailer') {
      break;
    }

    // This should be the start object number of a subsection
    if (nextTok.type !== TokenType.Integer) {
      // Might be something unexpected — try to recover
      break;
    }

    const startObjNum = nextTok.value as number;

    // Read count
    const countTok = lexer.nextToken();
    if (!countTok || countTok.type !== TokenType.Integer) {
      throw new Error('Expected object count in xref subsection');
    }
    const count = countTok.value as number;

    // Read entries
    for (let i = 0; i < count; i++) {
      lexer.skipWhitespace();

      // Each entry is exactly: "0000000009 00000 n \n" (20 bytes including EOL)
      // But we'll parse flexibly using the lexer
      const offsetTok = lexer.nextToken();
      const genTok = lexer.nextToken();
      const typeTok = lexer.nextToken();

      if (!offsetTok || !genTok || !typeTok) {
        break;
      }

      const objNum = startObjNum + i;
      const byteOffset = offsetTok.value as number;
      const genNum = genTok.value as number;
      const type = (typeTok.value as string) === 'n' ? 'n' as const : 'f' as const;

      const key = `${objNum}_${genNum}`;
      // Only add if not already present (later xref sections take precedence
      // because we process them first due to /Prev chain)
      if (!entries.has(key)) {
        entries.set(key, { objNum, genNum, offset: byteOffset, type });
      }
    }
  }

  // Parse trailer dictionary
  lexer.skipWhitespaceAndComments();
  const trailerDict = parseObject(lexer) as PDFDict;

  if (!(trailerDict instanceof PDFDict)) {
    throw new Error('Expected trailer dictionary');
  }

  return { entries, trailerDict };
}

// ─── Parse cross-reference stream (PDF 1.5+) ───────────────────────────────

/**
 * Parse a cross-reference stream object.
 * XRef streams are indirect objects with /Type /XRef.
 * The stream data contains packed binary entries.
 */
export async function parseXrefStream(
  data: Uint8Array,
  offset: number,
): Promise<XRefTable> {
  const lexer = new PDFLexer(data, offset);

  // Read: objNum genNum obj
  const objNumTok = lexer.nextToken();
  const genNumTok = lexer.nextToken();
  const objKeyword = lexer.nextToken();

  if (!objKeyword || objKeyword.value !== 'obj') {
    throw new Error(`Expected 'obj' keyword at xref stream offset ${offset}`);
  }

  // Parse the stream object (dict + stream data)
  const streamObj = parseStreamObject(lexer, data);

  if (!(streamObj instanceof PDFStream)) {
    throw new Error('XRef stream is not a stream object');
  }

  const dict = streamObj.dict;

  // Decode the stream
  const filters = streamObj.getFilters();
  const params = streamObj.getDecodeParams();
  const decodedData = filters.length > 0
    ? await applyFilters(streamObj.rawBytes, filters, params)
    : streamObj.rawBytes;

  // Read W array: field widths [type_width offset_width gen_width]
  const wArray = dict.getArray('W');
  if (!wArray) throw new Error('XRef stream missing /W array');
  const w = wArray.asNumbers();
  if (w.length < 3) throw new Error('XRef stream /W array must have 3 entries');
  const [w0, w1, w2] = w;
  const entrySize = w0 + w1 + w2;

  // Read Index array: [start count start count ...]
  // Default: [0 Size]
  const size = dict.getNumber('Size') ?? 0;
  const indexArray = dict.getArray('Index');
  const indices: number[] = indexArray
    ? indexArray.asNumbers()
    : [0, size];

  const entries = new Map<string, XRefEntry>();

  let dataPos = 0;
  for (let i = 0; i < indices.length; i += 2) {
    const startObj = indices[i];
    const count = indices[i + 1];

    for (let j = 0; j < count; j++) {
      // Read fields from the binary data
      const type = w0 > 0 ? readIntFromBytes(decodedData, dataPos, w0) : 1; // default type 1
      dataPos += w0;
      const field2 = readIntFromBytes(decodedData, dataPos, w1);
      dataPos += w1;
      const field3 = readIntFromBytes(decodedData, dataPos, w2);
      dataPos += w2;

      const objNum = startObj + j;

      if (type === 0) {
        // Free object
        const key = `${objNum}_${field3}`;
        if (!entries.has(key)) {
          entries.set(key, {
            objNum,
            genNum: field3,
            offset: field2, // next free object number
            type: 'f',
          });
        }
      } else if (type === 1) {
        // Uncompressed object
        const key = `${objNum}_${field3}`;
        if (!entries.has(key)) {
          entries.set(key, {
            objNum,
            genNum: field3,
            offset: field2, // byte offset
            type: 'n',
          });
        }
      } else if (type === 2) {
        // Compressed object (in an Object Stream)
        const key = `${objNum}_0`;
        if (!entries.has(key)) {
          entries.set(key, {
            objNum,
            genNum: 0,
            offset: 0,
            type: 'n',
            compressedObjNum: field2,  // object number of the ObjStm
            compressedIndex: field3,    // index within the ObjStm
          });
        }
      }
    }
  }

  // The stream dict IS the trailer dict for xref streams
  return { entries, trailerDict: dict };
}

/**
 * Read a big-endian integer from a byte array.
 */
function readIntFromBytes(data: Uint8Array, offset: number, width: number): number {
  let value = 0;
  for (let i = 0; i < width; i++) {
    value = (value << 8) | (data[offset + i] ?? 0);
  }
  return value;
}

// ─── Full xref resolution (follows /Prev chain) ────────────────────────────

/**
 * Build the complete cross-reference table by following the /Prev chain
 * through all incremental updates.
 *
 * Returns the merged xref and the most recent trailer dictionary.
 */
export async function buildFullXref(data: Uint8Array): Promise<XRefTable> {
  const startxref = findStartXref(data);
  const mergedEntries = new Map<string, XRefEntry>();
  let mainTrailer: PDFDict | null = null;

  let currentOffset: number | null = startxref;
  const visited = new Set<number>(); // Prevent infinite loops

  while (currentOffset !== null && !visited.has(currentOffset)) {
    visited.add(currentOffset);

    let xrefSection: XRefTable;

    // Determine if this is a traditional xref table or an xref stream
    const isTable = isTraditionalXref(data, currentOffset);

    if (isTable) {
      xrefSection = parseXrefTable(data, currentOffset);
    } else {
      xrefSection = await parseXrefStream(data, currentOffset);
    }

    // Merge entries (entries from later updates take precedence — 
    // since we process most recent first, only add if not already present)
    Array.from(xrefSection.entries.entries()).forEach(([key, entry]) => {
      if (!mergedEntries.has(key)) {
        mergedEntries.set(key, entry);
      }
    });

    // Keep the first (most recent) trailer as the main trailer
    if (!mainTrailer) {
      mainTrailer = xrefSection.trailerDict;
    }

    // Follow /Prev pointer to previous xref section
    const prev = xrefSection.trailerDict.getNumber('Prev');
    currentOffset = prev ?? null;
  }

  if (!mainTrailer) {
    throw new Error('No trailer dictionary found');
  }

  return { entries: mergedEntries, trailerDict: mainTrailer };
}

// ─── Recovery for damaged files ─────────────────────────────────────────────

const TRAILER_KEYS = ['Root', 'Info', 'ID', 'Encrypt'] as const;

function bytesToLatin1(data: Uint8Array): string {
  let out = '';
  for (let i = 0; i < data.length; i += 0x8000) {
    out += String.fromCharCode.apply(null, Array.from(data.subarray(i, i + 0x8000)));
  }
  return out;
}

/** Parses "N G obj <<...>> [stream]" at `offset`; null if it isn't one. */
function readObjectAt(data: Uint8Array, offset: number): PDFObject | null {
  try {
    const lexer = new PDFLexer(data, offset);
    lexer.nextToken();
    lexer.nextToken();
    const kw = lexer.nextToken();
    if (!kw || kw.value !== 'obj') return null;
    return parseStreamObject(lexer, data);
  } catch {
    return null;
  }
}

/**
 * Rebuild the cross-reference table of a damaged file (missing or misspelled
 * startxref, corrupt xref table, wrong offsets) by scanning for "N G obj"
 * headers, as other readers do. A later definition of an object wins. Objects
 * inside object streams are indexed too. The trailer is the last `trailer`
 * dictionary with a /Root, else a cross-reference stream's dictionary, else
 * one pointing /Root at the scanned /Catalog (or with no /Root when the
 * catalog sits in an object stream; parsePDF then finds it).
 */
export async function reconstructXref(data: Uint8Array): Promise<XRefTable> {
  const text = bytesToLatin1(data);
  const entries = new Map<string, XRefEntry>();
  const keyByNum = new Map<number, string>();
  const objHeader = /(\d{1,10})[ \t\r\n\f\0]+(\d{1,5})[ \t\r\n\f\0]+obj\b/g;
  for (let m = objHeader.exec(text); m; m = objHeader.exec(text)) {
    const before = m.index > 0 ? text.charCodeAt(m.index - 1) : 0x0a;
    if (before >= 0x30 && before <= 0x39) continue; // inside a longer number
    const objNum = parseInt(m[1], 10);
    const genNum = parseInt(m[2], 10);
    const key = `${objNum}_${genNum}`;
    // Drop an earlier definition of the same object number with another generation.
    const prev = keyByNum.get(objNum);
    if (prev && prev !== key) entries.delete(prev);
    keyByNum.set(objNum, key);
    entries.set(key, { objNum, genNum, offset: m.index, type: 'n' });
  }
  if (entries.size === 0) throw new Error('No PDF objects found — file may be corrupted or not a PDF');

  let trailer: PDFDict | null = null;
  for (let pos = text.lastIndexOf('trailer'); pos !== -1 && !trailer; pos = text.lastIndexOf('trailer', pos - 1)) {
    try {
      const lexer = new PDFLexer(data, pos + 'trailer'.length);
      const dict = parseObject(lexer);
      if (dict instanceof PDFDict && dict.get('Root') instanceof PDFRef) trailer = dict;
    } catch {
      // keep looking
    }
    if (pos === 0) break;
  }

  let catalogRef: PDFRef | null = null;
  const direct = Array.from(entries.values());
  for (const entry of direct) {
    const obj = readObjectAt(data, entry.offset);
    const dict = obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : null;
    if (!dict) continue;
    const type = dict.getName('Type');
    if (type === 'Catalog') catalogRef = new PDFRef(entry.objNum, entry.genNum);
    if (!trailer && type === 'XRef' && dict.get('Root') instanceof PDFRef) {
      trailer = new PDFDict();
      for (const k of TRAILER_KEYS) {
        const v = dict.get(k);
        if (v) trailer.set(k, v);
      }
    }
    if (type === 'ObjStm' && obj instanceof PDFStream) {
      try {
        const filters = obj.getFilters();
        const body = filters.length > 0 ? await applyFilters(obj.rawBytes, filters, obj.getDecodeParams()) : obj.rawBytes;
        const header = new PDFLexer(body, 0);
        const n = dict.getNumber('N') ?? 0;
        for (let i = 0; i < n; i++) {
          const num = header.nextToken();
          const off = header.nextToken();
          if (num?.type !== TokenType.Integer || off?.type !== TokenType.Integer) break;
          const key = `${num.value as number}_0`;
          // An object written directly in the file supersedes the packed copy.
          if (entries.has(key)) continue;
          entries.set(key, {
            objNum: num.value as number,
            genNum: 0,
            offset: 0,
            type: 'n',
            compressedObjNum: entry.objNum,
            compressedIndex: i,
          });
        }
      } catch {
        // An unreadable object stream only loses the objects inside it.
      }
    }
  }

  if (!trailer || !entries.has((trailer.get('Root') as PDFRef).toKey())) {
    // Without a usable /Root here, the parser looks for the catalog among all
    // objects, including those packed in object streams.
    const rebuilt = new PDFDict();
    if (trailer) for (const k of TRAILER_KEYS) {
      const v = trailer.get(k);
      if (v && k !== 'Root') rebuilt.set(k, v);
    }
    if (catalogRef) rebuilt.set('Root', catalogRef);
    trailer = rebuilt;
  }
  return { entries, trailerDict: trailer };
}

/**
 * Check if the data at the given offset starts a traditional xref table
 * (starts with "xref" keyword) vs an xref stream (starts with object definition).
 */
export function isTraditionalXref(data: Uint8Array, offset: number): boolean {
  // Skip whitespace
  let pos = offset;
  while (pos < data.length && (data[pos] === 0x20 || data[pos] === 0x0a || data[pos] === 0x0d || data[pos] === 0x09)) {
    pos++;
  }

  // Check if it starts with "xref"
  return (
    pos + 3 < data.length &&
    data[pos] === 0x78 &&     // x
    data[pos + 1] === 0x72 && // r
    data[pos + 2] === 0x65 && // e
    data[pos + 3] === 0x66    // f
  );
}

// ─── Object parsing helpers (used by xref stream parsing) ───────────────────

/**
 * Parse a single PDF object from the lexer's current position.
 * This is a simplified version used for trailer/xref parsing.
 * The full parser in parser.ts uses this same logic but with reference resolution.
 */
export function parseObject(lexer: PDFLexer): PDFObject {
  lexer.skipWhitespaceAndComments();
  const token = lexer.nextToken();
  if (!token) throw new Error('Unexpected end of data while parsing object');

  switch (token.type) {
    case TokenType.Boolean:
      return new PDFBoolean(token.value as boolean);

    case TokenType.Integer:
    case TokenType.Real:
      // Could be start of an indirect reference: num gen R
      if (token.type === TokenType.Integer) {
        const savedPos = lexer.position;
        const nextTok = lexer.nextToken();
        if (nextTok && nextTok.type === TokenType.Integer) {
          const rTok = lexer.nextToken();
          if (rTok && rTok.value === 'R') {
            return new PDFRef(token.value as number, nextTok.value as number);
          }
        }
        // Not a reference — restore position
        lexer.position = savedPos;
      }
      return new PDFNumber(token.value as number);

    case TokenType.String:
      return new PDFString(token.value as string);

    case TokenType.HexString:
      return new PDFHexString(token.value as string);

    case TokenType.Name:
      return new PDFName(token.value as string);

    case TokenType.Null:
      return PDFNull.instance;

    case TokenType.Keyword: {
      const kw = token.value as string;

      if (kw === '<<') {
        // Dictionary
        return parseDictionary(lexer);
      }

      if (kw === '[') {
        // Array
        return parseArray(lexer);
      }

      // Unexpected keyword — return as null
      return PDFNull.instance;
    }

    default:
      return PDFNull.instance;
  }
}

function parseDictionary(lexer: PDFLexer): PDFDict {
  const dict = new PDFDict();

  while (true) {
    lexer.skipWhitespaceAndComments();
    if (lexer.isEOF) break;

    // Check for >>
    const savedPos = lexer.position;
    const token = lexer.nextToken();
    if (!token) break;
    if (token.type === TokenType.Keyword && token.value === '>>') break;

    // Key must be a Name
    if (token.type !== TokenType.Name) {
      // Try to recover — skip this entry
      continue;
    }
    const key = token.value as string;

    // Value
    const value = parseObject(lexer);
    dict.set(key, value);
  }

  return dict;
}

function parseArray(lexer: PDFLexer): PDFArray {
  const items: PDFObject[] = [];

  while (true) {
    lexer.skipWhitespaceAndComments();
    if (lexer.isEOF) break;

    // Check for ]
    const savedPos = lexer.position;
    const token = lexer.nextToken();
    if (!token) break;
    if (token.type === TokenType.Keyword && token.value === ']') break;

    // Push back and parse as object
    lexer.position = savedPos;
    items.push(parseObject(lexer));
  }

  return new PDFArray(items);
}

/**
 * Parse a stream object (dictionary followed by stream data).
 * The lexer should be positioned just after reading the opening '<<' and
 * the full dictionary has been consumed.
 */
function parseStreamObject(lexer: PDFLexer, fileData: Uint8Array): PDFObject {
  // Parse the dictionary first
  const obj = parseObject(lexer);
  if (!(obj instanceof PDFDict)) return obj;

  // Check for 'stream' keyword
  lexer.skipWhitespaceAndComments();
  const savedPos = lexer.position;
  const tok = lexer.nextToken();

  if (!tok || tok.value !== 'stream') {
    lexer.position = savedPos;
    return obj;
  }

  // Skip EOL after 'stream'
  lexer.skipStreamEOL();

  // Read stream data
  const length = obj.getNumber('Length') ?? 0;
  let streamBytes: Uint8Array;

  if (length > 0 && lexer.position + length <= fileData.length) {
    streamBytes = fileData.slice(lexer.position, lexer.position + length);
    lexer.position += length;
  } else {
    // Length might be wrong or an indirect reference — search for 'endstream'
    const endPos = lexer.searchForward('endstream');
    if (endPos !== -1) {
      // Trim trailing whitespace before 'endstream'
      let end = endPos;
      while (end > lexer.position && (fileData[end - 1] === 0x0a || fileData[end - 1] === 0x0d)) {
        end--;
      }
      streamBytes = fileData.slice(lexer.position, end);
      lexer.position = endPos;
    } else {
      streamBytes = new Uint8Array(0);
    }
  }

  // Skip 'endstream'
  lexer.skipWhitespaceAndComments();
  const endTok = lexer.nextToken();
  // endTok should be 'endstream' — we don't strictly enforce

  return new PDFStream(obj, streamBytes);
}
