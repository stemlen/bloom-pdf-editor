import { createId } from '../../utils/id.js';
import type { ILayoutEngine } from '../common/interfaces.js';
import type { RawDocument, RawPage } from '../parser/raw-model.js';
import { createDefaultStrategies } from './algorithms/defaults.js';
import type { LayoutStrategies } from './algorithms/types.js';
import type { LayoutDocument, LayoutPage } from './types.js';

export interface LayoutEngineOptions {
  concurrency?: number;
  strategies?: Partial<LayoutStrategies>;
}

/**
 * Phase 3 — Layout Analysis Engine
 *
 * RawDocument → LayoutDocument (regions + reading order).
 * No export, no OCR, no paragraph/table reconstruction.
 */
export class LayoutEngine implements ILayoutEngine {
  readonly name = 'LayoutEngine' as const;
  private readonly strategies: LayoutStrategies;
  private readonly concurrency: number;

  constructor(options: LayoutEngineOptions = {}) {
    const defaults = createDefaultStrategies();
    this.strategies = { ...defaults, ...options.strategies };
    this.concurrency = Math.max(1, options.concurrency ?? 4);
  }

  async analyze(raw: RawDocument): Promise<LayoutDocument> {
    const pages = await mapPool(raw.pages, this.concurrency, (page) =>
      Promise.resolve(this.analyzePage(page)),
    );

    pages.sort((a, b) => a.pageIndex - b.pageIndex);

    const docId = createId('layout');
    for (const page of pages) {
      page.parentId = docId;
    }

    return {
      id: docId,
      sourceDocumentId: raw.id,
      pages,
    };
  }

  private analyzePage(page: RawPage): LayoutPage {
    const { normalizer, createSpatialIndex, clusterer, whitespace, segmenter, classifier, readingOrder } =
      this.strategies;

    // 1. Normalize
    const { normalized, characters, images, vectors, annotations, forms } =
      normalizer.normalize(page);

    // A page-sized rectangle (a white background, as Chrome paints, or a page
    // frame) is not content. As a block it would pull every text block into
    // one page-sized region, losing their positions.
    const content = vectors.filter(
      (v) => !(v.bbox.width >= normalized.width * 0.9 && v.bbox.height >= normalized.height * 0.9),
    );

    // 2. Spatial index + 3. Clustering
    const index = createSpatialIndex();
    const { clusters, blocks } = clusterer.cluster({
      pageIndex: page.index,
      characters,
      images,
      vectors: content,
      annotations,
      forms,
      index,
    });

    // 4. Whitespace
    const signals = whitespace.analyze({
      pageWidth: normalized.width,
      pageHeight: normalized.height,
      clusters,
    });

    // 5. Segmentation (XY-Cut)
    const segments = segmenter.segment({
      pageWidth: normalized.width,
      pageHeight: normalized.height,
      blocks,
      whitespace: signals,
    });

    const medianFontSize = median(
      characters.map((c) => c.fontSize).filter((n) => n > 0),
    );

    // 6. Classification
    const regions = classifier.classify({
      pageWidth: normalized.width,
      pageHeight: normalized.height,
      segments,
      blocks,
      medianFontSize,
      writingDirection: normalized.writingDirection,
    });

    // 7. Reading order
    const orderGraph = readingOrder.build({
      pageWidth: normalized.width,
      pageHeight: normalized.height,
      regions,
      whitespace: signals,
      writingDirection: normalized.writingDirection,
    });

    // 8. Layout page graph node
    const pageId = createId('layoutPage');
    for (const r of regions) r.parentId = pageId;

    return {
      id: pageId,
      pageIndex: page.index,
      width: normalized.width,
      height: normalized.height,
      bbox: { x: 0, y: 0, width: normalized.width, height: normalized.height },
      parentId: null,
      childIds: regions.map((r) => r.id),
      readingOrderIndex: page.index,
      confidence: regions.length ? average(regions.map((r) => r.confidence)) : 1,
      normalized,
      regions,
      readingOrder: orderGraph,
    };
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 12;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, () => worker()),
  );
  return results;
}
