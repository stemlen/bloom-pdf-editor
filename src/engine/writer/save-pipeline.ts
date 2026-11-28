/**
 * Save pipeline — quick (incremental) vs optimized (GC + dedup + full serialize).
 */

import type { PDFDocumentData, PDFObject } from '../types';
import { serializeDocument } from './serializer';
import { saveIncremental } from './incremental-writer';
import { garbageCollect, rootsFromTrailer, deduplicateStreams, applyRefMap } from '../optimize';
import { needsWriteEncryption } from '../security/encryption/write-encryption';

/**
 * Quick save: append only changed objects when possible.
 */
export async function saveQuick(
  doc: PDFDocumentData,
  modifiedKeys?: Set<string>,
  newObjects?: Map<string, PDFObject>,
): Promise<Uint8Array> {
  // Encrypted documents are written in full: the original bytes may be
  // unencrypted or use another key, so an appended update could not be read.
  if (!doc.rawBytes || doc.rawBytes.length === 0 || needsWriteEncryption(doc)) {
    return serializeDocument(doc);
  }

  const mods = modifiedKeys ?? new Set<string>();
  if (mods.size === 0 && (!newObjects || newObjects.size === 0)) {
    return serializeDocument(doc);
  }

  try {
    return saveIncremental(doc, mods, newObjects);
  } catch {
    return serializeDocument(doc);
  }
}

/**
 * Optimized save: garbage-collect unreachable objects, dedupe streams, full serialize.
 */
export async function saveOptimized(doc: PDFDocumentData): Promise<Uint8Array> {
  let objectsToSerialize = doc.objects;
  try {
    const extraRoots: import('../types').PDFRef[] = [];
    const catRef = doc.xref?.trailerDict?.getRef('Root');
    if (catRef) extraRoots.push(catRef);
    for (const page of doc.pages) {
      if (page.ref) extraRoots.push(page.ref);
    }
    const roots = rootsFromTrailer(doc.xref.trailerDict, extraRoots);
    if (roots.length > 0) {
      const gc = garbageCollect(doc.objects, roots, { deduplicateStreams: true });
      objectsToSerialize = gc.objects;
    }
  } catch {
    try {
      const dedup = deduplicateStreams(doc.objects);
      if (dedup.refMap.size > 0) {
        objectsToSerialize = applyRefMap(doc.objects, dedup.refMap);
      }
    } catch {
      // continue
    }
  }
  return serializeDocument({ ...doc, objects: objectsToSerialize });
}

export type SaveMode = 'quick' | 'optimized';

export async function saveDocument(
  doc: PDFDocumentData,
  mode: SaveMode = 'optimized',
): Promise<Uint8Array> {
  return mode === 'quick' ? saveQuick(doc) : saveOptimized(doc);
}
