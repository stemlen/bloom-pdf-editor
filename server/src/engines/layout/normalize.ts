import {
  IDENTITY_MATRIX,
  transformPoint,
  type BoundingBox,
  type Matrix2D,
} from '../common/geometry.js';
import type { RawPage } from '../parser/raw-model.js';
import type {
  ICoordinateNormalizer,
  NormalizedChar,
  NormalizedImage,
  NormalizedShape,
} from './algorithms/types.js';
import type { NormalizedPage, WritingDirection } from './types.js';

/**
 * Normalize page coordinates into a consistent layout space.
 * - Applies page /Rotate
 * - Uses CropBox when present (falls back to MediaBox)
 * - Origin remains PDF-like (bottom-left) after rotation remap
 */
export class CoordinateNormalizer implements ICoordinateNormalizer {
  readonly name = 'CoordinateNormalizer';

  normalize(page: RawPage): {
    normalized: NormalizedPage;
    characters: NormalizedChar[];
    images: NormalizedImage[];
    vectors: NormalizedShape[];
    annotations: NormalizedShape[];
    forms: NormalizedShape[];
  } {
    const crop = page.boxes.cropBox;
    const media = page.boxes.mediaBox;
    const box = crop.width > 0 && crop.height > 0 ? crop : media;
    const rotation = ((page.rotation % 360) + 360) % 360;

    const rawToNormalized = buildRotationMatrix(rotation, box.width, box.height);
    const { width, height } = rotatedSize(box.width, box.height, rotation);

    const writingDirection = majorityDirection(page.characters);

    const mapBBox = (b: BoundingBox): BoundingBox => transformBBox(b, rawToNormalized);

    const characters: NormalizedChar[] = page.characters.map((c) => {
      const bbox = mapBBox(c.bbox);
      return {
        id: c.id,
        bbox,
        unicode: c.unicode,
        fontName: c.fontName,
        fontSize: c.fontSize,
        fontWeight: c.fontWeight,
        italic: c.italic,
        baseline: bbox.y,
        writingDirection: c.writingDirection,
        rotation: c.rotation + rotation,
        sourceRunId: c.parentId,
        sourceZIndex: c.zIndex,
      };
    });

    const images: NormalizedImage[] = page.images.map((img) => ({
      id: img.id,
      bbox: mapBBox(img.bbox),
      rotation: img.rotation + rotation,
    }));

    const vectors: NormalizedShape[] = page.vectors.map((v) => ({
      id: v.id,
      bbox: mapBBox(v.bbox),
      kind: 'vector' as const,
    }));

    const annotations: NormalizedShape[] = page.annotations.map((a) => ({
      id: a.id,
      bbox: mapBBox(a.bbox),
      kind: 'annotation' as const,
    }));

    const forms: NormalizedShape[] = page.forms.map((f) => ({
      id: f.id,
      bbox: mapBBox(f.bbox),
      kind: 'form' as const,
    }));

    const normalized: NormalizedPage = {
      pageIndex: page.index,
      width,
      height,
      rotation,
      writingDirection,
      rawToNormalized,
      mediaBox: { ...media },
      cropBox: { ...crop },
    };

    return { normalized, characters, images, vectors, annotations, forms };
  }
}

function buildRotationMatrix(rotation: number, w: number, h: number): Matrix2D {
  switch (rotation) {
    // /Rotate turns the page clockwise for display (PDF 7.7.3.3). In the
    // displayed page (still bottom-left origin):
    case 90:
      // (x, y) → (y, w − x): text drawn bottom-to-top reads left-to-right.
      return [0, -1, 1, 0, 0, w];
    case 180:
      return [-1, 0, 0, -1, w, h];
    case 270:
      // (x, y) → (h − y, x)
      return [0, 1, -1, 0, h, 0];
    default:
      return IDENTITY_MATRIX;
  }
}

function rotatedSize(w: number, h: number, rotation: number): { width: number; height: number } {
  if (rotation === 90 || rotation === 270) return { width: h, height: w };
  return { width: w, height: h };
}

function transformBBox(b: BoundingBox, m: Matrix2D): BoundingBox {
  const corners = [
    transformPoint(m, b.x, b.y),
    transformPoint(m, b.x + b.width, b.y),
    transformPoint(m, b.x, b.y + b.height),
    transformPoint(m, b.x + b.width, b.y + b.height),
  ];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function majorityDirection(
  characters: Array<{ writingDirection: WritingDirection }>,
): WritingDirection {
  if (characters.length === 0) return 'ltr';
  const counts = { ltr: 0, rtl: 0, ttb: 0 };
  for (const c of characters) counts[c.writingDirection]++;
  let best: WritingDirection = 'ltr';
  let n = -1;
  for (const k of ['ltr', 'rtl', 'ttb'] as const) {
    if (counts[k] > n) {
      n = counts[k];
      best = k;
    }
  }
  return best;
}
