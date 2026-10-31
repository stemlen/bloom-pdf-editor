/**
 * PDF Document Serializer
 *
 * Writes a complete PDF document from the in-memory object graph back
 * to valid binary output. Supports both full serialization and
 * incremental updates.
 *
 * Output format:
 *   %PDF-1.7
 *   %âãÏÓ  (binary marker)
 *   <objects>
 *   xref
 *   <cross-reference table>
 *   trailer
 *   << /Size N /Root ref /Info ref >>
 *   startxref
 *   <offset>
 *   %%EOF
 */

import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFStream,
  type PDFDocumentData,
} from '../types';
import { serializeIndirectObject } from '../editor/stream-compiler';
import { concatBytes } from '../editor/stream-compiler';
import { packIntoObjectStreams, buildXRefStream } from '../optimize/object-streams';

// ─── Full document serialization ────────────────────────────────────────────

/**
 * Serialize a complete PDF document to bytes.
 * This writes every object — use for "Save As" or export operations.
 */
export async function serializeDocument(doc: PDFDocumentData): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const offsets = new Map<string, number>(); // key → byte offset

  // 1. Write header
  const header = stringToBytes(`%PDF-${doc.version}\n%\xe2\xe3\xcf\xd3\n`);
  chunks.push(header);
  let currentOffset = header.length;

  // 2. Collect all objects to write
  const objectEntries = Array.from(doc.objects.entries());

  // Assign sequential object numbers
  const objNumMap = new Map<string, { objNum: number; genNum: number }>();
  let nextObjNum = 1;

  for (let i = 0; i < objectEntries.length; i++) {
    const [key] = objectEntries[i];
    const parts = key.split('_');
    const objNum = parseInt(parts[0], 10);
    const genNum = parseInt(parts[1], 10);
    objNumMap.set(key, { objNum, genNum });
    if (objNum >= nextObjNum) nextObjNum = objNum + 1;
  }

  // 3. Write all objects
  for (let i = 0; i < objectEntries.length; i++) {
    const [key, obj] = objectEntries[i];
    const nums = objNumMap.get(key)!;

    // Record offset for xref
    offsets.set(key, currentOffset);

    // Serialize the object
    const objBytes = serializeIndirectObject(nums.objNum, nums.genNum, obj);
    chunks.push(objBytes);
    currentOffset += objBytes.length;
  }

  // 4. Write cross-reference table
  const xrefOffset = currentOffset;
  const xrefBytes = buildXrefTable(objectEntries, offsets, objNumMap);
  chunks.push(xrefBytes);
  currentOffset += xrefBytes.length;

  // 5. Write trailer (preserve Encrypt + ID for secured documents)
  const catalogRef = doc.xref.trailerDict.getRef('Root');
  const infoRef = doc.xref.trailerDict.get('Info');
  const encryptRef = doc.xref.trailerDict.get('Encrypt');
  const idArr = doc.xref.trailerDict.get('ID');

  const trailerDict = new PDFDict();
  trailerDict.set('Size', new PDFNumber(nextObjNum));
  if (catalogRef) trailerDict.set('Root', catalogRef);
  if (infoRef) trailerDict.set('Info', infoRef as PDFObject);
  if (encryptRef) trailerDict.set('Encrypt', encryptRef as PDFObject);
  if (idArr) trailerDict.set('ID', idArr as PDFObject);

  const trailerBytes = stringToBytes(
    `trailer\n${trailerDictToString(trailerDict)}\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`,
  );
  chunks.push(trailerBytes);

  return concatBytes(...chunks);
}

// ─── Compact serialization (ObjStm + XRef stream) ──────────────────────────

/**
 * Serialize a PDF document using Object Streams and a cross-reference stream
 * for maximum compression. Requires PDF 1.5+.
 *
 * Falls back to standard serialization on failure.
 */
export async function serializeDocumentCompact(doc: PDFDocumentData): Promise<Uint8Array> {
  // Strings and streams of an encrypted document are already ciphertext, and
  // packing them into an unencrypted ObjStm would make the file unreadable.
  if (doc.xref.trailerDict.has('Encrypt')) return serializeDocument(doc);
  try {
    return await _serializeCompact(doc);
  } catch (err) {
    console.warn('[Serializer] Compact serialization failed, falling back to standard:', err);
    return serializeDocument(doc);
  }
}

async function _serializeCompact(doc: PDFDocumentData): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];

  // Bump version to 1.5 if needed (ObjStm requires 1.5+)
  const version = parseFloat(doc.version) >= 1.5 ? doc.version : '1.5';
  const header = stringToBytes(`%PDF-${version}\n%\xe2\xe3\xcf\xd3\n`);
  chunks.push(header);
  let currentOffset = header.length;

  // Find the max existing object number
  let nextObjNum = 1;
  for (const key of doc.objects.keys()) {
    const objNum = parseInt(key.split('_')[0], 10);
    if (objNum >= nextObjNum) nextObjNum = objNum + 1;
  }

  const catalogRef = doc.xref.trailerDict.getRef('Root');
  const encryptRef = doc.xref.trailerDict.getRef('Encrypt');

  // Pack objects into ObjStm containers
  const pack = await packIntoObjectStreams(
    doc.objects,
    nextObjNum,
    catalogRef,
    encryptRef,
  );

  // Track offsets for standalone objects
  const standaloneOffsets = new Map<number, { offset: number; genNum: number }>();

  // Write standalone objects
  for (const [, entry] of pack.standaloneObjects) {
    standaloneOffsets.set(entry.objNum, { offset: currentOffset, genNum: entry.genNum });
    const objBytes = serializeIndirectObject(entry.objNum, entry.genNum, entry.obj);
    chunks.push(objBytes);
    currentOffset += objBytes.length;
  }

  // Write ObjStm containers
  for (const objStm of pack.objStreams) {
    standaloneOffsets.set(objStm.objNum, { offset: currentOffset, genNum: 0 });
    const objBytes = serializeIndirectObject(objStm.objNum, 0, objStm.stream);
    chunks.push(objBytes);
    currentOffset += objBytes.length;
  }

  // Find max object number across all objects (standalone + ObjStm)
  let maxObjNum = 0;
  for (const [objNum] of standaloneOffsets) {
    if (objNum > maxObjNum) maxObjNum = objNum;
  }
  for (const [objNum] of pack.packMap) {
    if (objNum > maxObjNum) maxObjNum = objNum;
  }

  // XRef stream gets the next object number
  const xrefObjNum = maxObjNum + 1;

  // Build and write xref stream
  const xrefStreamOffset = currentOffset;
  const infoRef = doc.xref.trailerDict.get('Info');
  const idArr = doc.xref.trailerDict.get('ID');

  const xrefResult = await buildXRefStream(
    standaloneOffsets,
    pack.packMap,
    xrefObjNum + 1, // Size includes the xref stream itself
    xrefObjNum,
    {
      root: catalogRef,
      info: infoRef,
      encrypt: encryptRef ?? undefined,
      id: idArr ?? undefined,
      size: xrefObjNum + 1,
    },
  );

  chunks.push(xrefResult.bytes);
  currentOffset += xrefResult.bytes.length;

  // Write startxref and %%EOF
  const footer = stringToBytes(`startxref\n${xrefStreamOffset}\n%%EOF\n`);
  chunks.push(footer);

  return concatBytes(...chunks);
}

// ─── Cross-reference table building ─────────────────────────────────────────

function buildXrefTable(
  entries: [string, PDFObject][],
  offsets: Map<string, number>,
  objNumMap: Map<string, { objNum: number; genNum: number }>,
): Uint8Array {
  // Find max object number
  let maxObjNum = 0;
  for (let i = 0; i < entries.length; i++) {
    const nums = objNumMap.get(entries[i][0])!;
    if (nums.objNum > maxObjNum) maxObjNum = nums.objNum;
  }

  // Build offset lookup by object number
  const byObjNum = new Map<number, { offset: number; genNum: number }>();
  for (let i = 0; i < entries.length; i++) {
    const key = entries[i][0];
    const nums = objNumMap.get(key)!;
    const offset = offsets.get(key) ?? 0;
    byObjNum.set(nums.objNum, { offset, genNum: nums.genNum });
  }

  // Build xref table
  const lines: string[] = [];
  lines.push('xref');
  lines.push(`0 ${maxObjNum + 1}`);

  // Entry 0: free list head
  lines.push('0000000000 65535 f ');

  // Entries 1 to maxObjNum
  for (let n = 1; n <= maxObjNum; n++) {
    const entry = byObjNum.get(n);
    if (entry) {
      const offsetStr = entry.offset.toString().padStart(10, '0');
      const genStr = entry.genNum.toString().padStart(5, '0');
      lines.push(`${offsetStr} ${genStr} n `);
    } else {
      // Free entry
      lines.push('0000000000 00000 f ');
    }
  }

  return stringToBytes(lines.join('\n') + '\n');
}

function trailerDictToString(dict: PDFDict): string {
  const entries: string[] = [];
  const dictEntries = Array.from(dict.entries());
  for (let i = 0; i < dictEntries.length; i++) {
    const [key, value] = dictEntries[i];
    entries.push(`/${key} ${pdfObjectToString(value)}`);
  }
  return `<< ${entries.join(' ')} >>`;
}

function pdfObjectToString(obj: PDFObject): string {
  if (obj instanceof PDFNumber) return obj.toString();
  if (obj instanceof PDFName) return obj.toString();
  if (obj instanceof PDFRef) return obj.toString();
  if (obj instanceof PDFArray) {
    const items = [];
    for (let i = 0; i < obj.length; i++) {
      items.push(pdfObjectToString(obj.get(i)!));
    }
    return `[${items.join(' ')}]`;
  }
  if (obj instanceof PDFDict) return trailerDictToString(obj);
  return obj.toString();
}

// ─── Utility ────────────────────────────────────────────────────────────────

function stringToBytes(str: string): Uint8Array {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    bytes[i] = str.charCodeAt(i) & 0xff;
  }
  return bytes;
}

/**
 * Get the next available object number in the document.
 */
export function getNextObjNum(doc: PDFDocumentData): number {
  let max = 0;
  const entries = Array.from(doc.objects.keys());
  for (let i = 0; i < entries.length; i++) {
    const objNum = parseInt(entries[i].split('_')[0], 10);
    if (objNum > max) max = objNum;
  }
  return max + 1;
}
