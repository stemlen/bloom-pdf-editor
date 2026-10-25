/**
 * Unified editor undo/redo — content streams, page annotations, and overlays.
 *
 * Stores post-mutation snapshots (Acrobat-style in-memory stack). Undo restores
 * the previous snapshot; redo re-applies a popped one.
 */

import {
  PDFArray,
  PDFBoolean,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFDocumentData,
  type PDFObject,
} from '../types';

export interface OverlaySnapshot {
  drawnPathsJson: string;
  floatingTextsJson: string;
  floatingImagesJson: string;
  signaturesJson: string;
}

export interface PageAnnotSnapshot {
  /** Object keys for each /Annots entry (PDFRef.toKey()), in order */
  annotRefKeys: string[];
  /** Deep-cloned annotation objects (+ nested appearance streams) keyed by toKey() */
  objects: Map<string, PDFObject>;
}

export interface EditorHistoryEntry {
  label: string;
  timestamp: number;
  pageIndex: number;
  contentBytes: Uint8Array;
  annotSnapshot: PageAnnotSnapshot;
  overlays: OverlaySnapshot;
  /**
   * Entries that share a batch id form one user action spanning several
   * pages (e.g. Replace All); Undo and Redo treat them as a single step.
   */
  batchId?: string;
}

/** Deep-clone a PDF object graph (dicts/arrays/streams). Refs are copied by value. */
export function clonePDFObject(obj: PDFObject, seen = new WeakMap<object, PDFObject>()): PDFObject {
  if (obj instanceof PDFName) return new PDFName(obj.name);
  if (obj instanceof PDFString) return new PDFString(obj.value);
  if (obj instanceof PDFHexString) return new PDFHexString(obj.hex);
  if (obj instanceof PDFNumber) return new PDFNumber(obj.value);
  if (obj instanceof PDFBoolean) return new PDFBoolean(obj.value);
  if (obj instanceof PDFNull) return PDFNull.instance;
  if (obj instanceof PDFRef) return new PDFRef(obj.objNum, obj.genNum);

  if (typeof obj === 'object' && obj !== null && seen.has(obj)) {
    return seen.get(obj)!;
  }

  if (obj instanceof PDFArray) {
    const arr = new PDFArray();
    seen.set(obj, arr);
    for (const item of obj.items) {
      arr.push(clonePDFObject(item, seen));
    }
    return arr;
  }

  if (obj instanceof PDFDict) {
    const dict = new PDFDict();
    seen.set(obj, dict);
    for (const [k, v] of obj.entries()) {
      dict.set(k, clonePDFObject(v, seen));
    }
    return dict;
  }

  if (obj instanceof PDFStream) {
    const stream = new PDFStream(
      clonePDFObject(obj.dict, seen) as PDFDict,
      new Uint8Array(obj.rawBytes),
      obj.decodedBytes ? new Uint8Array(obj.decodedBytes) : null,
    );
    seen.set(obj, stream);
    return stream;
  }

  return obj;
}

function resolveAnnotsArray(
  pageDict: PDFDict,
  objects: Map<string, PDFObject>,
): { arr: PDFArray; mode: 'inline' | 'ref'; refKey?: string } | null {
  const annots = pageDict.get('Annots');
  if (!annots) return null;
  if (annots instanceof PDFArray) return { arr: annots, mode: 'inline' };
  if (annots instanceof PDFRef) {
    const resolved = objects.get(annots.toKey());
    if (resolved instanceof PDFArray) {
      return { arr: resolved, mode: 'ref', refKey: annots.toKey() };
    }
  }
  return null;
}

/** Capture annotation refs + cloned objects for a page. */
export function captureAnnotSnapshot(
  pageDict: PDFDict,
  objects: Map<string, PDFObject>,
): PageAnnotSnapshot {
  const resolved = resolveAnnotsArray(pageDict, objects);
  const annotRefKeys: string[] = [];
  const cloned = new Map<string, PDFObject>();

  if (!resolved) {
    return { annotRefKeys, objects: cloned };
  }

  for (const item of resolved.arr.items) {
    if (!(item instanceof PDFRef)) continue;
    const key = item.toKey();
    annotRefKeys.push(key);
    const obj = objects.get(key);
    if (obj) cloned.set(key, clonePDFObject(obj));

    // Also clone appearance stream if stored as a separate indirect object
    if (obj instanceof PDFDict) {
      const ap = obj.get('AP');
      if (ap instanceof PDFDict) {
        for (const [, v] of ap.entries()) {
          if (v instanceof PDFRef) {
            const apObj = objects.get(v.toKey());
            if (apObj) cloned.set(v.toKey(), clonePDFObject(apObj));
          }
        }
      }
    }
  }

  return { annotRefKeys, objects: cloned };
}

/** Restore page /Annots from a snapshot (replaces the annots array contents). */
export function restoreAnnotSnapshot(
  pageDict: PDFDict,
  objects: Map<string, PDFObject>,
  snapshot: PageAnnotSnapshot,
): void {
  const resolved = resolveAnnotsArray(pageDict, objects);
  const prevKeys = new Set<string>();
  if (resolved) {
    for (const item of resolved.arr.items) {
      if (item instanceof PDFRef) prevKeys.add(item.toKey());
    }
  }

  // Restore cloned annotation objects
  for (const [key, obj] of snapshot.objects) {
    objects.set(key, clonePDFObject(obj));
  }

  // Remove annotation objects that were added after the snapshot
  for (const key of prevKeys) {
    if (!snapshot.objects.has(key) && !snapshot.annotRefKeys.includes(key)) {
      // Only delete if it looks like a markup we track — keep if still referenced
      if (!snapshot.annotRefKeys.includes(key)) {
        // Don't delete non-markup (Widget, Link, etc.) that weren't in prevKeys as markup-only
        // Safer: only delete keys that were in prevKeys but not in snapshot
        objects.delete(key);
      }
    }
  }
  for (const key of prevKeys) {
    if (!snapshot.annotRefKeys.includes(key)) {
      objects.delete(key);
    }
  }

  const newItems = snapshot.annotRefKeys.map((k) => {
    const [num, gen] = k.split('_').map(Number);
    return new PDFRef(num, gen);
  });

  if (newItems.length === 0) {
    pageDict.delete('Annots');
    return;
  }

  if (resolved?.mode === 'ref' && resolved.refKey) {
    objects.set(resolved.refKey, new PDFArray(newItems));
  } else {
    pageDict.set('Annots', new PDFArray(newItems));
  }
}

export function makeOverlaySnapshot(overlays: {
  drawnPaths: unknown;
  floatingTexts: unknown;
  floatingImages: unknown;
  signatures: unknown;
}): OverlaySnapshot {
  return {
    drawnPathsJson: JSON.stringify(overlays.drawnPaths ?? []),
    floatingTextsJson: JSON.stringify(overlays.floatingTexts ?? []),
    floatingImagesJson: JSON.stringify(overlays.floatingImages ?? []),
    signaturesJson: JSON.stringify(overlays.signatures ?? []),
  };
}

export function parseOverlaySnapshot<T = unknown>(json: string): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return [] as T;
  }
}

export class EditorHistory {
  private undoStack: EditorHistoryEntry[] = [];
  private redoStack: EditorHistoryEntry[] = [];
  private readonly maxSize: number;

  constructor(maxSize = 50) {
    this.maxSize = maxSize;
  }

  push(entry: EditorHistoryEntry): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > this.maxSize) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Seed / reset with an initial snapshot (does not clear redo until next push). */
  seed(entry: EditorHistoryEntry): void {
    this.undoStack = [entry];
    this.redoStack = [];
  }

  canUndo(): boolean {
    return this.undoStack.length > 1;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): EditorHistoryEntry | null {
    if (this.undoStack.length < 2) return null;
    const current = this.undoStack.pop()!;
    this.redoStack.push(current);
    return this.undoStack[this.undoStack.length - 1];
  }

  redo(): EditorHistoryEntry | null {
    const next = this.redoStack.pop();
    if (!next) return null;
    this.undoStack.push(next);
    return next;
  }

  /**
   * Batch-aware undo. Pops the latest step (every entry of its batch, if it
   * has one) and returns the snapshots to apply: for each page the step
   * touched, the most recent remaining entry for that page.
   */
  undoStep(): EditorHistoryEntry[] | null {
    if (this.undoStack.length < 2) return null;
    const top = this.undoStack[this.undoStack.length - 1];
    const popped: EditorHistoryEntry[] = [];
    while (this.undoStack.length > 1) {
      const entry = this.undoStack[this.undoStack.length - 1];
      if (popped.length > 0 && (!top.batchId || entry.batchId !== top.batchId)) break;
      popped.push(this.undoStack.pop()!);
    }
    // Redo replays in push order, so keep the batch's first entry on top.
    for (const entry of popped) this.redoStack.push(entry);

    const pages = [...new Set(popped.map((e) => e.pageIndex))];
    const restore: EditorHistoryEntry[] = [];
    for (const pageIndex of pages) {
      for (let i = this.undoStack.length - 1; i >= 0; i--) {
        if (this.undoStack[i].pageIndex === pageIndex) {
          restore.push(this.undoStack[i]);
          break;
        }
      }
    }
    // Apply the remaining top entry last so its page becomes the current one.
    const newTop = this.undoStack[this.undoStack.length - 1];
    if (!restore.includes(newTop)) restore.push(newTop);
    else restore.push(...restore.splice(restore.indexOf(newTop), 1));
    return restore;
  }

  /** Batch-aware redo: re-applies every entry of the next step, in order. */
  redoStep(): EditorHistoryEntry[] | null {
    const first = this.redoStack.pop();
    if (!first) return null;
    const applied = [first];
    this.undoStack.push(first);
    while (first.batchId && this.redoStack.length > 0
      && this.redoStack[this.redoStack.length - 1].batchId === first.batchId) {
      const next = this.redoStack.pop()!;
      this.undoStack.push(next);
      applied.push(next);
    }
    return applied;
  }

  /** True if any undo entry describes the given page. */
  hasPage(pageIndex: number): boolean {
    return this.undoStack.some((e) => e.pageIndex === pageIndex);
  }

  peek(): EditorHistoryEntry | null {
    return this.undoStack.length > 0 ? this.undoStack[this.undoStack.length - 1] : null;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}

/** Capture a full page history entry from the live document. */
export function captureHistoryEntry(
  doc: PDFDocumentData,
  pageIndex: number,
  contentBytes: Uint8Array,
  overlays: {
    drawnPaths: unknown;
    floatingTexts: unknown;
    floatingImages: unknown;
    signatures: unknown;
  },
  label: string,
): EditorHistoryEntry {
  const page = doc.pages[pageIndex];
  return {
    label,
    timestamp: Date.now(),
    pageIndex,
    contentBytes: new Uint8Array(contentBytes),
    annotSnapshot: captureAnnotSnapshot(page.dict, doc.objects),
    overlays: makeOverlaySnapshot(overlays),
  };
}
