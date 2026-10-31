/**
 * Incremental PDF Writer
 *
 * Appends only modified/new objects to the end of an existing PDF file.
 * This preserves the original file contents and adds an incremental update:
 *
 *   [original PDF bytes]
 *   [new/modified objects]
 *   xref
 *   [incremental xref table — only modified entries]
 *   trailer
 *   << /Size N /Root ref /Prev <old_xref_offset> >>
 *   startxref
 *   <new_xref_offset>
 *   %%EOF
 *
 * Phase 6: OffsetManager + RevisionManager integration; multi-revision support.
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
import { serializeIndirectObject, concatBytes } from '../editor/stream-compiler';
import { findStartXref } from '../parser/xref';
import { OffsetManager, type ObjectKey } from './offset-manager';
import { RevisionManager, listRevisions } from './revision-manager';

export interface IncrementalWriteResult {
  /** Complete PDF bytes (original + this update). Never rewrites original prefix. */
  bytes: Uint8Array;
  /** Absolute offsets of objects written in this update. */
  writtenOffsets: Map<ObjectKey, number>;
  /** Byte offset of the new xref table. */
  xrefOffset: number;
  /** Previous xref offset stored in /Prev. */
  prevXrefOffset: number;
  /** Trailer /Size. */
  size: number;
  /** Length of the original prefix that was preserved. */
  originalLength: number;
}

export interface IncrementalWriteOptions {
  offsetManager?: OffsetManager;
  revisionManager?: RevisionManager;
}

// ─── Incremental save ───────────────────────────────────────────────────────

/**
 * Save a document incrementally — append only changed objects.
 * Never rewrites the original document bytes.
 */
export function saveIncremental(
  doc: PDFDocumentData,
  modifiedKeys: Set<string>,
  newObjects?: Map<string, PDFObject>,
  options?: IncrementalWriteOptions,
): Uint8Array {
  return appendIncrementalUpdate(doc, modifiedKeys, newObjects, options).bytes;
}

/**
 * Append an incremental update and return offset/revision metadata.
 */
export function appendIncrementalUpdate(
  doc: PDFDocumentData,
  modifiedKeys: Set<string>,
  newObjects?: Map<string, PDFObject>,
  options?: IncrementalWriteOptions,
): IncrementalWriteResult {
  const originalBytes = doc.rawBytes;
  if (!originalBytes || originalBytes.length === 0) {
    throw new Error('Incremental update requires doc.rawBytes (original PDF)');
  }

  const chunks: Uint8Array[] = [];
  let currentOffset = originalBytes.length;
  const originalLength = originalBytes.length;

  // Ensure the original ends cleanly (add newline if needed)
  if (originalBytes[originalBytes.length - 1] !== 0x0a) {
    chunks.push(stringToBytes('\n'));
    currentOffset += 1;
  }

  const newOffsets = new Map<ObjectKey, number>();

  // Write modified objects
  const modKeys = Array.from(modifiedKeys);
  for (let i = 0; i < modKeys.length; i++) {
    const key = modKeys[i];
    const obj = doc.objects.get(key);
    if (!obj) continue;

    const parts = key.split('_');
    const objNum = parseInt(parts[0], 10);
    const genNum = parseInt(parts[1], 10);

    newOffsets.set(key, currentOffset);
    const objBytes = serializeIndirectObject(objNum, genNum, obj);
    chunks.push(objBytes);
    currentOffset += objBytes.length;
  }

  // Write new objects (if any)
  if (newObjects) {
    const newEntries = Array.from(newObjects.entries());
    for (let i = 0; i < newEntries.length; i++) {
      const [key, obj] = newEntries[i];
      // Skip if already written as modified
      if (newOffsets.has(key)) continue;

      const parts = key.split('_');
      const objNum = parseInt(parts[0], 10);
      const genNum = parseInt(parts[1], 10);

      newOffsets.set(key, currentOffset);
      const objBytes = serializeIndirectObject(objNum, genNum, obj);
      chunks.push(objBytes);
      currentOffset += objBytes.length;

      doc.objects.set(key, obj);
    }
  }

  // Build incremental xref table
  const xrefOffset = currentOffset;
  const xrefBytes = buildIncrementalXref(newOffsets);
  chunks.push(xrefBytes);
  currentOffset += xrefBytes.length;

  // Build trailer
  let prevXrefOffset = 0;
  try {
    prevXrefOffset = findStartXref(originalBytes);
  } catch {
    prevXrefOffset = 0;
  }
  const size = getMaxObjNum(doc) + 1;

  const trailerDict = new PDFDict();
  trailerDict.set('Size', new PDFNumber(size));

  const root =
    doc.xref?.trailerDict?.getRef?.('Root') ??
    findCatalogRef(doc);
  if (root) trailerDict.set('Root', root);

  const info = doc.xref?.trailerDict?.get?.('Info');
  if (info) trailerDict.set('Info', info);

  trailerDict.set('Prev', new PDFNumber(prevXrefOffset));

  const trailerStr = trailerDictToString(trailerDict);
  const trailerBytes = stringToBytes(
    `trailer\n${trailerStr}\nstartxref\n${xrefOffset}\n%%EOF\n`,
  );
  chunks.push(trailerBytes);
  currentOffset += trailerBytes.length;

  const bytes = concatBytes(originalBytes, ...chunks);

  // Update managers
  const revIndex = (options?.revisionManager?.count ?? 0);
  options?.offsetManager?.recordBatch(newOffsets, revIndex, bytes.length);
  options?.revisionManager?.pushRevision({
    xrefOffset,
    prevOffset: prevXrefOffset,
    size,
    fileLength: bytes.length,
    root: root ?? null,
  });

  // Keep doc.rawBytes in sync for subsequent incremental appends
  doc.rawBytes = bytes;

  return {
    bytes,
    writtenOffsets: newOffsets,
    xrefOffset,
    prevXrefOffset,
    size,
    originalLength,
  };
}

/**
 * Session helper: tracks dirty keys and appends updates without rewriting history.
 */
export class IncrementalUpdateSession {
  readonly offsets: OffsetManager;
  readonly revisions: RevisionManager;
  private dirty = new Set<ObjectKey>();
  private created = new Map<ObjectKey, PDFObject>();

  constructor(private doc: PDFDocumentData) {
    this.offsets = new OffsetManager(doc.rawBytes?.length ?? 0);
    this.revisions = new RevisionManager(doc.rawBytes);
    if (doc.xref?.entries) {
      const seed: { key: string; offset: number; objNum: number; genNum: number }[] = [];
      for (const [key, entry] of doc.xref.entries) {
        seed.push({
          key,
          offset: entry.offset,
          objNum: entry.objNum,
          genNum: entry.genNum,
        });
      }
      this.offsets.seedFromXref(seed, 0);
    }
  }

  markModified(key: ObjectKey): void {
    this.dirty.add(key);
  }

  markModifiedRef(ref: PDFRef): void {
    this.dirty.add(ref.toKey());
  }

  addNewObject(ref: PDFRef, obj: PDFObject): void {
    const key = ref.toKey();
    this.doc.objects.set(key, obj);
    this.created.set(key, obj);
    this.dirty.add(key);
  }

  /** Append a revision containing all dirty objects since last commit. */
  commit(): IncrementalWriteResult {
    if (!this.doc.rawBytes?.length) {
      throw new Error('Document has no rawBytes for incremental commit');
    }
    const result = appendIncrementalUpdate(
      this.doc,
      this.dirty,
      this.created,
      { offsetManager: this.offsets, revisionManager: this.revisions },
    );
    this.dirty.clear();
    this.created.clear();
    return result;
  }

  listRevisions() {
    return this.revisions.list();
  }
}

export { listRevisions, OffsetManager, RevisionManager };

// ─── Incremental xref ───────────────────────────────────────────────────────

function buildIncrementalXref(offsets: Map<string, number>): Uint8Array {
  const entries: { objNum: number; genNum: number; offset: number }[] = [];

  const offsetEntries = Array.from(offsets.entries());
  for (let i = 0; i < offsetEntries.length; i++) {
    const [key, offset] = offsetEntries[i];
    const parts = key.split('_');
    entries.push({
      objNum: parseInt(parts[0], 10),
      genNum: parseInt(parts[1], 10),
      offset,
    });
  }

  entries.sort((a, b) => a.objNum - b.objNum);

  const subsections: { start: number; entries: typeof entries }[] = [];
  let currentSub: typeof entries = [];
  let expectedNext = -1;

  for (const entry of entries) {
    if (entry.objNum !== expectedNext && currentSub.length > 0) {
      subsections.push({ start: currentSub[0].objNum, entries: [...currentSub] });
      currentSub = [];
    }
    currentSub.push(entry);
    expectedNext = entry.objNum + 1;
  }

  if (currentSub.length > 0) {
    subsections.push({ start: currentSub[0].objNum, entries: currentSub });
  }

  const lines: string[] = ['xref'];

  for (const sub of subsections) {
    lines.push(`${sub.start} ${sub.entries.length}`);
    for (const entry of sub.entries) {
      const offsetStr = entry.offset.toString().padStart(10, '0');
      const genStr = entry.genNum.toString().padStart(5, '0');
      lines.push(`${offsetStr} ${genStr} n `);
    }
  }

  return stringToBytes(lines.join('\n') + '\n');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function findCatalogRef(doc: PDFDocumentData): PDFRef | null {
  // Prefer trailer Root; else scan for Catalog
  for (const [key, obj] of doc.objects) {
    if (obj instanceof PDFDict) {
      const type = obj.get('Type');
      if (type instanceof PDFName && type.name === 'Catalog') {
        const parts = key.split('_');
        return new PDFRef(parseInt(parts[0], 10), parseInt(parts[1] ?? '0', 10));
      }
    }
  }
  return null;
}

function getMaxObjNum(doc: PDFDocumentData): number {
  let max = 0;
  const keys = Array.from(doc.objects.keys());
  for (let i = 0; i < keys.length; i++) {
    const objNum = parseInt(keys[i].split('_')[0], 10);
    if (objNum > max) max = objNum;
  }
  return max;
}

function trailerDictToString(dict: PDFDict): string {
  const entries: string[] = [];
  const dictEntries = Array.from(dict.entries());
  for (let i = 0; i < dictEntries.length; i++) {
    const [key, value] = dictEntries[i];
    entries.push(`/${key} ${value.toString()}`);
  }
  return `<< ${entries.join(' ')} >>`;
}

function stringToBytes(str: string): Uint8Array {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    bytes[i] = str.charCodeAt(i) & 0xff;
  }
  return bytes;
}

// Silence unused imports that may be needed by consumers re-exporting types
void PDFArray;
void PDFStream;
