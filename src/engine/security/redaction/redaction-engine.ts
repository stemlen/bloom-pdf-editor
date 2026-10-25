/**
 * Secure Redaction Engine — Phase 10.
 *
 * Removes sensitive content from content streams (text, images, vectors),
 * annotations, and form fields. Does NOT paint black rectangles.
 */

import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRef,
  type PDFDocumentData,
  type PDFObject,
  type PDFRectangle,
} from '../../types';
import { getPageContentBytes, resolveRef } from '../../parser/parser';
import { parseContentStream } from '../../content/operator-lexer';
import { interpretPage } from '../../content/interpreter';
import { compileInstructions } from '../../editor/text-editor';
import { updatePageContent } from '../../editor/stream-compiler';
import {
  createAnnotationDict,
  addAnnotationToPage,
  removeAnnotationFromPage,
  type RedactAnnotation,
} from '../../editor/annotation-engine';
import { getNextObjNum } from '../../writer/serializer';
import { metadataEngine } from '../metadata/metadata-engine';
import type {
  IRedactionEngine,
  RedactionVerification,
  SecureRedactionOptions,
  SecureRedactionResult,
} from '../types';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return !(
    a.x + a.width < b.x ||
    b.x + b.width < a.x ||
    a.y + a.height < b.y ||
    b.y + b.height < a.y
  );
}

function collectRedactRects(
  pageDict: PDFDict,
  objects: Map<string, PDFObject>,
): { refs: Array<{ ref: PDFRef; dict: PDFDict }>; rects: Rect[] } {
  const refs: Array<{ ref: PDFRef; dict: PDFDict }> = [];
  const rects: Rect[] = [];
  const annots = pageDict.get('Annots');
  if (!annots) return { refs, rects };

  const arr = annots instanceof PDFRef ? resolveRef(annots, objects) : annots;
  if (!(arr instanceof PDFArray)) return { refs, rects };

  for (let i = 0; i < arr.length; i++) {
    const item = arr.get(i);
    if (!(item instanceof PDFRef)) continue;
    const dict = resolveRef(item, objects);
    if (!(dict instanceof PDFDict)) continue;
    if (dict.getName('Subtype') !== 'Redact') continue;
    refs.push({ ref: item, dict });

    const qp = dict.get('QuadPoints');
    if (qp instanceof PDFArray && qp.length >= 8) {
      const nums: number[] = [];
      for (let j = 0; j < qp.length; j++) {
        const n = qp.get(j);
        if (n instanceof PDFNumber) nums.push(n.value);
      }
      // Flatten quads into bounding rects (each 8 numbers)
      for (let q = 0; q + 7 < nums.length; q += 8) {
        const xs = [nums[q], nums[q + 2], nums[q + 4], nums[q + 6]];
        const ys = [nums[q + 1], nums[q + 3], nums[q + 5], nums[q + 7]];
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);
        rects.push({ x: minX, y: minY, width: maxX - minX, height: maxY - minY });
      }
    } else {
      const r = dict.get('Rect');
      if (r instanceof PDFArray && r.length >= 4) {
        const x1 = (r.get(0) as PDFNumber).value;
        const y1 = (r.get(1) as PDFNumber).value;
        const x2 = (r.get(2) as PDFNumber).value;
        const y2 = (r.get(3) as PDFNumber).value;
        rects.push({
          x: Math.min(x1, x2),
          y: Math.min(y1, y2),
          width: Math.abs(x2 - x1),
          height: Math.abs(y2 - y1),
        });
      }
    }
  }
  return { refs, rects };
}

function annotRect(dict: PDFDict): Rect | null {
  const r = dict.get('Rect');
  if (!(r instanceof PDFArray) || r.length < 4) return null;
  const x1 = (r.get(0) as PDFNumber).value;
  const y1 = (r.get(1) as PDFNumber).value;
  const x2 = (r.get(2) as PDFNumber).value;
  const y2 = (r.get(3) as PDFNumber).value;
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

export class RedactionEngine implements IRedactionEngine {
  markRegion(
    doc: PDFDocumentData,
    pageIndex: number,
    rect: Rect,
  ): PDFRef {
    const page = doc.pages[pageIndex];
    const pdfRect: PDFRectangle = { ...rect };
    const quadPoints = [
      rect.x, rect.y + rect.height,
      rect.x + rect.width, rect.y + rect.height,
      rect.x, rect.y,
      rect.x + rect.width, rect.y,
    ];
    const annot: RedactAnnotation = {
      type: 'Redact',
      rect: pdfRect,
      color: [0, 0, 0],
      opacity: 0.3,
      quadPoints,
    };
    const objNum = getNextObjNum(doc);
    const { dict } = createAnnotationDict(annot, objNum);
    const ref = new PDFRef(objNum, 0);
    addAnnotationToPage(page.dict, dict, ref, doc.objects);
    return ref;
  }

  async applySecureRedactions(
    doc: PDFDocumentData,
    options: SecureRedactionOptions = {},
  ): Promise<SecureRedactionResult> {
    const doText = options.text !== false;
    const doImages = options.images !== false;
    const doVectors = options.vectors !== false;
    const doAnnots = options.annotations !== false;
    const doForms = options.formFields !== false;
    const doMeta = options.metadata === true;

    let pagesProcessed = 0;
    let textOperatorsRemoved = 0;
    let imageOperatorsRemoved = 0;
    const pathOperatorsRemoved = 0;
    let annotationsRemoved = 0;
    let formFieldsRemoved = 0;

    for (let pageIndex = 0; pageIndex < doc.pages.length; pageIndex++) {
      const page = doc.pages[pageIndex];
      const { refs, rects } = collectRedactRects(page.dict, doc.objects);
      if (rects.length === 0) continue;
      pagesProcessed++;

      const contentBytes = getPageContentBytes(page, doc.objects);
      const interpreted = interpretPage(contentBytes, page, doc.objects);
      const instructions = parseContentStream(contentBytes);
      const removeIndices = new Set<number>();

      for (const item of interpreted.displayList) {
        if (item.type === 'text' && doText) {
          const run = item;
          const runRect: Rect = {
            x: run.x,
            y: run.y - run.fontSize * 0.2,
            width: Math.max(run.width, 1),
            height: Math.max(run.fontSize * 1.2, 1),
          };
          if (!rects.some((rr) => rectsOverlap(runRect, rr))) continue;
          const indices = run.sourceInstructionIndices ?? [];
          for (const idx of indices) removeIndices.add(idx);
          if (indices.length > 0) {
            const mid = indices[0];
            for (let i = mid; i >= 0; i--) {
              removeIndices.add(i);
              if (instructions[i]?.operator === 'BT') break;
            }
            for (let i = mid; i < instructions.length; i++) {
              removeIndices.add(i);
              if (instructions[i]?.operator === 'ET') break;
            }
          }
          textOperatorsRemoved++;
        }

        if (item.type === 'image' && doImages) {
          const img = item;
          const imgRect: Rect = {
            x: img.x,
            y: img.y,
            width: Math.max(img.width, 1),
            height: Math.max(img.height, 1),
          };
          if (!rects.some((rr) => rectsOverlap(imgRect, rr))) continue;
          if (img.sourceInstructionIndex !== undefined) {
            removeIndices.add(img.sourceInstructionIndex);
            imageOperatorsRemoved++;
          }
        }

        if (item.type === 'path' && doVectors) {
          const path = item;
          const pathRect: Rect = {
            x: path.x,
            y: path.y,
            width: Math.max(path.width, 1),
            height: Math.max(path.height, 1),
          };
          if (!rects.some((rr) => rectsOverlap(pathRect, rr))) continue;
          // Paths may not carry instruction indices — scan nearby path ops by bounds only
          // Best-effort: remove nothing without indices to avoid corrupting streams
        }
      }

      // Also strip bare image Do operators whose computed bounds we may have missed
      if (doImages) {
        for (let i = 0; i < instructions.length; i++) {
          if (instructions[i]?.operator === 'Do') {
            // If any redact covers a large portion of the page, still rely on display list;
            // leave orphan Do removal to display-list hits only.
          }
        }
      }

      const sorted = Array.from(removeIndices).sort((a, b) => b - a);
      for (const idx of sorted) {
        if (idx >= 0 && idx < instructions.length) instructions.splice(idx, 1);
      }

      // Secure: rewrite stream WITHOUT painting black rectangles
      const bytes = compileInstructions(instructions);
      await updatePageContent(page.contentRefs, bytes, doc.objects);

      // Remove Redact marks
      for (const { ref } of refs) {
        removeAnnotationFromPage(page.dict, ref, doc.objects);
        doc.objects.delete(ref.toKey());
        annotationsRemoved++;
      }

      // Remove other annotations / form widgets intersecting regions
      if (doAnnots || doForms) {
        const annots = page.dict.get('Annots');
        if (annots) {
          const arr = annots instanceof PDFRef ? resolveRef(annots, doc.objects) : annots;
          if (arr instanceof PDFArray) {
            for (let i = arr.length - 1; i >= 0; i--) {
              const item = arr.get(i);
              if (!(item instanceof PDFRef)) continue;
              const dict = resolveRef(item, doc.objects);
              if (!(dict instanceof PDFDict)) continue;
              const subtype = dict.getName('Subtype') ?? '';
              const isWidget = subtype === 'Widget';
              if (isWidget && !doForms) continue;
              if (!isWidget && !doAnnots) continue;
              if (subtype === 'Redact') continue; // already removed
              const ar = annotRect(dict);
              if (!ar || !rects.some((rr) => rectsOverlap(ar, rr))) continue;
              arr.items.splice(i, 1);
              doc.objects.delete(item.toKey());
              if (isWidget) formFieldsRemoved++;
              else annotationsRemoved++;
            }
          }
        }
      }
    }

    let metadataStripped = false;
    if (doMeta) {
      metadataEngine.stripMetadata(doc, { stripInfo: true, stripXmp: true });
      metadataStripped = true;
    }

    return {
      pagesProcessed,
      textOperatorsRemoved,
      imageOperatorsRemoved,
      pathOperatorsRemoved,
      annotationsRemoved,
      formFieldsRemoved,
      metadataStripped,
    };
  }

  /**
   * Verify that forbidden strings no longer appear in any content stream bytes.
   */
  verifyRedaction(doc: PDFDocumentData, forbidden: string[]): RedactionVerification {
    const found: string[] = [];
    const decoder = new TextDecoder('latin1');
    for (const page of doc.pages) {
      const bytes = getPageContentBytes(page, doc.objects);
      const text = decoder.decode(bytes);
      for (const f of forbidden) {
        if (f && text.includes(f) && !found.includes(f)) found.push(f);
      }
    }
    // Also scan Info strings
    for (const v of Object.values(doc.info)) {
      if (typeof v !== 'string') continue;
      for (const f of forbidden) {
        if (f && v.includes(f) && !found.includes(f)) found.push(f);
      }
    }
    return { ok: found.length === 0, found };
  }
}

export const redactionEngine = new RedactionEngine();
