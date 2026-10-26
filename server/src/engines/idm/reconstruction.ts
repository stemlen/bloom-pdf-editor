import { createId } from '../../utils/id.js';
import type { LayoutDocument, LayoutRegion } from '../layout/types.js';
import type { RawDocument, RawImage, RawPage } from '../parser/raw-model.js';
import { candidatesForRegion, reconstructText } from './text-reconstructor.js';
import {
  IDM_VERSION,
  type Block,
  type BlockType,
  type Hyperlink,
  type IntermediateDocument,
  type Page,
  type Section,
  type TextAlignment,
} from './types.js';

/**
 * Phase 4 — Reconstruct IntermediateDocument from LayoutDocument.
 * Uses RawDocument only as a resource lookup (characters / images / annotations).
 *
 * Does NOT classify headings, detect tables, infer styles, OCR, or export.
 */
export function reconstructDocument(
  layout: LayoutDocument,
  raw: RawDocument,
): IntermediateDocument {
  const rawPages = new Map(raw.pages.map((p) => [p.index, p]));
  const docId = createId('idm');
  const sectionId = createId('section');

  const hyperlinks: Hyperlink[] = [];
  const footnotes: IntermediateDocument['footnotes'] = [];
  const endnotes: IntermediateDocument['endnotes'] = [];

  const sortedLayoutPages = layout.pages
    .slice()
    .sort((a, b) => a.pageIndex - b.pageIndex);

  const pages: Page[] = sortedLayoutPages.map((lp, pageOrd) => {
    const rawPage = rawPages.get(lp.pageIndex);
    return reconstructPage({
      layoutPage: lp,
      rawPage,
      sectionId,
      pageOrd,
      totalPages: sortedLayoutPages.length,
      hyperlinks,
      footnotes,
      endnotes,
    });
  });

  linkLinear(pages);
  for (const p of pages) {
    p.parentId = sectionId;
    p.sectionId = sectionId;
  }

  const section: Section = {
    id: sectionId,
    parentId: docId,
    childIds: pages.map((p) => p.id),
    previousId: null,
    nextId: null,
    pageIndex: pages[0]?.pageIndex ?? 0,
    sectionId,
    readingOrderIndex: 0,
    logicalOrderIndex: 0,
    styleCandidates: [],
    pages,
    breakBefore: 'none',
  };

  // Collect hyperlinks from raw annotations
  for (const rp of raw.pages) {
    for (const ann of rp.annotations) {
      if (ann.uri) {
        hyperlinks.push({
          id: createId('link'),
          uri: ann.uri,
          text: ann.contents ?? undefined,
          pageIndex: rp.index,
          bbox: ann.bbox,
          sourceObjectId: ann.id,
        });
      }
    }
  }

  const doc: IntermediateDocument = {
    id: docId,
    version: IDM_VERSION,
    immutable: true,
    metadata: {
      title: raw.metadata.title,
      author: raw.metadata.author,
      subject: raw.metadata.subject,
      keywords: raw.metadata.keywords,
      creator: raw.metadata.creator,
      producer: raw.metadata.producer,
      creationDate: raw.metadata.creationDate,
      modificationDate: raw.metadata.modificationDate,
      pageCount: pages.length,
    },
    sections: [section],
    bookmarks: raw.bookmarks.map((b) => ({
      id: b.id,
      title: b.title,
      pageIndex: b.pageIndex,
      children: b.children?.map((c) => ({
        id: c.id,
        title: c.title,
        pageIndex: c.pageIndex,
      })),
    })),
    footnotes,
    endnotes,
    hyperlinks,
    nodeIndex: {},
    sourceLayoutId: layout.id,
    sourceRawId: raw.id,
  };

  doc.nodeIndex = buildNodeIndex(doc);
  return Object.freeze(doc) as IntermediateDocument;
}

function reconstructPage(input: {
  layoutPage: LayoutDocument['pages'][number];
  rawPage: RawPage | undefined;
  sectionId: string;
  pageOrd: number;
  totalPages: number;
  hyperlinks: Hyperlink[];
  footnotes: IntermediateDocument['footnotes'];
  endnotes: IntermediateDocument['endnotes'];
}): Page {
  const { layoutPage, rawPage, sectionId, pageOrd, totalPages } = input;
  const pageId = createId('page');

  const orderedRegions = layoutPage.readingOrder.order
    .map((id) => layoutPage.regions.find((r) => r.id === id))
    .filter((r): r is LayoutRegion => r != null);

  // Fallback if reading order empty
  const regions =
    orderedRegions.length > 0
      ? orderedRegions
      : [...layoutPage.regions].sort((a, b) => a.readingOrderIndex - b.readingOrderIndex);

  const headers: Page['headers'] = [];
  const footers: Page['footers'] = [];
  const bodyBlocks: Block[] = [];

  // A body text region often holds several separate layout blocks (headings,
  // paragraphs, table rows). One IDM block per layout block keeps each one's
  // position and style, so exporters can tell headings and table rows apart
  // instead of seeing one page-sized block (BE-507, BE-509).
  const expanded = regions.flatMap((region): LayoutRegion[] => {
    if (region.kind !== 'text_block' || region.blocks.some((b) => b.kind === 'image')) {
      return [region];
    }
    const textBlocks = region.blocks.filter(
      (b) =>
        b.kind === 'text_cluster' ||
        b.kind === 'line' ||
        b.kind === 'word' ||
        (b.text != null && b.text.length > 0),
    );
    if (textBlocks.length < 2) return [region];
    return textBlocks.map((b) => ({
      ...region,
      id: `${region.id}_${b.id}`,
      bbox: b.bbox,
      blocks: [b],
      averageFont: b.style?.fontName ?? region.averageFont,
      averageFontSize: b.style?.fontSize ?? region.averageFontSize,
    }));
  });

  let logical = 0;
  for (const region of expanded) {
    const block = regionToBlock({
      region,
      rawPage,
      pageIndex: layoutPage.pageIndex,
      sectionId,
      parentPageId: pageId,
      readingOrderIndex: region.readingOrderIndex,
      logicalOrderIndex: logical++,
    });

    if (!block) continue;

    if (region.kind === 'header') {
      headers.push({ id: createId('hdr'), blocks: [block] });
      // Keep in body too — single-page contact/name bands are often tagged
      // "header" but must still appear in the main reading order / DOCX body.
      bodyBlocks.push(block);
    } else if (region.kind === 'footer') {
      footers.push({ id: createId('ftr'), blocks: [block] });
    } else if (region.kind === 'footnote') {
      input.footnotes.push({
        id: createId('fn'),
        marker: String(input.footnotes.length + 1),
        blocks: [block],
        pageIndex: layoutPage.pageIndex,
      });
      bodyBlocks.push(block);
    } else if (region.kind === 'endnote') {
      input.endnotes.push({
        id: createId('en'),
        marker: String(input.endnotes.length + 1),
        blocks: [block],
        pageIndex: layoutPage.pageIndex,
      });
      bodyBlocks.push(block);
    } else {
      bodyBlocks.push(block);
    }
  }

  linkLinear(bodyBlocks);
  for (const b of bodyBlocks) {
    b.parentId = pageId;
    b.sectionId = sectionId;
  }

  return {
    id: pageId,
    parentId: sectionId,
    childIds: bodyBlocks.map((b) => b.id),
    previousId: null,
    nextId: null,
    pageIndex: layoutPage.pageIndex,
    sectionId,
    readingOrderIndex: pageOrd,
    logicalOrderIndex: pageOrd,
    bbox: { x: 0, y: 0, width: layoutPage.width, height: layoutPage.height },
    styleCandidates: [],
    index: layoutPage.pageIndex,
    width: layoutPage.width,
    height: layoutPage.height,
    blocks: bodyBlocks,
    headers,
    footers,
    pageBreakAfter: pageOrd < totalPages - 1,
  };
}

function regionToBlock(input: {
  region: LayoutRegion;
  rawPage: RawPage | undefined;
  pageIndex: number;
  sectionId: string;
  parentPageId: string;
  readingOrderIndex: number;
  logicalOrderIndex: number;
}): Block | null {
  const { region, rawPage, pageIndex, sectionId, readingOrderIndex, logicalOrderIndex } = input;
  const blockId = createId('block');
  const blockType = mapRegionToBlockType(region.kind);
  const styleCandidates = candidatesForRegion(region.kind);
  const alignment = region.dominantAlignment as TextAlignment;

  if (blockType === 'image' || region.kind === 'image') {
    return buildImageBlock({
      blockId,
      region,
      rawPage,
      pageIndex,
      sectionId,
      readingOrderIndex,
      logicalOrderIndex,
      styleCandidates,
    });
  }

  const textBlocks = region.blocks.filter(
    (b) =>
      b.kind === 'text_cluster' ||
      b.kind === 'line' ||
      b.kind === 'word' ||
      (b.text != null && b.text.length > 0),
  );

  // Image-only region already handled; empty unknown skip
  if (textBlocks.length === 0 && region.blocks.some((b) => b.kind === 'image')) {
    return buildImageBlock({
      blockId,
      region,
      rawPage,
      pageIndex,
      sectionId,
      readingOrderIndex,
      logicalOrderIndex,
      styleCandidates,
    });
  }

  if (textBlocks.length === 0 && region.kind === 'unknown' && region.blocks.length === 0) {
    return null;
  }

  const reconstructed = reconstructText({
    region,
    blocks: textBlocks.length > 0 ? textBlocks : region.blocks,
    rawPage,
    pageIndex,
    sectionId,
    parentBlockId: blockId,
    readingOrderBase: readingOrderIndex * 1000,
    alignment,
  });

  for (const run of reconstructed.runs) run.parentId = blockId;
  for (const w of reconstructed.words) {
    if (!w.parentId) w.parentId = blockId;
  }
  for (const c of reconstructed.characters) {
    if (!c.parentId || c.parentId === blockId) {
      /* word owns chars */
    }
  }

  const base = {
    id: blockId,
    parentId: input.parentPageId,
    childIds: [
      ...reconstructed.runs.map((r) => r.id),
      ...reconstructed.words.map((w) => w.id),
      ...reconstructed.characters.map((c) => c.id),
    ],
    previousId: null as string | null,
    nextId: null as string | null,
    pageIndex,
    sectionId,
    readingOrderIndex,
    logicalOrderIndex,
    bbox: { ...region.bbox },
    styleCandidates,
    alignment,
    writingDirection: region.writingDirection,
    rotation: region.rotation,
    sourceRegionId: region.id,
    runs: reconstructed.runs,
    words: reconstructed.words,
    characters: reconstructed.characters,
  };

  switch (blockType) {
    case 'title':
      return { ...base, type: 'title' };
    case 'heading':
      return {
        ...base,
        type: 'heading',
        // Candidate only — not a finalized classification
        provisionalLevel: provisionalLevelFromFont(region.averageFontSize),
      };
    case 'caption':
      return { ...base, type: 'caption' };
    case 'sidebar':
      return { ...base, type: 'sidebar' };
    case 'footnote':
      return { ...base, type: 'footnote' };
    case 'endnote':
      return { ...base, type: 'endnote' };
    case 'header':
      return { ...base, type: 'paragraph', styleCandidates: [...styleCandidates] };
    case 'footer':
      return { ...base, type: 'paragraph', styleCandidates: [...styleCandidates] };
    case 'table_placeholder':
      return { ...base, type: 'table_placeholder' };
    case 'list_placeholder':
      return { ...base, type: 'list_placeholder', ordered: false };
    case 'code_block':
      return { ...base, type: 'code_block' };
    case 'quote':
      return { ...base, type: 'quote' };
    case 'unknown':
      return { ...base, type: 'unknown' };
    case 'paragraph':
    default:
      return { ...base, type: 'paragraph' };
  }
}

function buildImageBlock(input: {
  blockId: string;
  region: LayoutRegion;
  rawPage: RawPage | undefined;
  pageIndex: number;
  sectionId: string;
  readingOrderIndex: number;
  logicalOrderIndex: number;
  styleCandidates: Block['styleCandidates'];
}): Block {
  const imgBlock = input.region.blocks.find((b) => b.kind === 'image');
  const rawImg = findRawImage(input.rawPage, imgBlock?.sourceObjectIds ?? []);

  return {
    id: input.blockId,
    type: 'image',
    parentId: null,
    childIds: [],
    previousId: null,
    nextId: null,
    pageIndex: input.pageIndex,
    sectionId: input.sectionId,
    readingOrderIndex: input.readingOrderIndex,
    logicalOrderIndex: input.logicalOrderIndex,
    bbox: { ...input.region.bbox },
    styleCandidates: input.styleCandidates,
    sourceRegionId: input.region.id,
    width: rawImg?.widthPx ?? input.region.bbox.width,
    height: rawImg?.heightPx ?? input.region.bbox.height,
    rotation: rawImg?.rotation ?? input.region.rotation,
    opacity: 1,
    anchorType: 'floating',
    wrappingType: 'square',
    originalResourceId: rawImg?.id ?? imgBlock?.sourceObjectIds[0],
    resourceName: rawImg?.resourceName ?? undefined,
    resolutionDpi: rawImg?.dpi,
    compression: rawImg?.compression,
    colorSpace: rawImg?.colorSpace,
    // Keep data out of default path for memory; attach reference only
    data: undefined,
  };
}

function findRawImage(page: RawPage | undefined, sourceIds: string[]): RawImage | undefined {
  if (!page) return undefined;
  for (const id of sourceIds) {
    const img = page.images.find((i) => i.id === id);
    if (img) return img;
  }
  // Region may wrap image block id differently — first image near region
  return page.images[0];
}

function mapRegionToBlockType(kind: LayoutRegion['kind']): BlockType {
  switch (kind) {
    case 'title':
      return 'title';
    case 'heading':
      return 'heading';
    case 'caption':
      return 'caption';
    case 'image':
      return 'image';
    case 'sidebar':
      return 'sidebar';
    case 'footnote':
      return 'footnote';
    case 'endnote':
      return 'endnote';
    case 'header':
      return 'header';
    case 'footer':
      return 'footer';
    case 'text_block':
      return 'paragraph';
    case 'form_area':
    case 'watermark':
    case 'background':
    case 'margin_note':
    case 'unknown':
    default:
      return 'unknown';
  }
}

function provisionalLevelFromFont(fontSize?: number): 1 | 2 | 3 | undefined {
  if (fontSize == null) return undefined;
  if (fontSize >= 20) return 1;
  if (fontSize >= 16) return 2;
  if (fontSize >= 14) return 3;
  return undefined;
}

function linkLinear<T extends { id: string; previousId: string | null; nextId: string | null }>(
  nodes: T[],
): void {
  for (let i = 0; i < nodes.length; i++) {
    nodes[i]!.previousId = i > 0 ? nodes[i - 1]!.id : null;
    nodes[i]!.nextId = i < nodes.length - 1 ? nodes[i + 1]!.id : null;
  }
}

function buildNodeIndex(doc: IntermediateDocument): IntermediateDocument['nodeIndex'] {
  const index: IntermediateDocument['nodeIndex'] = {};

  for (const section of doc.sections) {
    index[section.id] = { kind: 'section', id: section.id };
    for (const page of section.pages) {
      index[page.id] = { kind: 'page', id: page.id };
      const allBlocks = [
        ...page.blocks,
        ...page.headers.flatMap((h) => h.blocks),
        ...page.footers.flatMap((f) => f.blocks),
      ];
      for (const block of allBlocks) {
        index[block.id] = { kind: 'block', id: block.id };
        if ('runs' in block) {
          for (const run of block.runs) index[run.id] = { kind: 'run', id: run.id };
          for (const word of block.words) index[word.id] = { kind: 'word', id: word.id };
          for (const ch of block.characters) index[ch.id] = { kind: 'character', id: ch.id };
        }
      }
    }
  }
  for (const b of doc.bookmarks) index[b.id] = { kind: 'bookmark', id: b.id };
  for (const f of doc.footnotes) index[f.id] = { kind: 'footnote', id: f.id };
  for (const f of doc.endnotes) index[f.id] = { kind: 'footnote', id: f.id };
  for (const h of doc.hyperlinks) index[h.id] = { kind: 'hyperlink', id: h.id };

  return index;
}
