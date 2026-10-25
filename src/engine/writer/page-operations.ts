/**
 * Page Operations
 *
 * Structural operations on PDF page trees:
 *   - Delete pages
 *   - Reorder pages
 *   - Rotate pages
 *   - Extract pages into a new document
 *   - Merge pages from another document
 *   - Insert blank pages
 *
 * All operations modify the in-memory document structure.
 * Call the serializer or incremental writer to produce output bytes.
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
  type PDFPageInfo,
  type PDFRectangle,
} from '../types';
import { resolveRef } from '../parser/parser';
import { getNextObjNum } from './serializer';

// ─── Page deletion ──────────────────────────────────────────────────────────

/**
 * Delete a page from the document by index.
 * Modifies the document's page tree and updates the pages array.
 */
export function deletePage(doc: PDFDocumentData, pageIndex: number): void {
  if (pageIndex < 0 || pageIndex >= doc.pages.length) {
    throw new Error(`Page index ${pageIndex} out of range`);
  }
  if (doc.pages.length <= 1) {
    throw new Error('Cannot delete the last page');
  }

  const page = doc.pages[pageIndex];

  // Remove from parent's Kids array
  removePageFromTree(page.ref, doc.catalog, doc.objects);

  // Update page count
  updatePageCount(doc.catalog, doc.objects, -1);

  // Remove from our pages array
  doc.pages.splice(pageIndex, 1);

  // Re-index remaining pages
  for (let i = pageIndex; i < doc.pages.length; i++) {
    doc.pages[i].index = i;
  }
}

/**
 * Delete multiple pages at once (more efficient than calling deletePage repeatedly).
 * Indices should be in ascending order.
 */
export function deletePages(doc: PDFDocumentData, indices: number[]): void {
  // Sort descending so we don't invalidate indices
  const sorted = [...indices].sort((a, b) => b - a);
  for (const idx of sorted) {
    deletePage(doc, idx);
  }
}

// ─── Page reordering ────────────────────────────────────────────────────────

/**
 * Reorder pages according to a new index mapping.
 * @param newOrder Array where newOrder[newIndex] = oldIndex
 */
export function reorderPages(doc: PDFDocumentData, newOrder: number[]): void {
  if (newOrder.length !== doc.pages.length) {
    throw new Error('New order must have same number of pages');
  }

  // Validate all indices are present
  const seen = new Set<number>();
  for (const idx of newOrder) {
    if (idx < 0 || idx >= doc.pages.length || seen.has(idx)) {
      throw new Error(`Invalid page order: ${newOrder.join(', ')}`);
    }
    seen.add(idx);
  }

  // Reorder pages array
  const oldPages = [...doc.pages];
  for (let i = 0; i < newOrder.length; i++) {
    doc.pages[i] = oldPages[newOrder[i]];
    doc.pages[i].index = i;
  }

  // Rebuild the Kids array in the pages root
  rebuildKidsArray(doc);
}

/**
 * Move a page from one position to another.
 */
export function movePage(doc: PDFDocumentData, fromIndex: number, toIndex: number): void {
  if (fromIndex === toIndex) return;
  if (fromIndex < 0 || fromIndex >= doc.pages.length) throw new Error('Invalid from index');
  if (toIndex < 0 || toIndex >= doc.pages.length) throw new Error('Invalid to index');

  const newOrder = Array.from({ length: doc.pages.length }, (_, i) => i);
  const [removed] = newOrder.splice(fromIndex, 1);
  newOrder.splice(toIndex, 0, removed);
  reorderPages(doc, newOrder);
}

// ─── Page rotation ──────────────────────────────────────────────────────────

/**
 * Set the rotation of a page.
 * @param rotation Rotation in degrees (0, 90, 180, 270)
 */
export function rotatePage(doc: PDFDocumentData, pageIndex: number, rotation: number): void {
  if (pageIndex < 0 || pageIndex >= doc.pages.length) {
    throw new Error(`Page index ${pageIndex} out of range`);
  }

  // Normalize rotation
  const normalized = ((rotation % 360) + 360) % 360;
  if (![0, 90, 180, 270].includes(normalized)) {
    throw new Error('Rotation must be 0, 90, 180, or 270 degrees');
  }

  const page = doc.pages[pageIndex];
  page.rotate = normalized;
  page.dict.set('Rotate', new PDFNumber(normalized));
}

/**
 * Rotate a page by a relative amount (add to current rotation).
 */
export function rotatePageBy(doc: PDFDocumentData, pageIndex: number, degrees: number): void {
  const currentRotation = doc.pages[pageIndex].rotate;
  rotatePage(doc, pageIndex, currentRotation + degrees);
}

// ─── Page insertion ─────────────────────────────────────────────────────────

/**
 * Insert a blank page at the specified index.
 */
export function insertBlankPage(
  doc: PDFDocumentData,
  atIndex: number,
  size?: PDFRectangle,
): void {
  // Match the neighbouring page (the one before, else the one after), so a
  // blank page in an A4 document is A4; US Letter only for an empty document.
  if (!size) {
    const neighbour = doc.pages[atIndex - 1] ?? doc.pages[atIndex];
    const box = neighbour?.mediaBox;
    size = box ? { x: 0, y: 0, width: box.width, height: box.height } : { x: 0, y: 0, width: 612, height: 792 };
  }
  const nextObj = getNextObjNum(doc);

  // Create page dictionary
  const pageDict = new PDFDict();
  pageDict.set('Type', new PDFName('Page'));
  pageDict.set('MediaBox', new PDFArray([
    new PDFNumber(size.x),
    new PDFNumber(size.y),
    new PDFNumber(size.x + size.width),
    new PDFNumber(size.y + size.height),
  ]));

  // Set parent to root pages node
  const pagesRef = doc.catalog.getRef('Pages');
  if (pagesRef) pageDict.set('Parent', pagesRef);

  // Empty resources
  const resourcesDict = new PDFDict();
  pageDict.set('Resources', resourcesDict);

  // Empty content stream
  const contentDict = new PDFDict();
  contentDict.set('Length', new PDFNumber(0));
  const contentStream = new PDFStream(contentDict, new Uint8Array(0), new Uint8Array(0));
  const contentRef = new PDFRef(nextObj + 1, 0);
  doc.objects.set(contentRef.toKey(), contentStream);
  pageDict.set('Contents', contentRef);

  // Store page object
  const pageRef = new PDFRef(nextObj, 0);
  doc.objects.set(pageRef.toKey(), pageDict);

  // Add to pages array
  const pageInfo: PDFPageInfo = {
    index: atIndex,
    dict: pageDict,
    mediaBox: size,
    cropBox: size,
    rotate: 0,
    ref: pageRef,
    resources: resourcesDict,
    contentRefs: [contentRef],
  };

  doc.pages.splice(atIndex, 0, pageInfo);

  // Re-index
  for (let i = atIndex; i < doc.pages.length; i++) {
    doc.pages[i].index = i;
  }

  // Rebuild page tree
  rebuildKidsArray(doc);
}

// ─── Page extraction and merging ──────────────────────────────────────────────

/**
 * Insert pages from a source document into a target document at a specific index.
 */
export function insertPagesFromDocument(
  target: PDFDocumentData,
  source: PDFDocumentData,
  insertAtIndex: number,
): void {
  const refMap = new Map<string, PDFRef>(); // old source key → new target ref

  function copyObject(obj: PDFObject): PDFObject {
    if (obj instanceof PDFRef) {
      const oldKey = obj.toKey();
      if (refMap.has(oldKey)) return refMap.get(oldKey)!;

      // Allocate new ref in target
      const newRef = new PDFRef(getNextObjNum(target), 0);
      refMap.set(oldKey, newRef);
      // Temporarily set it in target to reserve the ref and prevent infinite loops on circular refs
      target.objects.set(newRef.toKey(), new PDFDict()); 

      // Copy the referenced object from source
      const resolved = source.objects.get(oldKey);
      if (resolved) {
        target.objects.set(newRef.toKey(), copyObjectDeep(resolved));
      }

      return newRef;
    }
    return copyObjectDeep(obj);
  }

  function copyObjectDeep(obj: PDFObject): PDFObject {
    if (obj instanceof PDFDict) {
      const newDict = new PDFDict();
      const entries = Array.from(obj.entries());
      for (let i = 0; i < entries.length; i++) {
        const [key, value] = entries[i];
        // Skip Parent reference for pages so we can re-parent them to target's Pages tree
        if (key === 'Parent') continue;
        newDict.set(key, copyObject(value));
      }
      return newDict;
    }

    if (obj instanceof PDFArray) {
      return new PDFArray(obj.items.map((item) => copyObject(item)));
    }

    if (obj instanceof PDFStream) {
      const newStreamDict = copyObjectDeep(obj.dict) as PDFDict;
      return new PDFStream(
        newStreamDict,
        new Uint8Array(obj.rawBytes),
        obj.decodedBytes ? new Uint8Array(obj.decodedBytes) : null,
      );
    }

    if (obj instanceof PDFRef) {
      return copyObject(obj);
    }

    return obj;
  }

  const targetPagesRef = target.catalog.getRef('Pages');
  if (!targetPagesRef) throw new Error('Target document has no Pages root');

  const pagesToInsert: PDFPageInfo[] = [];

  for (let i = 0; i < source.pages.length; i++) {
    const srcPage = source.pages[i];
    if (!srcPage) continue;

    const pageRef = copyObject(srcPage.ref) as PDFRef;

    // Set parent to target pages node
    const pageDictObj = target.objects.get(pageRef.toKey());
    if (pageDictObj instanceof PDFDict) {
      pageDictObj.set('Parent', targetPagesRef);

      const copiedResources = copyObjectDeep(srcPage.resources) as PDFDict;
      pageDictObj.set('Resources', copiedResources);
      pageDictObj.set('MediaBox', new PDFArray([
        new PDFNumber(srcPage.mediaBox.x),
        new PDFNumber(srcPage.mediaBox.y),
        new PDFNumber(srcPage.mediaBox.x + srcPage.mediaBox.width),
        new PDFNumber(srcPage.mediaBox.y + srcPage.mediaBox.height),
      ]));
      pageDictObj.set('CropBox', new PDFArray([
        new PDFNumber(srcPage.cropBox.x),
        new PDFNumber(srcPage.cropBox.y),
        new PDFNumber(srcPage.cropBox.x + srcPage.cropBox.width),
        new PDFNumber(srcPage.cropBox.y + srcPage.cropBox.height),
      ]));
      pageDictObj.set('Rotate', new PDFNumber(srcPage.rotate));

      pagesToInsert.push({
        index: insertAtIndex + i,
        dict: pageDictObj,
        mediaBox: { ...srcPage.mediaBox },
        cropBox: { ...srcPage.cropBox },
        rotate: srcPage.rotate,
        ref: pageRef,
        resources: copiedResources,
        contentRefs: srcPage.contentRefs.map((ref) => {
          const mapped = refMap.get(ref.toKey());
          return (mapped as PDFRef) ?? ref;
        }),
      });
    }
  }

  // Insert into target pages array
  target.pages.splice(insertAtIndex, 0, ...pagesToInsert);

  // Re-index pages
  for (let i = insertAtIndex; i < target.pages.length; i++) {
    target.pages[i].index = i;
  }

  // Rebuild page tree
  rebuildKidsArray(target);
}


/**
 * Extract specific pages into a new document data structure.
 * The extracted document can be serialized independently.
 */
export function extractPages(
  doc: PDFDocumentData,
  pageIndices: number[],
): PDFDocumentData {
  const newObjects = new Map<string, PDFObject>();
  const newPages: PDFPageInfo[] = [];
  let nextObj = 1;

  // Copy referenced objects recursively
  const refMap = new Map<string, PDFRef>(); // old key → new ref

  function copyObject(obj: PDFObject): PDFObject {
    if (obj instanceof PDFRef) {
      const oldKey = obj.toKey();
      if (refMap.has(oldKey)) return refMap.get(oldKey)!;

      // Allocate new ref
      const newRef = new PDFRef(nextObj++, 0);
      refMap.set(oldKey, newRef);

      // Copy the referenced object
      const resolved = doc.objects.get(oldKey);
      if (resolved) {
        newObjects.set(newRef.toKey(), copyObjectDeep(resolved));
      }

      return newRef;
    }
    return copyObjectDeep(obj);
  }

  function copyObjectDeep(obj: PDFObject): PDFObject {
    if (obj instanceof PDFDict) {
      const newDict = new PDFDict();
      const entries = Array.from(obj.entries());
      for (let i = 0; i < entries.length; i++) {
        const [key, value] = entries[i];
        // Skip Parent reference to avoid circular refs
        if (key === 'Parent') continue;
        newDict.set(key, copyObject(value));
      }
      return newDict;
    }

    if (obj instanceof PDFArray) {
      return new PDFArray(obj.items.map((item) => copyObject(item)));
    }

    if (obj instanceof PDFStream) {
      const newStreamDict = copyObjectDeep(obj.dict) as PDFDict;
      return new PDFStream(
        newStreamDict,
        new Uint8Array(obj.rawBytes),
        obj.decodedBytes ? new Uint8Array(obj.decodedBytes) : null,
      );
    }

    if (obj instanceof PDFRef) {
      return copyObject(obj);
    }

    return obj;
  }

  // Create root pages node
  const pagesRef = new PDFRef(nextObj++, 0);
  const pagesDict = new PDFDict();
  pagesDict.set('Type', new PDFName('Pages'));

  // Copy selected pages
  const kidsRefs: PDFRef[] = [];

  for (let i = 0; i < pageIndices.length; i++) {
    const srcPage = doc.pages[pageIndices[i]];
    if (!srcPage) continue;

    const pageRef = copyObject(srcPage.ref) as PDFRef;
    kidsRefs.push(pageRef);

    // Set parent to new pages node
    const pageDictObj = newObjects.get(pageRef.toKey());
    if (pageDictObj instanceof PDFDict) {
      pageDictObj.set('Parent', pagesRef);

      const copiedResources = copyObjectDeep(srcPage.resources) as PDFDict;
      pageDictObj.set('Resources', copiedResources);
      pageDictObj.set('MediaBox', new PDFArray([
        new PDFNumber(srcPage.mediaBox.x),
        new PDFNumber(srcPage.mediaBox.y),
        new PDFNumber(srcPage.mediaBox.x + srcPage.mediaBox.width),
        new PDFNumber(srcPage.mediaBox.y + srcPage.mediaBox.height),
      ]));
      pageDictObj.set('CropBox', new PDFArray([
        new PDFNumber(srcPage.cropBox.x),
        new PDFNumber(srcPage.cropBox.y),
        new PDFNumber(srcPage.cropBox.x + srcPage.cropBox.width),
        new PDFNumber(srcPage.cropBox.y + srcPage.cropBox.height),
      ]));
      pageDictObj.set('Rotate', new PDFNumber(srcPage.rotate));

      newPages.push({
        index: i,
        dict: pageDictObj,
        mediaBox: { ...srcPage.mediaBox },
        cropBox: { ...srcPage.cropBox },
        rotate: srcPage.rotate,
        ref: pageRef,
        resources: copiedResources,
        contentRefs: srcPage.contentRefs.map((ref) => {
          const mapped = refMap.get(ref.toKey());
          return (mapped as PDFRef) ?? ref;
        }),
      });
    }
  }

  pagesDict.set('Kids', new PDFArray(kidsRefs));
  pagesDict.set('Count', new PDFNumber(kidsRefs.length));
  newObjects.set(pagesRef.toKey(), pagesDict);

  // Create catalog
  const catalogRef = new PDFRef(nextObj++, 0);
  const catalogDict = new PDFDict();
  catalogDict.set('Type', new PDFName('Catalog'));
  catalogDict.set('Pages', pagesRef);
  newObjects.set(catalogRef.toKey(), catalogDict);

  // Build xref
  const trailerDict = new PDFDict();
  trailerDict.set('Size', new PDFNumber(nextObj));
  trailerDict.set('Root', catalogRef);

  return {
    version: doc.version,
    objects: newObjects,
    xref: { entries: new Map(), trailerDict },
    catalog: catalogDict,
    pages: newPages,
    info: { ...doc.info },
    rawBytes: new Uint8Array(0),
  };
}

// ─── Page tree helpers ──────────────────────────────────────────────────────

function removePageFromTree(
  pageRef: PDFRef,
  catalog: PDFDict,
  objects: Map<string, PDFObject>,
): void {
  const pagesRef = catalog.getRef('Pages');
  if (!pagesRef) return;

  const pagesObj = resolveRef(pagesRef, objects);
  if (!(pagesObj instanceof PDFDict)) return;

  const kids = pagesObj.get('Kids');
  if (!(kids instanceof PDFArray)) return;

  // Filter out the page ref
  const newItems = kids.items.filter((item) => {
    if (item instanceof PDFRef) return !item.equals(pageRef);
    return true;
  });

  pagesObj.set('Kids', new PDFArray(newItems));
}

function rebuildKidsArray(doc: PDFDocumentData): void {
  const pagesRef = doc.catalog.getRef('Pages');
  if (!pagesRef) return;

  const pagesObj = resolveRef(pagesRef, doc.objects);
  if (!(pagesObj instanceof PDFDict)) return;

  const newKids = new PDFArray(doc.pages.map((p) => p.ref));
  pagesObj.set('Kids', newKids);
  pagesObj.set('Count', new PDFNumber(doc.pages.length));
}

function updatePageCount(
  catalog: PDFDict,
  objects: Map<string, PDFObject>,
  delta: number,
): void {
  const pagesRef = catalog.getRef('Pages');
  if (!pagesRef) return;

  const pagesObj = resolveRef(pagesRef, objects);
  if (!(pagesObj instanceof PDFDict)) return;

  const count = pagesObj.getNumber('Count') ?? 0;
  pagesObj.set('Count', new PDFNumber(count + delta));
}
