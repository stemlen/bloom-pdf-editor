import type { IParserEngine, ParseOptions } from '../common/interfaces.js';
import { createId } from '../../utils/id.js';
import { extractPageRaw } from './content-extractor.js';
import { getPageContentBytes, parsePdfDocument, resolve } from './document-parser.js';
import { ObjectGraph } from './object-graph.js';
import { PdfDict, PdfRef, type PdfPrimitive } from './pdf-objects.js';
import type { RawBookmark, RawDocument, RawDocumentMetadata } from './raw-model.js';

/**
 * Bloom ParserEngine — Phase 2
 *
 * PDF → Raw Object Graph (no layout, no OCR, no export).
 */
export class ParserEngine implements IParserEngine {
  readonly name = 'ParserEngine' as const;

  async parse(bytes: Uint8Array, options: ParseOptions = {}): Promise<RawDocument> {
    const parsed = await parsePdfDocument(bytes);
    const graph = new ObjectGraph();
    const docId = createId('rawdoc');

    const pageIndices =
      options.pages ?? parsed.pages.map((_, i) => i);

    const concurrency = Math.max(1, options.concurrency ?? 4);
    const selected = pageIndices
      .filter((i) => i >= 0 && i < parsed.pages.length)
      .map((i) => parsed.pages[i]!);

    const pages = await mapPool(selected, concurrency, async (page) => {
      const content = await getPageContentBytes(page, parsed.objects);
      return extractPageRaw(page, parsed.objects, content, graph);
    });

    pages.sort((a, b) => a.index - b.index);

    graph.add({
      id: docId,
      type: 'document',
      parentId: null,
      childIds: pages.map((p) => p.id),
      pageIndex: -1,
      bbox: { x: 0, y: 0, width: 0, height: 0 },
      transform: [1, 0, 0, 1, 0, 0],
      zIndex: 0,
    });

    return {
      id: docId,
      metadata: extractMetadata(parsed.info, parsed.version),
      pages,
      bookmarks: extractBookmarks(parsed.catalog, parsed.objects, parsed.pages.length),
      objectGraph: graph,
      sourceBytes: bytes.byteLength,
    };
  }

  async parsePage(
    bytes: Uint8Array,
    pageIndex: number,
    options: ParseOptions = {},
  ): Promise<RawDocument> {
    return this.parse(bytes, { ...options, pages: [pageIndex] });
  }
}

function extractMetadata(
  info: PdfDict | null,
  version: string,
): RawDocumentMetadata {
  const meta: RawDocumentMetadata = { pdfVersion: version };
  if (!info) return meta;

  // Empty values and generator placeholders such as ReportLab's "(anonymous)"
  // and "(unspecified)" carry no information; leave them out.
  const str = (key: string): string | undefined => {
    const v = info.get(key);
    if (typeof v !== 'string') return undefined;
    const t = v.trim();
    return t === '' || /^\((anonymous|unspecified|unknown|none)\)$/i.test(t) ? undefined : t;
  };

  meta.title = str('Title');
  meta.author = str('Author');
  meta.subject = str('Subject');
  meta.creator = str('Creator');
  meta.producer = str('Producer');
  meta.creationDate = str('CreationDate');
  meta.modificationDate = str('ModDate');
  const keywords = str('Keywords');
  if (keywords) {
    meta.keywords = keywords.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  }
  return meta;
}

function extractBookmarks(
  catalog: PdfDict,
  objects: Map<string, PdfPrimitive>,
  pageCount: number,
): RawBookmark[] {
  const outlinesRef = catalog.getRef('Outlines');
  if (!outlinesRef) return [];
  const outlines = resolve(objects, outlinesRef);
  if (!(outlines instanceof PdfDict)) return [];

  const firstRef = outlines.getRef('First');
  if (!firstRef) return [];

  const walk = (ref: PdfRef | null, depth = 0): RawBookmark[] => {
    if (!ref || depth > 64) return [];
    const node = resolve(objects, ref);
    if (!(node instanceof PdfDict)) return [];

    const title = typeof node.get('Title') === 'string' ? (node.get('Title') as string) : 'Untitled';
    const dest = node.get('Dest') ?? (node.getDict('A')?.get('D') ?? null);
    const pageIndex = resolveDestPageIndex(dest, objects, pageCount);

    const bookmark: RawBookmark = {
      id: createId('bookmark'),
      title,
      pageIndex,
    };

    const firstChild = node.getRef('First');
    if (firstChild) {
      bookmark.children = walk(firstChild, depth + 1);
    }

    const result = [bookmark];
    const next = node.getRef('Next');
    if (next) result.push(...walk(next, depth));
    return result;
  };

  return walk(firstRef);
}

function resolveDestPageIndex(
  dest: PdfPrimitive,
  objects: Map<string, PdfPrimitive>,
  pageCount: number,
): number {
  let d: PdfPrimitive = dest;
  if (d instanceof PdfRef) d = resolve(objects, d);
  // Dest array: [pageRef, /XYZ, ...]
  if (d && typeof d === 'object' && 'items' in d) {
    const arr = d as { items: PdfPrimitive[] };
    const first = arr.items[0];
    if (first instanceof PdfRef) {
      // Best-effort: cannot map ref→index without page list; default 0
      return Math.min(0, pageCount - 1);
    }
  }
  return 0;
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

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
