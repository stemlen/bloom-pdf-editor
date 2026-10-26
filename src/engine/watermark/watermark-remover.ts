/**
 * Watermark Removal Engine
 *
 * Removes watermarks from PDF pages. Supports two removal strategies:
 *
 * 1. **Content-stream surgery** — Directly modifies the page content stream
 *    to remove watermark graphics operators while preserving legitimate content.
 *    This is the most thorough approach and works for watermarks embedded
 *    directly in the page content.
 *
 * 2. **Annotation removal** — Removes watermark annotations from the page's
 *    /Annots array. Clean and safe, works for annotation-based watermarks.
 *
 * 3. **Resource cleanup** — Removes orphaned ExtGState and XObject resources
 *    that were created solely for watermark rendering.
 *
 * The engine works hand-in-hand with the detection engine: you detect first,
 * then pass the DetectedWatermark[] results to the removal engine for
 * targeted removal.
 */

import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFStream,
  type PDFPageInfo,
} from '../types';
import { detectWatermarks, type DetectedWatermark } from './watermark-detector';

// ─── Removal result types ───────────────────────────────────────────────────

export interface RemovalResult {
  /** Whether removal was successful */
  success: boolean;
  /** The watermark ID that was targeted */
  watermarkId: string;
  /** Page index where removal occurred */
  pageIndex: number;
  /** Strategy used for removal */
  strategy: 'content-surgery' | 'annotation-removal' | 'resource-cleanup';
  /** Description of what was done */
  description: string;
  /** Any warnings or notes */
  warnings?: string[];
}

export interface BatchRemovalResult {
  /** Total watermarks targeted */
  total: number;
  /** Number successfully removed */
  removed: number;
  /** Number that failed */
  failed: number;
  /** Per-watermark results */
  results: RemovalResult[];
}

// ─── Main removal functions ─────────────────────────────────────────────────

/**
 * Remove detected watermarks from the document.
 * Mutates the document's object map and page dictionaries.
 *
 * @param doc Document with pages and objects map (will be mutated)
 * @param detections Detected watermarks to remove
 * @returns Batch removal result
 */
export function removeWatermarks(
  doc: { pages: PDFPageInfo[]; objects: Map<string, PDFObject> },
  detections: DetectedWatermark[],
): BatchRemovalResult {
  const results: RemovalResult[] = [];

  // Group detections by page for efficient processing
  const byPage = new Map<number, DetectedWatermark[]>();
  for (const det of detections) {
    if (!byPage.has(det.pageIndex)) byPage.set(det.pageIndex, []);
    byPage.get(det.pageIndex)!.push(det);
  }

  for (const [pageIndex, pageDetections] of byPage) {
    if (pageIndex < 0 || pageIndex >= doc.pages.length) {
      for (const det of pageDetections) {
        results.push({
          success: false,
          watermarkId: det.id,
          pageIndex,
          strategy: 'content-surgery',
          description: `Page index ${pageIndex} out of range`,
        });
      }
      continue;
    }

    const page = doc.pages[pageIndex];

    // Separate detections by method
    const contentDetections = pageDetections.filter(d => d.detectionMethod === 'content-analysis');
    const annotationDetections = pageDetections.filter(d => d.detectionMethod === 'annotation');
    const resourceDetections = pageDetections.filter(d => d.detectionMethod === 'resource-analysis');

    // 1. Remove annotation-based watermarks
    if (annotationDetections.length > 0) {
      const annotResults = removeAnnotationWatermarks(page, doc.objects, annotationDetections, pageIndex);
      results.push(...annotResults);
    }

    // 2. Remove content-stream watermarks
    if (contentDetections.length > 0) {
      const contentResults = removeContentStreamWatermarks(page, doc.objects, contentDetections, pageIndex);
      results.push(...contentResults);
    }

    // 3. Clean up orphaned resources
    if (resourceDetections.length > 0 || contentDetections.length > 0) {
      const cleanupResults = cleanupWatermarkResources(page, doc.objects, pageDetections, pageIndex);
      results.push(...cleanupResults);
    }
  }

  const removed = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  return {
    total: detections.length,
    removed,
    failed,
    results,
  };
}

/**
 * Remove watermarks from a single page.
 */
export function removeWatermarksFromPage(
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  pageIndex: number,
  detections: DetectedWatermark[],
): RemovalResult[] {
  const results: RemovalResult[] = [];

  const contentDetections = detections.filter(d => d.detectionMethod === 'content-analysis');
  const annotationDetections = detections.filter(d => d.detectionMethod === 'annotation');
  const resourceDetections = detections.filter(d => d.detectionMethod === 'resource-analysis');

  if (annotationDetections.length > 0) {
    results.push(...removeAnnotationWatermarks(page, objects, annotationDetections, pageIndex));
  }

  if (contentDetections.length > 0) {
    results.push(...removeContentStreamWatermarks(page, objects, contentDetections, pageIndex));
  }

  if (resourceDetections.length > 0 || contentDetections.length > 0) {
    results.push(...cleanupWatermarkResources(page, objects, detections, pageIndex));
  }

  return results;
}

// ─── Strategy 1: Annotation removal ─────────────────────────────────────────

function removeAnnotationWatermarks(
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  detections: DetectedWatermark[],
  pageIndex: number,
): RemovalResult[] {
  const results: RemovalResult[] = [];

  const annots = page.dict.get('Annots');
  if (!annots) {
    for (const det of detections) {
      results.push({
        success: false,
        watermarkId: det.id,
        pageIndex,
        strategy: 'annotation-removal',
        description: 'No /Annots array on page',
      });
    }
    return results;
  }

  let annotArray: PDFArray;
  if (annots instanceof PDFRef) {
    const resolved = objects.get(annots.toKey());
    if (resolved instanceof PDFArray) {
      annotArray = resolved;
    } else {
      for (const det of detections) {
        results.push({
          success: false,
          watermarkId: det.id,
          pageIndex,
          strategy: 'annotation-removal',
          description: '/Annots ref does not resolve to array',
        });
      }
      return results;
    }
  } else if (annots instanceof PDFArray) {
    annotArray = annots;
  } else {
    for (const det of detections) {
      results.push({
        success: false,
        watermarkId: det.id,
        pageIndex,
        strategy: 'annotation-removal',
        description: '/Annots is not an array',
      });
    }
    return results;
  }

  // Collect refs to remove
  const refsToRemove = new Set<string>();
  for (const det of detections) {
    const annotRef = det.metadata?.annotRef as string | undefined;
    if (annotRef) {
      refsToRemove.add(annotRef);
    }
  }

  if (refsToRemove.size === 0) {
    for (const det of detections) {
      results.push({
        success: false,
        watermarkId: det.id,
        pageIndex,
        strategy: 'annotation-removal',
        description: 'No annotation refs found in detection metadata',
      });
    }
    return results;
  }

  // Build new array without the watermark annotations
  const newArray = new PDFArray();
  let removedCount = 0;

  for (let i = 0; i < annotArray.length; i++) {
    const item = annotArray.get(i);
    if (!item) continue;
    if (item instanceof PDFRef && refsToRemove.has(item.toKey())) {
      // Also delete the annotation object from the object map
      objects.delete(item.toKey());
      removedCount++;
    } else {
      newArray.push(item);
    }
  }

  // Update the page's /Annots
  if (annots instanceof PDFRef) {
    // Replace the resolved array's contents
    const resolved = objects.get(annots.toKey());
    if (resolved instanceof PDFArray) {
      // Mutate in place by clearing and re-adding
      resolved.items.length = 0;
      for (let i = 0; i < newArray.length; i++) {
        const item = newArray.get(i);
        if (item) resolved.push(item);
      }
    }
  } else {
    page.dict.set('Annots', newArray);
  }

  for (const det of detections) {
    const wasRemoved = det.metadata?.annotRef && refsToRemove.has(det.metadata.annotRef as string);
    results.push({
      success: !!wasRemoved,
      watermarkId: det.id,
      pageIndex,
      strategy: 'annotation-removal',
      description: wasRemoved
        ? `Removed annotation ${det.metadata?.annotRef}`
        : 'Annotation ref not found in /Annots',
    });
  }

  return results;
}

// ─── Strategy 2: Content stream surgery ─────────────────────────────────────

function removeContentStreamWatermarks(
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  detections: DetectedWatermark[],
  pageIndex: number,
): RemovalResult[] {
  const results: RemovalResult[] = [];

  // Get the page content stream(s)
  const contents = page.dict.get('Contents');
  if (!contents) {
    for (const det of detections) {
      results.push({
        success: false,
        watermarkId: det.id,
        pageIndex,
        strategy: 'content-surgery',
        description: 'No /Contents on page',
      });
    }
    return results;
  }

  // Collect all content stream refs
  const contentRefs: PDFRef[] = [];
  if (contents instanceof PDFRef) {
    contentRefs.push(contents);
  } else if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.length; i++) {
      const item = contents.get(i);
      if (item instanceof PDFRef) contentRefs.push(item);
    }
  }

  if (contentRefs.length === 0) {
    for (const det of detections) {
      results.push({
        success: false,
        watermarkId: det.id,
        pageIndex,
        strategy: 'content-surgery',
        description: 'No content stream refs found',
      });
    }
    return results;
  }

  // Collect all watermark indicators from detections
  const wmTexts = new Set<string>();
  const wmGSNames = new Set<string>();
  const wmImageNames = new Set<string>();

  for (const det of detections) {
    if (det.text && det.text.trim().length > 0) {
      wmTexts.add(det.text.trim());
    }
    // Collect ExtGState names from detection metadata
    const gsName = det.metadata?.gsName as string | undefined;
    if (gsName) wmGSNames.add(gsName);
    const extGStateName = det.metadata?.extGStateName as string | undefined;
    if (extGStateName) wmGSNames.add(extGStateName);
    // Collect image names
    const imgName = det.metadata?.imageName as string | undefined;
    if (imgName) wmImageNames.add(imgName);
  }

  // Also include our engine's naming conventions
  // (GS_wm_* and ImWM_* are always watermark-related)

  // For each content stream, attempt watermark removal
  for (const ref of contentRefs) {
    const streamObj = objects.get(ref.toKey());
    if (!(streamObj instanceof PDFStream)) continue;

    const rawBytes = streamObj.decodedBytes || streamObj.rawBytes;
    const contentStr = bytesToString(rawBytes);

    let modifiedStr = contentStr;
    let modifications = 0;

    // ── PRIMARY STRATEGY: Remove entire q...Q blocks that contain
    //    watermark indicators (GS names, watermark text, or watermark images).
    //    This removes both the transparency AND the content in one shot.
    const { result: afterBlockRemoval, count: blockCount } = removeWatermarkQBlocks(
      modifiedStr, wmTexts, wmGSNames, wmImageNames,
    );
    modifiedStr = afterBlockRemoval;
    modifications += blockCount;

    // ── FALLBACK: If block removal didn't find anything, try removing
    //    individual BT...ET text blocks containing watermark text
    if (modifications === 0) {
      const { result: afterBTRemoval, count: btCount } = removeWatermarkBTBlocks(
        modifiedStr, wmTexts,
      );
      modifiedStr = afterBTRemoval;
      modifications += btCount;
    }

    // ── FALLBACK: Remove individual text operations (Tj/TJ) with watermark text
    if (modifications === 0) {
      const { result: afterTextRemoval, count: textCount } = removeWatermarkTextOps(
        modifiedStr, wmTexts,
      );
      modifiedStr = afterTextRemoval;
      modifications += textCount;
    }

    // ── CLEANUP: Remove any remaining orphaned GS_wm_*/ImWM_* references
    //    (only our engine's naming convention — safe to remove)
    const { result: afterGSCleanup, count: gsCleanupCount } = removeOrphanedWatermarkOps(modifiedStr);
    modifiedStr = afterGSCleanup;
    modifications += gsCleanupCount;

    // ── FORM XOBJECT SCAN: Also process form XObjects that may contain watermarks
    const formModCount = removeWatermarksFromFormXObjects(
      page, objects, wmTexts, wmGSNames, wmImageNames,
    );
    modifications += formModCount;

    // Update the stream if modified
    if (modifiedStr !== contentStr) {
      const newBytes = stringToBytes(modifiedStr);
      streamObj.rawBytes = newBytes;
      streamObj.decodedBytes = newBytes;
      streamObj.dict.set('Length', new PDFNumber(newBytes.length));
      // The bytes are now stored uncompressed — drop the old filter chain.
      streamObj.dict.delete('Filter');
      streamObj.dict.delete('DecodeParms');
    }

    for (const det of detections) {
      results.push({
        success: modifications > 0,
        watermarkId: det.id,
        pageIndex,
        strategy: 'content-surgery',
        description: modifications > 0
          ? `Removed ${modifications} watermark element(s) from content stream`
          : 'No watermark content found to remove',
        warnings: modifications === 0 ? ['Content surgery found no matching patterns'] : undefined,
      });
    }
  }

  return results;
}

// ── Content surgery helpers ─────────────────────────────────────────────────

/**
 * PRIMARY STRATEGY: Remove entire q...Q graphics state blocks that contain
 * watermark indicators. This is the most robust approach because it removes
 * both the opacity settings AND the content rendered with them.
 *
 * A typical watermark block looks like:
 *   q                          ← save graphics state
 *   /GS1 gs                   ← set watermark opacity
 *   1 0 0 1 300 400 cm        ← position transform
 *   BT /F1 48 Tf ... (Bloom PDF) Tj ET  ← text
 *   Q                          ← restore graphics state
 *
 * We find q...Q blocks that contain ANY of:
 *   - A /GSName gs where GSName is a known watermark ExtGState
 *   - A text string matching detected watermark text
 *   - A /ImName Do where ImName is a known watermark image
 */
function removeWatermarkQBlocks(
  contentStr: string,
  wmTexts: Set<string>,
  wmGSNames: Set<string>,
  wmImageNames: Set<string>,
): { result: string; count: number } {
  let result = contentStr;
  let count = 0;

  // Find all q...Q blocks (including nested ones — match outermost)
  // Use a stack-based approach to properly handle nesting
  const blocksToRemove: Array<{ start: number; end: number }> = [];

  // Find all q and Q positions
  const qPositions: number[] = [];
  const qStack: number[] = [];

  // Tokenize to find standalone q and Q operators (not inside strings)
  const opRegex = /(?:^|\s)(q|Q)(?:\s|$)/g;
  let opMatch: RegExpExecArray | null;
  // More reliable: split into q/Q tokens
  const tokenRegex = /\bq\b|\bQ\b/g;
  while ((opMatch = tokenRegex.exec(result)) !== null) {
    // Make sure this isn't inside a string literal
    const before = result.substring(Math.max(0, opMatch.index - 1), opMatch.index);
    // Simple check: not preceded by ( which would indicate inside a string
    if (before === '(') continue;

    if (opMatch[0] === 'q') {
      qStack.push(opMatch.index);
    } else if (opMatch[0] === 'Q' && qStack.length > 0) {
      const qStart = qStack.pop()!;
      const qEnd = opMatch.index + 1;
      const blockContent = result.substring(qStart, qEnd);

      // Check if this block contains watermark indicators
      let isWatermarkBlock = false;

      // Check for watermark ExtGState references
      for (const gsName of wmGSNames) {
        const gsPattern = new RegExp(`/${gsName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+gs`);
        if (gsPattern.test(blockContent)) {
          isWatermarkBlock = true;
          break;
        }
      }

      // Check for our engine's GS naming convention
      if (!isWatermarkBlock && /\/GS_wm_[\w-]+\s+gs/.test(blockContent)) {
        isWatermarkBlock = true;
      }

      // Check for watermark text
      if (!isWatermarkBlock) {
        for (const text of wmTexts) {
          const escaped = escapePDFStringForRegex(text);
          const textPattern = new RegExp(`\\(${escaped}\\)`);
          if (textPattern.test(blockContent)) {
            isWatermarkBlock = true;
            break;
          }
        }
      }

      // Check for watermark images
      if (!isWatermarkBlock) {
        for (const imgName of wmImageNames) {
          const imgPattern = new RegExp(`/${imgName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+Do`);
          if (imgPattern.test(blockContent)) {
            isWatermarkBlock = true;
            break;
          }
        }
        // Also check our engine naming
        if (/\/ImWM_\w+\s+Do/.test(blockContent)) {
          isWatermarkBlock = true;
        }
      }

      if (isWatermarkBlock) {
        // Only add if not overlapping with an already-found block
        const overlaps = blocksToRemove.some(b =>
          (qStart >= b.start && qStart <= b.end) ||
          (qEnd >= b.start && qEnd <= b.end),
        );
        if (!overlaps) {
          blocksToRemove.push({ start: qStart, end: qEnd });
        }
      }
    }
  }

  // Remove blocks from end to start to maintain offsets
  blocksToRemove.sort((a, b) => b.start - a.start);
  for (const block of blocksToRemove) {
    result = result.substring(0, block.start) + result.substring(block.end);
    count++;
  }

  return { result, count };
}

/**
 * FALLBACK: Remove entire BT...ET text blocks that contain watermark text.
 * Used when the watermark isn't wrapped in a q...Q block.
 */
function removeWatermarkBTBlocks(
  contentStr: string,
  wmTexts: Set<string>,
): { result: string; count: number } {
  let result = contentStr;
  let count = 0;

  if (wmTexts.size === 0) return { result, count };

  for (const text of wmTexts) {
    const escaped = escapePDFStringForRegex(text);
    // Match BT ... (text) Tj ... ET or BT ... with TJ containing text ... ET
    const btRegex = new RegExp(`BT[\\s\\S]*?\\(${escaped}\\)[\\s\\S]*?ET`, 'g');

    let match: RegExpExecArray | null;
    while ((match = btRegex.exec(result)) !== null) {
      result = result.substring(0, match.index) + result.substring(match.index + match[0].length);
      count++;
      btRegex.lastIndex = match.index;
    }
  }

  return { result, count };
}

/**
 * FALLBACK: Remove individual text operations (Tj/TJ) that contain watermark text.
 */
function removeWatermarkTextOps(
  contentStr: string,
  wmTexts: Set<string>,
): { result: string; count: number } {
  let result = contentStr;
  let count = 0;

  if (wmTexts.size === 0) return { result, count };

  for (const text of wmTexts) {
    const escaped = escapePDFStringForRegex(text);

    // Remove Tj operations with this text
    const tjRegex = new RegExp(`\\(${escaped}\\)\\s*Tj`, 'g');
    let match: RegExpExecArray | null;
    while ((match = tjRegex.exec(result)) !== null) {
      result = result.substring(0, match.index) + result.substring(match.index + match[0].length);
      count++;
      tjRegex.lastIndex = match.index;
    }

    // Remove TJ array entries containing this text
    const tjArrRegex = new RegExp(`\\[[^\\]]*\\(${escaped}\\)[^\\]]*\\]\\s*TJ`, 'g');
    while ((match = tjArrRegex.exec(result)) !== null) {
      result = result.substring(0, match.index) + result.substring(match.index + match[0].length);
      count++;
      tjArrRegex.lastIndex = match.index;
    }
  }

  return { result, count };
}

/**
 * CLEANUP: Remove orphaned watermark-engine-specific operators.
 * Only removes operators with our engine's naming convention (GS_wm_*, ImWM_*).
 * These are safe to remove because they were created by our watermark engine.
 */
function removeOrphanedWatermarkOps(
  contentStr: string,
): { result: string; count: number } {
  let result = contentStr;
  let count = 0;

  // Remove /GS_wm_* gs operations
  const gsRegex = /\/GS_wm_[\w-]+\s+gs/g;
  let match: RegExpExecArray | null;
  while ((match = gsRegex.exec(result)) !== null) {
    result = result.substring(0, match.index) + result.substring(match.index + match[0].length);
    count++;
    gsRegex.lastIndex = match.index;
  }

  // Remove /ImWM_* Do operations
  const imgRegex = /\/ImWM_[\w-]+\s+Do/g;
  while ((match = imgRegex.exec(result)) !== null) {
    result = result.substring(0, match.index) + result.substring(match.index + match[0].length);
    count++;
    imgRegex.lastIndex = match.index;
  }

  return { result, count };
}

/**
 * Remove watermark content from form XObjects referenced by the page.
 * Watermarks are often placed in separate form XObjects.
 */
function removeWatermarksFromFormXObjects(
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  wmTexts: Set<string>,
  wmGSNames: Set<string>,
  wmImageNames: Set<string>,
): number {
  let modifications = 0;

  const resources = page.dict.get('Resources');
  if (!resources) return modifications;

  let resDict: PDFDict | undefined;
  if (resources instanceof PDFRef) {
    const resolved = objects.get(resources.toKey());
    if (resolved instanceof PDFDict) resDict = resolved;
  } else if (resources instanceof PDFDict) {
    resDict = resources;
  }
  if (!resDict) return modifications;

  const xObjects = resDict.get('XObject');
  if (!xObjects) return modifications;

  let xObjDict: PDFDict | undefined;
  if (xObjects instanceof PDFRef) {
    const resolved = objects.get(xObjects.toKey());
    if (resolved instanceof PDFDict) xObjDict = resolved;
  } else if (xObjects instanceof PDFDict) {
    xObjDict = xObjects;
  }
  if (!xObjDict) return modifications;

  const keysToRemove: string[] = [];

  for (const [name, value] of xObjDict.entries()) {
    let stream: PDFStream | undefined;
    let streamRef: PDFRef | undefined;
    if (value instanceof PDFRef) {
      streamRef = value;
      const resolved = objects.get(value.toKey());
      if (resolved instanceof PDFStream) stream = resolved;
    } else if (value instanceof PDFStream) {
      stream = value;
    }
    if (!stream) continue;

    // Check if it's a Form XObject
    const subtype = stream.dict.get('Subtype');
    if (!(subtype instanceof PDFName) || subtype.name !== 'Form') continue;

    const formBytes = stream.decodedBytes || stream.rawBytes;
    const formStr = bytesToString(formBytes);

    // Check if this form XObject contains watermark content
    let isWatermarkForm = false;

    // Check for watermark ExtGState references
    for (const gsName of wmGSNames) {
      const gsPattern = new RegExp(`/${gsName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+gs`);
      if (gsPattern.test(formStr)) {
        isWatermarkForm = true;
        break;
      }
    }

    // Check for watermark text
    if (!isWatermarkForm) {
      for (const text of wmTexts) {
        const escaped = escapePDFStringForRegex(text);
        const textPattern = new RegExp(`\\(${escaped}\\)`);
        if (textPattern.test(formStr)) {
          isWatermarkForm = true;
          break;
        }
      }
    }

    // Check engine naming conventions
    if (!isWatermarkForm && /\/GS_wm_[\w-]+\s+gs/.test(formStr)) {
      isWatermarkForm = true;
    }

    if (isWatermarkForm) {
      // Option 1: Remove the form XObject reference from the page
      keysToRemove.push(name);
      // Also delete the object from the object map
      if (streamRef) objects.delete(streamRef.toKey());
      modifications++;
    }
  }

  // Remove watermark form XObjects from the XObject dictionary
  for (const key of keysToRemove) {
    xObjDict.delete(key);
  }

  return modifications;
}

/**
 * Remove image Do operations for watermark images.
 */
function removeWatermarkImageOps(
  contentStr: string,
  detections: DetectedWatermark[],
): { result: string; count: number } {
  let result = contentStr;
  let count = 0;

  // Collect image names from detection metadata
  const imageNames = new Set<string>();
  for (const det of detections) {
    const imgName = det.metadata?.imageName as string | undefined;
    if (imgName) {
      imageNames.add(imgName);
    }
  }

  // Also look for watermark-like image names (ImWM_ prefix from our engine)
  const wmImageRegex = /\/ImWM_[\w-]+\s+Do/g;
  let match: RegExpExecArray | null;
  while ((match = wmImageRegex.exec(result)) !== null) {
    result = result.substring(0, match.index) + result.substring(match.index + match[0].length);
    count++;
    wmImageRegex.lastIndex = match.index;
  }

  for (const name of imageNames) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const doRegex = new RegExp(`/${escapedName}\\s+Do`, 'g');
    while ((match = doRegex.exec(result)) !== null) {
      result = result.substring(0, match.index) + result.substring(match.index + match[0].length);
      count++;
      doRegex.lastIndex = match.index;
    }
  }

  return { result, count };
}

// ─── Strategy 3: Resource cleanup ───────────────────────────────────────────

function cleanupWatermarkResources(
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  detections: DetectedWatermark[],
  pageIndex: number,
): RemovalResult[] {
  const results: RemovalResult[] = [];

  const resources = page.dict.get('Resources');
  if (!resources) {
    return detections.map(det => ({
      success: true,
      watermarkId: det.id,
      pageIndex,
      strategy: 'resource-cleanup' as const,
      description: 'No resources to clean up',
    }));
  }

  let resDict: PDFDict;
  if (resources instanceof PDFRef) {
    const resolved = objects.get(resources.toKey());
    if (resolved instanceof PDFDict) {
      resDict = resolved;
    } else {
      return detections.map(det => ({
        success: false,
        watermarkId: det.id,
        pageIndex,
        strategy: 'resource-cleanup' as const,
        description: 'Resources ref does not resolve to dict',
      }));
    }
  } else if (resources instanceof PDFDict) {
    resDict = resources;
  } else {
    return detections.map(det => ({
      success: false,
      watermarkId: det.id,
      pageIndex,
      strategy: 'resource-cleanup' as const,
      description: 'Resources is not a dict',
    }));
  }

  let cleanedCount = 0;

  // Clean up ExtGState entries for watermarks
  const extGState = resDict.get('ExtGState');
  if (extGState instanceof PDFDict) {
    const keysToRemove: string[] = [];

    for (const [key, value] of extGState.entries()) {
      // Remove GS_wm_* entries (our watermark engine's naming)
      if (key.startsWith('GS_wm_')) {
        keysToRemove.push(key);
        // Also delete the referenced object
        if (value instanceof PDFRef) {
          objects.delete(value.toKey());
        }
      }

      // Check detection metadata
      for (const det of detections) {
        const gsName = det.metadata?.extGStateName as string | undefined;
        if (gsName && key === gsName) {
          keysToRemove.push(key);
          if (value instanceof PDFRef) {
            objects.delete(value.toKey());
          }
        }
      }
    }

    for (const key of keysToRemove) {
      extGState.delete(key);
      cleanedCount++;
    }

    // If ExtGState dict is now empty, remove it
    if (extGState.size === 0) {
      resDict.delete('ExtGState');
    }
  }

  // Clean up XObject entries for watermark images
  const xobjects = resDict.get('XObject');
  if (xobjects instanceof PDFDict) {
    const keysToRemove: string[] = [];

    for (const [key, value] of xobjects.entries()) {
      // Remove ImWM_* entries (our watermark engine's naming)
      if (key.startsWith('ImWM_')) {
        keysToRemove.push(key);
        if (value instanceof PDFRef) {
          objects.delete(value.toKey());
        }
      }

      // Check detection metadata
      for (const det of detections) {
        const imgName = det.metadata?.imageName as string | undefined;
        if (imgName && key === imgName) {
          keysToRemove.push(key);
          if (value instanceof PDFRef) {
            objects.delete(value.toKey());
          }
        }
      }
    }

    for (const key of keysToRemove) {
      xobjects.delete(key);
      cleanedCount++;
    }

    if (xobjects.size === 0) {
      resDict.delete('XObject');
    }
  }

  // If Resources dict is now empty (only has required keys), we can leave it
  // but at minimum clean up the watermark-specific entries

  return detections.map(det => ({
    success: true,
    watermarkId: det.id,
    pageIndex,
    strategy: 'resource-cleanup' as const,
    description: cleanedCount > 0
      ? `Cleaned up ${cleanedCount} watermark resource(s)`
      : 'No watermark resources found to clean',
  }));
}

// ─── Utility: Remove all watermarks (detect + remove in one call) ───────────

/**
 * Convenience function: detect and remove all watermarks from a document.
 * Combines detection and removal in a single operation.
 */
export function detectAndRemoveAllWatermarks(
  doc: { pages: PDFPageInfo[]; objects: Map<string, PDFObject> },
  options?: {
    minConfidence?: number;
    dryRun?: boolean;
  },
): { detections: DetectedWatermark[]; removal: BatchRemovalResult } {
  const detections = detectWatermarks(doc, {
    minConfidence: options?.minConfidence ?? 0.4,
  });

  let removal: BatchRemovalResult;
  if (options?.dryRun) {
    removal = {
      total: detections.length,
      removed: 0,
      failed: 0,
      results: detections.map((d: DetectedWatermark) => ({
        success: false,
        watermarkId: d.id,
        pageIndex: d.pageIndex,
        strategy: 'content-surgery' as const,
        description: 'Dry run — no changes made',
      })),
    };
  } else {
    removal = removeWatermarks(doc, detections);
  }

  return { detections, removal };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function bytesToString(bytes: Uint8Array): string {
  // PDF content streams are raw byte data (Latin-1), NOT UTF-8.
  // We must preserve each byte value exactly as a char code point.
  // Using TextDecoder('utf-8') would corrupt bytes > 127.
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i]);
  }
  return s;
}

function stringToBytes(s: string): Uint8Array {
  // Convert back from Latin-1 string to raw bytes.
  // Each char's code point maps directly to a byte value.
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    bytes[i] = s.charCodeAt(i) & 0xFF;
  }
  return bytes;
}

function escapePDFStringForRegex(text: string): string {
  // 1. Convert text to how it is escaped inside a PDF string literal
  const pdfEscaped = text
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
    
  // 2. Escape the resulting string for use in a JavaScript RegExp
  return pdfEscaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}