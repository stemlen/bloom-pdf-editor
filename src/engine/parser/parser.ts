/**
 * PDF Document Parser
 *
 * The top-level parser that:
 *   1. Reads the PDF header (version)
 *   2. Builds the cross-reference table (via xref.ts)
 *   3. Reads all indirect objects from the file
 *   4. Resolves indirect references
 *   5. Decodes streams (via filters.ts)
 *   6. Traverses the page tree to build a flat page list
 *   7. Returns a complete PDFDocumentData structure
 *
 * This is the entry point for loading any PDF file.
 */

import { PDFLexer, TokenType } from './lexer';
import { buildFullXref, parseObject as parseObjectFromXref, reconstructXref } from './xref';
import { applyFilters } from './filters';
import {
  PDFArray,
  PDFBoolean,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFDocumentData,
  type PDFDocumentInfo,
  type PDFPageInfo,
  type PDFRectangle,
  type XRefEntry,
  type XRefTable,
} from '../types';

// ─── Main parse function ────────────────────────────────────────────────────

export interface ParsePDFOptions {
  /**
   * When the PDF is encrypted, skip stream filter decoding until
   * SecurityEngine.open() decrypts the document. Default: true.
   */
  deferEncryptedFilters?: boolean;
}

/**
 * Parse a PDF file from raw bytes into a fully-resolved document structure.
 *
 * Encrypted documents are parsed structurally; call `securityEngine.open(doc, password)`
 * to authenticate and decrypt strings/streams before rendering or editing.
 *
 * @param data Raw PDF file bytes
 * @returns Parsed document with resolved objects, page tree, and metadata
 */
export async function parsePDF(
  data: Uint8Array,
  options: ParsePDFOptions = {},
): Promise<PDFDocumentData> {
  let parsed: PDFDocumentData | null = null;
  let failure: unknown = null;
  try {
    parsed = await parseWithXref(data, await buildFullXref(data), options);
    if (parsed.pages.length > 0) return parsed;
  } catch (e) {
    failure = e;
  }
  // Damaged cross-reference data (bad startxref, corrupt table, shifted
  // offsets): rebuild it by scanning the file for objects, as other readers do.
  try {
    const recovered = await parseWithXref(data, await reconstructXref(data), options, true);
    if (recovered.pages.length > 0) {
      console.warn('[PDF Parser] Cross-reference data was damaged; rebuilt it by scanning the file.', failure ?? '');
      return recovered;
    }
  } catch {
    // Not recoverable — report the original problem.
  }
  if (parsed) return parsed;
  throw failure;
}

async function parseWithXref(
  data: Uint8Array,
  xref: XRefTable,
  options: ParsePDFOptions,
  recovering = false,
): Promise<PDFDocumentData> {
  // 1. Read header
  const version = readHeader(data);

  // 2. Cross-reference table: built by the caller
  const encrypted = xref.trailerDict.has('Encrypt');
  const deferFilters = options.deferEncryptedFilters !== false && encrypted;

  // 3. Read all indirect objects (skip filter decode when encrypted)
  const objects = await readAllObjects(data, xref, { skipFilters: deferFilters });

  // 4. Create resolver function
  const resolve = (obj: PDFObject): PDFObject => resolveRef(obj, objects);

  // 5. Find catalog (root) dictionary
  if (recovering && !(xref.trailerDict.getRef('Root') && resolve(xref.trailerDict.getRef('Root')!) instanceof PDFDict)) {
    for (const [key, obj] of objects) {
      if (obj instanceof PDFDict && obj.getName('Type') === 'Catalog') {
        const [num, gen] = key.split('_').map(Number);
        xref.trailerDict.set('Root', new PDFRef(num, gen));
        break;
      }
    }
  }
  const catalogRef = xref.trailerDict.getRef('Root');
  if (!catalogRef) throw new Error('Trailer missing /Root entry');
  const catalog = resolve(catalogRef);
  if (!(catalog instanceof PDFDict)) throw new Error('/Root is not a dictionary');

  // 6. Build page tree
  const pages = buildPageTree(catalog, objects, resolve);

  // 7. Extract document info (may contain encrypted strings — leave as-is)
  const info = extractDocInfo(xref.trailerDict, resolve);

  return {
    version,
    objects,
    xref,
    catalog,
    pages,
    info,
    rawBytes: data,
  };
}

// ─── Header parsing ─────────────────────────────────────────────────────────

function readHeader(data: Uint8Array): string {
  const lexer = new PDFLexer(data);
  const line = lexer.readLine();

  // Expected format: %PDF-1.7 or %PDF-2.0
  const match = line.match(/%PDF-(\d+\.\d+)/);
  if (match) return match[1];

  // Some PDFs have junk before the header — search for %PDF-
  const headerPos = lexer.searchForward('%PDF-', 0);
  if (headerPos !== -1) {
    lexer.position = headerPos;
    const headerLine = lexer.readLine();
    const m = headerLine.match(/%PDF-(\d+\.\d+)/);
    if (m) return m[1];
  }

  // Default to 1.4 if we can't find a version
  return '1.4';
}

// ─── Object reading ─────────────────────────────────────────────────────────

/**
 * Read all indirect objects referenced in the xref table.
 * Returns a Map keyed by "objNum_genNum".
 */
async function readAllObjects(
  data: Uint8Array,
  xref: XRefTable,
  opts: { skipFilters?: boolean } = {},
): Promise<Map<string, PDFObject>> {
  const objects = new Map<string, PDFObject>();

  const xrefEntries = Array.from(xref.entries.entries());

  // First pass: read all uncompressed objects
  for (let ei = 0; ei < xrefEntries.length; ei++) {
    const [key, entry] = xrefEntries[ei];
    if (entry.type === 'f') continue; // Skip free entries
    if (entry.compressedObjNum !== undefined) continue; // Handle compressed objects later

    try {
      const obj = readIndirectObject(data, entry.offset);
      if (obj) {
        objects.set(key, obj);

        // If it's a stream, decode it (unless encrypted — decrypt first)
        if (obj instanceof PDFStream && !opts.skipFilters) {
          await decodeStream(obj, objects);
        }
      }
    } catch (e) {
      // Object might be corrupted — skip it
      console.warn(`[PDF Parser] Failed to read object ${key} at offset ${entry.offset}:`, e);
    }
  }

  // Second pass: read compressed objects from Object Streams
  for (let ei = 0; ei < xrefEntries.length; ei++) {
    const [key, entry] = xrefEntries[ei];
    if (entry.type === 'f') continue;
    if (entry.compressedObjNum === undefined) continue;

    try {
      const obj = await readCompressedObject(
        entry,
        objects,
        data,
        xref,
      );
      if (obj) {
        objects.set(key, obj);
      }
    } catch (e) {
      console.warn(`[PDF Parser] Failed to read compressed object ${key}:`, e);
    }
  }

  return objects;
}

/**
 * Read a single indirect object at the given byte offset.
 * Format: objNum genNum obj <value> endobj
 */
function readIndirectObject(data: Uint8Array, offset: number): PDFObject | null {
  if (offset >= data.length || offset < 0) return null;

  const lexer = new PDFLexer(data, offset);

  // Read: objNum genNum obj
  const objNumTok = lexer.nextToken();
  if (!objNumTok || objNumTok.type !== TokenType.Integer) return null;

  const genNumTok = lexer.nextToken();
  if (!genNumTok || genNumTok.type !== TokenType.Integer) return null;

  const objKeyword = lexer.nextToken();
  if (!objKeyword || objKeyword.value !== 'obj') return null;

  // Parse the object value
  const value = parseFullObject(lexer, data);

  // Read endobj (optional — some generators omit it)
  lexer.skipWhitespaceAndComments();
  const endTok = lexer.nextToken();
  // We don't strictly require 'endobj'

  return value;
}

/**
 * Parse a PDF object, handling the possibility that a dictionary
 * might be followed by a stream.
 */
function parseFullObject(lexer: PDFLexer, fileData: Uint8Array): PDFObject {
  lexer.skipWhitespaceAndComments();

  const token = lexer.nextToken();
  if (!token) return PDFNull.instance;

  switch (token.type) {
    case TokenType.Boolean:
      return new PDFBoolean(token.value as boolean);

    case TokenType.Integer:
    case TokenType.Real: {
      // Check for indirect reference: num gen R
      if (token.type === TokenType.Integer) {
        const savedPos = lexer.position;
        const nextTok = lexer.nextToken();
        if (nextTok && nextTok.type === TokenType.Integer) {
          const rTok = lexer.nextToken();
          if (rTok && rTok.value === 'R') {
            return new PDFRef(token.value as number, nextTok.value as number);
          }
        }
        lexer.position = savedPos;
      }
      return new PDFNumber(token.value as number);
    }

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
        // Dictionary — might be followed by stream
        const dict = parseDictBody(lexer, fileData);

        // Check if stream follows
        lexer.skipWhitespaceAndComments();
        const savedPos = lexer.position;
        const streamTok = lexer.nextToken();

        if (streamTok && streamTok.value === 'stream') {
          lexer.skipStreamEOL();
          return readStreamData(lexer, dict, fileData);
        }

        // Not a stream — restore position
        lexer.position = savedPos;
        return dict;
      }

      if (kw === '[') {
        return parseArrayBody(lexer, fileData);
      }

      // 'endobj', 'endstream', etc. — return null
      return PDFNull.instance;
    }

    default:
      return PDFNull.instance;
  }
}

/**
 * Parse dictionary entries (after '<<' has been consumed).
 */
function parseDictBody(lexer: PDFLexer, fileData: Uint8Array): PDFDict {
  const dict = new PDFDict();

  while (true) {
    lexer.skipWhitespaceAndComments();
    if (lexer.isEOF) break;

    const savedPos = lexer.position;
    const token = lexer.nextToken();
    if (!token) break;

    // End of dictionary
    if (token.type === TokenType.Keyword && token.value === '>>') break;

    // Key must be a Name
    if (token.type !== TokenType.Name) {
      // Recovery: if we hit something unexpected, try to skip
      continue;
    }

    const key = token.value as string;
    const value = parseFullObject(lexer, fileData);
    dict.set(key, value);
  }

  return dict;
}

/**
 * Parse array body (after '[' has been consumed).
 */
function parseArrayBody(lexer: PDFLexer, fileData: Uint8Array): PDFArray {
  const items: PDFObject[] = [];

  while (true) {
    lexer.skipWhitespaceAndComments();
    if (lexer.isEOF) break;

    const savedPos = lexer.position;
    const token = lexer.nextToken();
    if (!token) break;

    // End of array
    if (token.type === TokenType.Keyword && token.value === ']') break;

    // Push token back and parse as full object
    lexer.position = savedPos;
    items.push(parseFullObject(lexer, fileData));
  }

  return new PDFArray(items);
}

/**
 * Read stream data after 'stream' keyword + EOL has been consumed.
 */
function readStreamData(
  lexer: PDFLexer,
  dict: PDFDict,
  fileData: Uint8Array,
): PDFStream {
  const streamStart = lexer.position;

  // Try to use /Length from dictionary
  const lengthVal = dict.get('Length');
  let length = -1;

  if (lengthVal instanceof PDFNumber) {
    length = lengthVal.value;
  }

  let streamBytes: Uint8Array;

  if (length >= 0 && streamStart + length <= fileData.length) {
    // Verify that 'endstream' follows at the expected position
    let endPos = streamStart + length;
    // Skip whitespace before 'endstream'
    while (endPos < fileData.length && (fileData[endPos] === 0x0a || fileData[endPos] === 0x0d || fileData[endPos] === 0x20)) {
      endPos++;
    }

    // Check if 'endstream' is there
    const check = String.fromCharCode(
      fileData[endPos] ?? 0,
      fileData[endPos + 1] ?? 0,
      fileData[endPos + 2] ?? 0,
      fileData[endPos + 3] ?? 0,
      fileData[endPos + 4] ?? 0,
      fileData[endPos + 5] ?? 0,
      fileData[endPos + 6] ?? 0,
      fileData[endPos + 7] ?? 0,
      fileData[endPos + 8] ?? 0,
    );

    if (check.startsWith('endstream')) {
      streamBytes = fileData.slice(streamStart, streamStart + length);
      lexer.position = endPos + 9; // past 'endstream'
    } else {
      // Length was wrong — fall back to searching for 'endstream'
      streamBytes = findStreamByEndMarker(lexer, fileData, streamStart);
    }
  } else {
    // No valid length — search for 'endstream'
    streamBytes = findStreamByEndMarker(lexer, fileData, streamStart);
  }

  return new PDFStream(dict, streamBytes);
}

/**
 * Find stream data by searching forward for 'endstream' marker.
 * Fallback for when /Length is missing, incorrect, or an unresolved reference.
 */
function findStreamByEndMarker(
  lexer: PDFLexer,
  fileData: Uint8Array,
  streamStart: number,
): Uint8Array {
  const endPos = lexer.searchForward('endstream', streamStart);
  if (endPos !== -1) {
    // Trim trailing EOL before 'endstream'
    let end = endPos;
    while (end > streamStart && (fileData[end - 1] === 0x0a || fileData[end - 1] === 0x0d)) {
      end--;
    }
    lexer.position = endPos + 9; // past 'endstream'
    return fileData.slice(streamStart, end);
  }

  // Last resort — take everything to end of file
  lexer.position = fileData.length;
  return fileData.slice(streamStart);
}

// ─── Stream decoding ────────────────────────────────────────────────────────

/**
 * Decode a stream's data by applying its filter chain.
 * Resolves indirect /Length references if needed.
 */
async function decodeStream(
  stream: PDFStream,
  objects: Map<string, PDFObject>,
): Promise<void> {
  // Resolve /Length if it's an indirect reference
  const lengthObj = stream.dict.get('Length');
  if (lengthObj instanceof PDFRef) {
    const resolved = objects.get(lengthObj.toKey());
    if (resolved instanceof PDFNumber) {
      stream.dict.set('Length', resolved);
    }
  }

  const filters = stream.getFilters();
  if (filters.length === 0) {
    stream.decodedBytes = stream.rawBytes;
    return;
  }

  // Resolve DecodeParms if they contain indirect references
  const params = stream.getDecodeParams();
  const resolvedParams: (PDFDict | null)[] = params.map((p) => {
    if (p instanceof PDFRef) {
      const resolved = objects.get((p as unknown as PDFRef).toKey());
      return resolved instanceof PDFDict ? resolved : null;
    }
    return p;
  });

  try {
    stream.decodedBytes = await applyFilters(stream.rawBytes, filters, resolvedParams);
  } catch (e) {
    console.warn('[PDF Parser] Failed to decode stream:', e);
    stream.decodedBytes = stream.rawBytes;
  }
}

// ─── Compressed object reading ──────────────────────────────────────────────

/**
 * Read an object that is stored inside an Object Stream (ObjStm).
 * Object streams are compressed containers that hold multiple objects.
 */
async function readCompressedObject(
  entry: XRefEntry,
  objects: Map<string, PDFObject>,
  data: Uint8Array,
  xref: XRefTable,
): Promise<PDFObject | null> {
  if (entry.compressedObjNum === undefined || entry.compressedIndex === undefined) {
    return null;
  }

  const objStmKey = `${entry.compressedObjNum}_0`;
  let objStm = objects.get(objStmKey);

  // If the object stream hasn't been read yet, read it now
  if (!objStm) {
    const stmEntry = xref.entries.get(objStmKey);
    if (!stmEntry || stmEntry.type === 'f') return null;

    const rawObj = readIndirectObject(data, stmEntry.offset);
    if (rawObj && rawObj instanceof PDFStream) {
      await decodeStream(rawObj, objects);
      objects.set(objStmKey, rawObj);
      objStm = rawObj;
    } else {
      return null;
    }
  }

  if (!(objStm instanceof PDFStream)) return null;

  const streamData = objStm.getBytes();
  const n = objStm.dict.getNumber('N') ?? 0; // Number of objects in the stream
  const first = objStm.dict.getNumber('First') ?? 0; // Byte offset of first object

  // Parse the object number / offset pairs at the beginning of the stream
  const headerLexer = new PDFLexer(streamData, 0);
  const objectOffsets: { objNum: number; offset: number }[] = [];

  for (let i = 0; i < n; i++) {
    const objNumTok = headerLexer.nextToken();
    const offsetTok = headerLexer.nextToken();
    if (!objNumTok || !offsetTok) break;
    objectOffsets.push({
      objNum: objNumTok.value as number,
      offset: (offsetTok.value as number) + first,
    });
  }

  // Find the target object
  const targetOffset = objectOffsets[entry.compressedIndex];
  if (!targetOffset) return null;

  // Determine the end of this object's data
  const nextOffset = entry.compressedIndex + 1 < objectOffsets.length
    ? objectOffsets[entry.compressedIndex + 1].offset
    : streamData.length;

  // Parse the object from the stream data
  const objData = streamData.slice(targetOffset.offset, nextOffset);
  const objLexer = new PDFLexer(objData, 0);

  // Objects in ObjStm are stored without 'obj'/'endobj' wrappers
  // Use the xref parser's parseObject since these are simple objects (no streams)
  return parseObjectFromXref(objLexer);
}

// ─── Reference resolution ───────────────────────────────────────────────────

/**
 * Resolve an indirect reference to its actual object.
 * If the input is not a PDFRef, return it unchanged.
 */
export function resolveRef(
  obj: PDFObject,
  objects: Map<string, PDFObject>,
): PDFObject {
  if (obj instanceof PDFRef) {
    const resolved = objects.get(obj.toKey());
    if (!resolved) return PDFNull.instance;
    // Recursively resolve (in case of chains of references)
    if (resolved instanceof PDFRef) return resolveRef(resolved, objects);
    return resolved;
  }
  return obj;
}

/**
 * Deep-resolve: resolve a PDFRef and also resolve refs inside dicts/arrays.
 * Use sparingly — most of the time you want shallow resolution.
 */
export function deepResolve(
  obj: PDFObject,
  objects: Map<string, PDFObject>,
  depth: number = 0,
): PDFObject {
  if (depth > 20) return obj; // Prevent infinite recursion

  const resolved = resolveRef(obj, objects);

  if (resolved instanceof PDFDict) {
    const newDict = new PDFDict();
    const entries = Array.from(resolved.entries());
    for (let i = 0; i < entries.length; i++) {
      const [key, value] = entries[i];
      newDict.set(key, deepResolve(value, objects, depth + 1));
    }
    return newDict;
  }

  if (resolved instanceof PDFArray) {
    return new PDFArray(
      resolved.items.map((item) => deepResolve(item, objects, depth + 1)),
    );
  }

  return resolved;
}

// ─── Page tree traversal ────────────────────────────────────────────────────

/**
 * Build a flat array of PDFPageInfo from the document catalog's /Pages tree.
 * The page tree is a tree of /Pages (intermediate) and /Page (leaf) nodes.
 */
function buildPageTree(
  catalog: PDFDict,
  objects: Map<string, PDFObject>,
  resolve: (obj: PDFObject) => PDFObject,
): PDFPageInfo[] {
  const pagesRef = catalog.getRef('Pages');
  if (!pagesRef) throw new Error('Catalog missing /Pages entry');

  const pagesObj = resolve(pagesRef);
  if (!(pagesObj instanceof PDFDict)) throw new Error('/Pages is not a dictionary');

  const pages: PDFPageInfo[] = [];
  collectPages(pagesObj, pagesRef, objects, resolve, pages, {});

  return pages;
}

/**
 * Recursively collect page dictionaries from the page tree.
 * Inherited properties (MediaBox, CropBox, Rotate, Resources) are propagated
 * from parent /Pages nodes to child /Page nodes.
 */
function collectPages(
  node: PDFDict,
  nodeRef: PDFRef,
  objects: Map<string, PDFObject>,
  resolve: (obj: PDFObject) => PDFObject,
  pages: PDFPageInfo[],
  inherited: Record<string, PDFObject>,
): void {
  const type = node.getName('Type');

  // Build inherited properties
  const currentInherited = { ...inherited };
  for (const key of ['MediaBox', 'CropBox', 'Rotate', 'Resources']) {
    const val = node.get(key);
    if (val !== undefined) {
      currentInherited[key] = resolve(val);
    }
  }

  if (type === 'Page') {
    // Leaf node — this is an actual page
    const pageIndex = pages.length;

    // MediaBox (required, but might be inherited)
    const mediaBoxObj = node.get('MediaBox')
      ? resolve(node.get('MediaBox')!)
      : currentInherited['MediaBox'];
    const mediaBox = parseRectangle(mediaBoxObj);

    // CropBox (defaults to MediaBox)
    const cropBoxObj = node.get('CropBox')
      ? resolve(node.get('CropBox')!)
      : currentInherited['CropBox'];
    const cropBox = cropBoxObj ? parseRectangle(cropBoxObj) : mediaBox;

    // Rotate
    const rotateObj = node.get('Rotate')
      ?? currentInherited['Rotate'];
    const rotate = rotateObj instanceof PDFNumber ? rotateObj.value : 0;

    // Resources
    const resourcesObj = node.get('Resources')
      ? resolve(node.get('Resources')!)
      : currentInherited['Resources'];
    const resources = resourcesObj instanceof PDFDict ? resourcesObj : new PDFDict();

    // Content streams
    const contentsObj = node.get('Contents');
    const contentRefs = extractContentRefs(contentsObj, resolve);

    pages.push({
      index: pageIndex,
      dict: node,
      mediaBox,
      cropBox,
      rotate,
      ref: nodeRef,
      resources,
      contentRefs,
    });
  } else if (type === 'Pages') {
    // Intermediate node — recurse into Kids
    const kidsObj = node.get('Kids');
    const kids = resolve(kidsObj ?? PDFNull.instance);

    if (kids instanceof PDFArray) {
      for (const kidRef of kids.items) {
        const resolvedKid = resolve(kidRef);
        if (resolvedKid instanceof PDFDict) {
          const ref = kidRef instanceof PDFRef ? kidRef : new PDFRef(0, 0);
          collectPages(resolvedKid, ref, objects, resolve, pages, currentInherited);
        }
      }
    }
  }
}

/**
 * Extract content stream references from a page's /Contents entry.
 * /Contents can be a single reference or an array of references.
 */
function extractContentRefs(
  contentsObj: PDFObject | undefined,
  resolve: (obj: PDFObject) => PDFObject,
): PDFRef[] {
  if (!contentsObj) return [];

  if (contentsObj instanceof PDFRef) return [contentsObj];

  const resolved = resolve(contentsObj);

  if (resolved instanceof PDFRef) return [resolved];

  if (resolved instanceof PDFArray) {
    return resolved.items
      .filter((item): item is PDFRef => item instanceof PDFRef);
  }

  // Direct stream (rare but possible)
  return [];
}

/**
 * Parse a PDF rectangle array [x1, y1, x2, y2] into a PDFRectangle.
 */
function parseRectangle(obj: PDFObject | undefined): PDFRectangle {
  if (!(obj instanceof PDFArray) || obj.length < 4) {
    // Default to US Letter size
    return { x: 0, y: 0, width: 612, height: 792 };
  }

  const nums = obj.asNumbers();
  const x1 = nums[0] ?? 0;
  const y1 = nums[1] ?? 0;
  const x2 = nums[2] ?? 612;
  const y2 = nums[3] ?? 792;

  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

// ─── Document info extraction ───────────────────────────────────────────────

function extractDocInfo(
  trailer: PDFDict,
  resolve: (obj: PDFObject) => PDFObject,
): PDFDocumentInfo {
  const infoRef = trailer.get('Info');
  if (!infoRef) return {};

  const infoObj = resolve(infoRef);
  if (!(infoObj instanceof PDFDict)) return {};

  return {
    title: infoObj.getString('Title'),
    author: infoObj.getString('Author'),
    subject: infoObj.getString('Subject'),
    keywords: infoObj.getString('Keywords'),
    creator: infoObj.getString('Creator'),
    producer: infoObj.getString('Producer'),
    creationDate: infoObj.getString('CreationDate'),
    modDate: infoObj.getString('ModDate'),
  };
}

// ─── Public utilities ───────────────────────────────────────────────────────

/**
 * Get the decoded bytes of a content stream for a page.
 * Handles both single and multiple content streams (concatenates them).
 */
export function getPageContentBytes(
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
): Uint8Array {
  const chunks: Uint8Array[] = [];

  for (const ref of page.contentRefs) {
    const obj = objects.get(ref.toKey());
    if (obj instanceof PDFStream) {
      const bytes = obj.getBytes();
      chunks.push(bytes);
      // Add a space between concatenated streams to prevent operator merging
      chunks.push(new Uint8Array([0x20])); // ' '
    }
  }

  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0];

  // Concatenate all chunks
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

/**
 * Resolve a resource by type and name.
 * E.g., getResource(page.resources, 'Font', 'F1', objects) → the Font dictionary
 */
export function getResource(
  resources: PDFDict,
  category: string,
  name: string,
  objects: Map<string, PDFObject>,
): PDFObject | undefined {
  const categoryObj = resources.get(category);
  if (!categoryObj) return undefined;

  const categoryDict = resolveRef(categoryObj, objects);
  if (!(categoryDict instanceof PDFDict)) return undefined;

  const resource = categoryDict.get(name);
  if (!resource) return undefined;

  return resolveRef(resource, objects);
}
