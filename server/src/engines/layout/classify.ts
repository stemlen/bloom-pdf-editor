import { createId } from '../../utils/id.js';
import {
  assertAllowedRegionKind,
  type IRegionClassifier,
} from './algorithms/types.js';
import type {
  DominantAlignment,
  LayoutBlock,
  LayoutRegion,
  LayoutRegionKind,
  SegmentCandidate,
  WritingDirection,
} from './types.js';

/**
 * Feature-based region classification.
 * Geometric labels only — no paragraph/table detection, no IDM style inference.
 */
export class RegionClassifier implements IRegionClassifier {
  readonly name = 'RegionClassifier';

  classify(input: {
    pageWidth: number;
    pageHeight: number;
    segments: SegmentCandidate[];
    blocks: LayoutBlock[];
    medianFontSize: number;
    writingDirection: WritingDirection;
  }): LayoutRegion[] {
    const { pageWidth, pageHeight, segments, blocks, writingDirection } = input;
    const byId = new Map(blocks.map((b) => [b.id, b]));

    return segments.map((seg, i) => {
      const segBlocks = seg.blockIds
        .map((id) => byId.get(id))
        .filter((b): b is LayoutBlock => b != null);

      const features = computeFeatures(seg.bbox, segBlocks, pageWidth, pageHeight);
      const decided = decideKind(features);
      let kind = decided.kind;
      const confidence = decided.confidence;

      if (kind === 'caption' && !nearImageSegment(seg, segments, byId)) {
        kind = 'text_block';
      }

      assertAllowedRegionKind(kind);

      const regionId = createId('region');
      for (const b of segBlocks) b.parentId = regionId;

      return {
        id: regionId,
        kind,
        bbox: { ...seg.bbox },
        parentId: null,
        childIds: segBlocks.map((b) => b.id),
        readingOrderIndex: -1,
        confidence,
        readingPriority: i,
        objectDensity: features.objectDensity,
        textDensity: features.textDensity,
        whitespaceDensity: features.whitespaceDensity,
        averageFont: features.averageFont,
        averageFontSize: features.averageFontSize,
        dominantAlignment: features.alignment,
        rotation: 0,
        writingDirection,
        blocks: segBlocks,
        columnIndex: seg.columnHint,
      };
    });
  }
}

interface Features {
  topBand: number;
  bottomBand: number;
  leftRatio: number;
  rightRatio: number;
  imageFraction: number;
  formFraction: number;
  averageFontSize: number;
  averageFont?: string;
  objectDensity: number;
  textDensity: number;
  whitespaceDensity: number;
  alignment: DominantAlignment;
  isNarrow: boolean;
  isWide: boolean;
  textLen: number;
  heightRatio: number;
}

function computeFeatures(
  bbox: LayoutRegion['bbox'],
  blocks: LayoutBlock[],
  pageWidth: number,
  pageHeight: number,
): Features {
  const area = Math.max(bbox.width * bbox.height, 1);
  const regionTop = bbox.y + bbox.height;
  const topBand = Math.max(0, pageHeight - regionTop) / pageHeight;
  const bottomBand = bbox.y / pageHeight;

  let imageArea = 0;
  let formArea = 0;
  let textLen = 0;
  let fontSizeSum = 0;
  let fontSizeCount = 0;
  const fontCounts = new Map<string, number>();

  for (const b of blocks) {
    const a = Math.max(b.bbox.width * b.bbox.height, 0);
    if (b.kind === 'image') imageArea += a;
    if (b.kind === 'form') formArea += a;
    textLen += (b.text ?? '').replace(/\s/g, '').length;
    if (b.style) {
      fontSizeSum += b.style.fontSize;
      fontSizeCount++;
      fontCounts.set(b.style.fontName, (fontCounts.get(b.style.fontName) ?? 0) + 1);
    }
  }

  const occupied = blocks.reduce(
    (s, b) => s + Math.max(b.bbox.width * b.bbox.height, 0),
    0,
  );

  let averageFont: string | undefined;
  let best = 0;
  for (const [name, n] of fontCounts) {
    if (n > best) {
      best = n;
      averageFont = name;
    }
  }

  return {
    topBand,
    bottomBand,
    leftRatio: bbox.x / pageWidth,
    rightRatio: (pageWidth - (bbox.x + bbox.width)) / pageWidth,
    imageFraction: imageArea / area,
    formFraction: formArea / area,
    averageFontSize: fontSizeCount ? fontSizeSum / fontSizeCount : 0,
    averageFont,
    objectDensity: blocks.length / area,
    textDensity: textLen / area,
    whitespaceDensity: Math.max(0, 1 - occupied / area),
    alignment: dominantAlignment(blocks, pageWidth),
    isNarrow: bbox.width < pageWidth * 0.35,
    isWide: bbox.width > pageWidth * 0.7,
    textLen,
    heightRatio: bbox.height / pageHeight,
  };
}

function decideKind(f: Features): { kind: LayoutRegionKind; confidence: number } {
  if (f.imageFraction >= 0.55) return { kind: 'image', confidence: 0.9 };
  if (f.formFraction >= 0.4) return { kind: 'form_area', confidence: 0.75 };

  // Header/footer: thin strips in the page margin bands — not tall body blocks.
  if (
    f.topBand <= 0.1 &&
    f.heightRatio <= 0.08 &&
    f.textLen > 0 &&
    f.textLen < 120 &&
    f.averageFontSize < 18
  ) {
    return { kind: 'header', confidence: f.isWide ? 0.9 : 0.8 };
  }
  if (
    f.bottomBand <= 0.1 &&
    f.heightRatio <= 0.08 &&
    f.textLen > 0 &&
    f.textLen < 120
  ) {
    return { kind: 'footer', confidence: f.isWide ? 0.9 : 0.8 };
  }

  if (f.whitespaceDensity > 0.85 && f.textLen > 0 && f.textLen < 40 && f.alignment === 'center') {
    return { kind: 'watermark', confidence: 0.55 };
  }

  if (f.isNarrow && (f.leftRatio < 0.05 || f.rightRatio < 0.05) && f.textLen > 0) {
    return { kind: 'sidebar', confidence: 0.7 };
  }

  if (f.averageFontSize >= 20 && f.textLen > 0 && f.textLen < 120 && f.topBand <= 0.35) {
    return { kind: 'title', confidence: 0.8 };
  }
  if (f.averageFontSize >= 14 && f.averageFontSize < 20 && f.textLen > 0 && f.textLen < 160) {
    return { kind: 'heading', confidence: 0.7 };
  }

  if (f.bottomBand <= 0.2 && f.averageFontSize > 0 && f.averageFontSize <= 9 && f.textLen > 0) {
    return { kind: 'footnote', confidence: 0.65 };
  }

  if (f.textLen > 0 && f.textLen < 100 && f.averageFontSize > 0 && f.averageFontSize <= 10) {
    return { kind: 'caption', confidence: 0.6 };
  }

  if (f.textLen > 0) return { kind: 'text_block', confidence: 0.75 };
  if (f.imageFraction > 0.2) return { kind: 'image', confidence: 0.6 };
  return { kind: 'unknown', confidence: 0.4 };
}

function nearImageSegment(
  seg: SegmentCandidate,
  segments: SegmentCandidate[],
  byId: Map<string, LayoutBlock>,
): boolean {
  return segments.some((s) => {
    if (s === seg) return false;
    const bl = s.blockIds.map((id) => byId.get(id)).filter((b): b is LayoutBlock => !!b);
    if (!bl.some((b) => b.kind === 'image')) return false;
    const gap =
      seg.bbox.y > s.bbox.y + s.bbox.height
        ? seg.bbox.y - (s.bbox.y + s.bbox.height)
        : s.bbox.y - (seg.bbox.y + seg.bbox.height);
    return gap >= 0 && gap < 48;
  });
}

function dominantAlignment(blocks: LayoutBlock[], pageWidth: number): DominantAlignment {
  const textBlocks = blocks.filter((b) => b.kind === 'text_cluster' || b.kind === 'line');
  if (textBlocks.length === 0) return 'left';

  let left = 0;
  let center = 0;
  let right = 0;
  for (const b of textBlocks) {
    const mid = b.bbox.x + b.bbox.width / 2;
    const pageMid = pageWidth / 2;
    if (Math.abs(mid - pageMid) < pageWidth * 0.08) center++;
    else if (b.bbox.x + b.bbox.width > pageWidth * 0.75) right++;
    else left++;
  }
  if (center >= left && center >= right) return 'center';
  if (right > left) return 'right';
  if (left > 0 && right > 0 && Math.abs(left - right) <= 1) return 'mixed';
  return 'left';
}
