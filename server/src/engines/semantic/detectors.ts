import type { Block, IntermediateDocument, Run } from '../idm/types.js';
import type { LayoutDocument } from '../layout/types.js';
import type { StyleProfile, TypographyAnalysis } from '../typography/types.js';
import type {
  HeadingLevel,
  ListStyle,
  SemanticCaption,
  SemanticCodeBlock,
  SemanticHeading,
  SemanticImage,
  SemanticList,
  SemanticListItem,
  SemanticNode,
  SemanticParagraph,
  SemanticQuote,
  SemanticRun,
} from './types.js';
import { createId } from '../../utils/id.js';

export interface BlockContext {
  block: Block;
  pageIndex: number;
  pageWidth: number;
  pageHeight: number;
  styleProfile?: StyleProfile;
  bodyMedianFontSize: number;
  layoutNearImage: boolean;
}

const BULLET_RE = /^\s*([•●○▪▸►‣◉*-])\s+/;
const NUMBERED_RE = /^\s*(\d{1,3})[.)]\s+/;
const ALPHA_RE = /^\s*([a-zA-Z])[.)]\s+/;
const ROMAN_RE = /^\s*([ivxlcdmIVXLCDM]{1,6})[.)]\s+/;
const CHECKBOX_RE = /^\s*[\[\(](?:x|X| |_)[\]\)]\s+/;
const HYPHEN_BREAK_RE = /([A-Za-z]{2,})-\s*$/;

/**
 * Block text with a newline wherever consecutive runs sit on different
 * baselines, so reconstructParagraphText can re-join soft wraps with a space
 * (or remove a wrap hyphen) exactly like the plain-text export.
 */
export function blockPlainText(block: Block): string {
  if (!('runs' in block)) return '';
  let out = '';
  let prev: Run | undefined;
  for (const r of block.runs) {
    if (prev && startsNewLine(prev, r) && !/\s$/.test(out) && !/^\s/.test(r.text)) out += '\n';
    out += r.text;
    prev = r;
  }
  return out;
}

function startsNewLine(prev: Run, next: Run): boolean {
  const a = prev.bbox;
  const b = next.bbox;
  if (!a || !b) return false;
  const tolerance = Math.max(1, Math.min(a.height, b.height) * 0.5);
  return Math.abs(a.y - b.y) > tolerance;
}

export function toSemanticRuns(block: Block, styleProfileId?: string): SemanticRun[] {
  if (!('runs' in block)) return [];
  return block.runs.map((r: Run) => ({
    id: r.id,
    text: r.text,
    bold: r.bold,
    italic: r.italic,
    underline: r.underline,
    fontName: r.fontName,
    fontSize: r.fontSize,
    color: r.color,
    link: r.link,
    styleProfileId,
  }));
}

/** Merge soft line breaks / hyphenation into paragraph text. */
export function reconstructParagraphText(raw: string): string {
  const lines = raw.split(/\n/);
  if (lines.length <= 1) return raw.trim();

  let out = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trimEnd();
    const next = lines[i + 1];
    if (!next) {
      out += line;
      break;
    }
    const m = line.match(HYPHEN_BREAK_RE);
    // Never hyphen-merge into a structural next line (bullet / heading-like)
    if (m && !isStructuralLine(next) && !isStructuralLine(line)) {
      out += line.replace(/-\s*$/, '') + next.trimStart();
      i++;
      continue;
    }
    // Keep intentional structure: bullets, short label lines, sentence endings
    if (
      /[.!?:;]$/.test(line.trim()) ||
      line.trim() === '' ||
      isStructuralLine(line) ||
      isStructuralLine(next)
    ) {
      out += line + '\n';
    } else {
      out += line.replace(/\s+$/, '') + ' ' + next.trimStart();
      i++;
    }
  }
  return out.replace(/[ \t]+\n/g, '\n').trim();
}

/** Lines that must not be soft-wrapped into neighbors (lists, short headers, contact rows). */
function isStructuralLine(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  if (matchListPrefix(t)) return true;
  if (/^[•●○▪▸►‣◉]/.test(t)) return true;
  // Short all-caps section headers
  if (t.length <= 48 && /[A-Z]/.test(t) && t === t.toUpperCase() && /[A-Z]{3,}/.test(t)) return true;
  // "Label:" rows (Personal Achievements:, Technical Skills:, …) — length uncapped
  if (/^[A-Z][A-Za-z0-9 /&()-]{1,40}:/.test(t)) return true;
  return false;
}

function matchListPrefix(text: string): {
  listStyle: ListStyle;
  marker: string;
  ordered: boolean;
  cleaned: string;
} | null {
  const t = text.trim();
  if (!t) return null;

  if (CHECKBOX_RE.test(t)) {
    return {
      listStyle: 'checkbox',
      marker: t.match(CHECKBOX_RE)?.[0]?.trim() ?? '',
      ordered: false,
      cleaned: t.replace(CHECKBOX_RE, '').trim(),
    };
  }
  if (BULLET_RE.test(t)) {
    return {
      listStyle: 'bullet',
      marker: t.match(BULLET_RE)?.[1] ?? '•',
      ordered: false,
      cleaned: t.replace(BULLET_RE, '').trim(),
    };
  }
  if (NUMBERED_RE.test(t)) {
    return {
      listStyle: 'numbered',
      marker: t.match(NUMBERED_RE)?.[1] ?? '',
      ordered: true,
      cleaned: t.replace(NUMBERED_RE, '').trim(),
    };
  }
  if (ROMAN_RE.test(t) && t.length < 200) {
    return {
      listStyle: 'roman',
      marker: t.match(ROMAN_RE)?.[1] ?? '',
      ordered: true,
      cleaned: t.replace(ROMAN_RE, '').trim(),
    };
  }
  if (ALPHA_RE.test(t) && t.length < 200) {
    return {
      listStyle: 'alphabetic',
      marker: t.match(ALPHA_RE)?.[1] ?? '',
      ordered: true,
      cleaned: t.replace(ALPHA_RE, '').trim(),
    };
  }
  return null;
}

/** Split a block's runs line-by-line so each line gets its exact run slice. */
function splitBlockRunsByLine(block: Block, styleProfileId?: string): SemanticRun[][] {
  const semanticRuns = toSemanticRuns(block, styleProfileId);
  if (semanticRuns.length === 0) return [];

  const lineRunsList: SemanticRun[][] = [];
  let currentLineRuns: SemanticRun[] = [];

  for (const r of semanticRuns) {
    if (!r.text) continue;
    if (!r.text.includes('\n')) {
      currentLineRuns.push({ ...r });
    } else {
      const parts = r.text.split('\n');
      for (let pIdx = 0; pIdx < parts.length; pIdx++) {
        const partText = parts[pIdx]!;
        if (pIdx > 0) {
          lineRunsList.push(currentLineRuns);
          currentLineRuns = [];
        }
        if (partText.length > 0) {
          currentLineRuns.push({ ...r, text: partText });
        }
      }
    }
  }
  if (currentLineRuns.length > 0) {
    lineRunsList.push(currentLineRuns);
  }

  return lineRunsList;
}

/** Strip bullet/number marker from the start of a single line's runs. */
function stripMarkerFromRunArray(rawRuns: SemanticRun[]): SemanticRun[] {
  if (rawRuns.length === 0) return [];
  const runs = rawRuns.map((r) => ({ ...r }));
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i]!;
    if (!r.text) continue;
    let text = r.text;
    if (i === 0) {
      text = text.replace(
        /^\s*([\u2022\u25CF\u25CB\u25AA\u25B8\u25BA\u2023\u25C9*-]|\d{1,3}[.)]|[a-zA-Z][.)]|[ivxlcdmIVXLCDM]{1,6}[.)])\s*/,
        '',
      );
    } else {
      text = text.trimStart();
    }
    r.text = text;
    if (r.text.length > 0) {
      const result = runs.slice(i);
      result[0] = r;
      return result;
    }
  }
  return runs.filter((r) => r.text.length > 0);
}

export function detectList(ctx: BlockContext): SemanticList | null {
  const text = blockPlainText(ctx.block).trim();
  if (!text) return null;

  // Support single-line markers and multi-line blocks where each line is an item
  const lines = text.includes('\n')
    ? text.split(/\n/).map((l) => l.trim()).filter(Boolean)
    : [text];

  const parsed = lines.map(matchListPrefix);
  if (!parsed[0] || parsed.some((p) => !p)) {
    // Also accept "- " / "* " glued without newline (rare)
    if (!parsed[0]) return null;
  }

  const first = parsed[0]!;
  const listId = createId('slist');
  const indent = ctx.block.bbox?.x ?? 0;
  const level = Math.max(0, Math.floor(indent / 36));
  const items: SemanticListItem[] = [];

  const itemLines = parsed.every((p) => p != null) ? parsed : [first];
  const blockLineRuns = splitBlockRunsByLine(ctx.block, ctx.styleProfile?.id);

  for (let i = 0; i < itemLines.length; i++) {
    const p = itemLines[i]!;
    if (!p) continue;
    const itemId = createId('sitem');
    const lineRuns = blockLineRuns[i] ?? [];
    const preservedRuns = stripMarkerFromRunArray(lineRuns);
    const item: SemanticListItem = {
      id: itemId,
      type: 'list_item',
      parentId: listId,
      childIds: [],
      readingOrderIndex: ctx.block.readingOrderIndex + i * 0.01,
      confidence: 0.8,
      pageIndex: ctx.pageIndex,
      bbox: ctx.block.bbox,
      sourceBlockIds: [ctx.block.id],
      styleProfileId: ctx.styleProfile?.id,
      runs: preservedRuns.length > 0
        ? preservedRuns
        : [{ id: createId('srun'), text: p.cleaned, styleProfileId: ctx.styleProfile?.id }],
      text: p.cleaned,
      level,
      marker: p.marker,
    };
    items.push(item);
  }

  if (items.length === 0) return null;

  return {
    id: listId,
    type: 'list',
    parentId: null,
    childIds: items.map((i) => i.id),
    readingOrderIndex: ctx.block.readingOrderIndex,
    confidence: 0.8,
    pageIndex: ctx.pageIndex,
    bbox: ctx.block.bbox,
    sourceBlockIds: [ctx.block.id],
    styleProfileId: ctx.styleProfile?.id,
    listStyle: first.listStyle,
    ordered: first.ordered,
    items,
  };
}

export function detectHeading(ctx: BlockContext): SemanticHeading | null {
  if (ctx.block.type === 'image') return null;
  const text = reconstructParagraphText(blockPlainText(ctx.block));
  if (!text || text.length > 200) return null;
  // Table column header rows / field labels — not section headings
  if (isTableHeaderRow(text)) return null;

  const fontSize =
    ctx.styleProfile?.features.fontSize ??
    ('runs' in ctx.block ? ctx.block.runs[0]?.fontSize : undefined) ??
    12;
  const firstRun = 'runs' in ctx.block ? ctx.block.runs.find((r) => r.text.trim()) : undefined;
  const bold =
    ctx.styleProfile?.features.bold ??
    (firstRun?.bold === true || (firstRun?.fontWeight ?? 400) >= 600);
  const alignment = ctx.styleProfile?.features.alignment ?? ctx.block.alignment ?? 'left';

  // Title: large, near top, short
  const topBand =
    ctx.block.bbox != null
      ? (ctx.pageHeight - (ctx.block.bbox.y + ctx.block.bbox.height)) / ctx.pageHeight
      : 1;

  const sizeRatio = fontSize / Math.max(ctx.bodyMedianFontSize, 1);
  // "Technical Skills: …" / "Personal Achievements:" are labels, not headings,
  // unless set clearly larger than body text ("Chapter 1: Introduction").
  if (/^[A-Z][^:\n]{1,40}:/.test(text.trim()) && sizeRatio < 1.25) return null;

  if (
    (ctx.block.type === 'title' || (sizeRatio >= 1.6 && topBand <= 0.25 && text.length < 120)) &&
    !detectList(ctx)
  ) {
    return makeHeading(ctx, 'title', 1, text, 0.85);
  }

  if (ctx.block.type === 'heading' || (sizeRatio >= 1.25 && (bold || sizeRatio >= 1.4))) {
    const level = headingLevelFromRatio(sizeRatio);
    if (topBand <= 0.2 && sizeRatio >= 1.35 && alignment === 'center' && text.length < 80) {
      return makeHeading(ctx, 'subtitle', Math.min(2, level) as HeadingLevel, text, 0.7);
    }
    return makeHeading(ctx, 'heading', level, text, 0.75 + Math.min(0.15, (sizeRatio - 1) * 0.1));
  }

  // Style-profile based: significantly larger than body
  if (sizeRatio >= 1.35 && text.split(/\s+/).length <= 12 && !/[.!?]$/.test(text)) {
    return makeHeading(ctx, 'heading', headingLevelFromRatio(sizeRatio), text, 0.65);
  }

  return null;
}

function isTableHeaderRow(text: string): boolean {
  const t = text.trim();
  if (/\bCourse\b/i.test(t) && /\bYear\b/i.test(t)) return true;
  if (/\bInstitution\b/i.test(t) && /\bRemarks?\b/i.test(t)) return true;
  return false;
}

function makeHeading(
  ctx: BlockContext,
  type: 'title' | 'subtitle' | 'heading',
  level: HeadingLevel,
  text: string,
  confidence: number,
): SemanticHeading {
  return {
    id: createId('sh'),
    type,
    level,
    parentId: null,
    childIds: [],
    readingOrderIndex: ctx.block.readingOrderIndex,
    confidence,
    pageIndex: ctx.pageIndex,
    bbox: ctx.block.bbox,
    sourceBlockIds: [ctx.block.id],
    styleProfileId: ctx.styleProfile?.id,
    runs: toSemanticRuns(ctx.block, ctx.styleProfile?.id),
    text,
    alignment: type === 'title' ? (ctx.block.alignment ?? 'center') : 'left',
  };
}

function headingLevelFromRatio(ratio: number): HeadingLevel {
  if (ratio >= 1.8) return 1;
  if (ratio >= 1.55) return 2;
  if (ratio >= 1.4) return 3;
  if (ratio >= 1.3) return 4;
  if (ratio >= 1.2) return 5;
  return 6;
}

export function detectCaption(ctx: BlockContext): SemanticCaption | null {
  if (ctx.block.type === 'caption') {
    return makeCaption(ctx, 0.9);
  }
  const text = reconstructParagraphText(blockPlainText(ctx.block));
  if (!text || text.length > 180) return null;

  const fontSize = ctx.styleProfile?.features.fontSize ?? 12;
  const looksLikeCaption =
    ctx.layoutNearImage &&
    fontSize <= ctx.bodyMedianFontSize * 0.95 &&
    (/^(figure|fig\.|table|tbl\.|chart|image)\b/i.test(text) || text.length < 100);

  if (looksLikeCaption || (ctx.block.styleCandidates.includes('Possible Caption') && ctx.layoutNearImage)) {
    return makeCaption(ctx, 0.75);
  }
  return null;
}

function makeCaption(ctx: BlockContext, confidence: number): SemanticCaption {
  const text = reconstructParagraphText(blockPlainText(ctx.block));
  return {
    id: createId('scap'),
    type: 'caption',
    parentId: null,
    childIds: [],
    readingOrderIndex: ctx.block.readingOrderIndex,
    confidence,
    pageIndex: ctx.pageIndex,
    bbox: ctx.block.bbox,
    sourceBlockIds: [ctx.block.id],
    styleProfileId: ctx.styleProfile?.id,
    runs: toSemanticRuns(ctx.block, ctx.styleProfile?.id),
    text,
  };
}

export function detectQuote(ctx: BlockContext): SemanticQuote | null {
  if (ctx.block.type === 'quote') return makeQuote(ctx, 0.9);
  const text = reconstructParagraphText(blockPlainText(ctx.block));
  if (!text) return null;

  const indent = ctx.block.bbox?.x ?? 0;
  const indented = indent > ctx.pageWidth * 0.12;
  const italic = ctx.styleProfile?.features.italic ?? false;
  const quoted = /^[“"']/.test(text.trim()) && /[”"']$/.test(text.trim());

  if (ctx.block.styleCandidates.includes('Possible Quote') || (indented && (italic || quoted))) {
    return makeQuote(ctx, quoted ? 0.8 : 0.65);
  }
  return null;
}

function makeQuote(ctx: BlockContext, confidence: number): SemanticQuote {
  const text = reconstructParagraphText(blockPlainText(ctx.block));
  return {
    id: createId('sq'),
    type: 'quote',
    parentId: null,
    childIds: [],
    readingOrderIndex: ctx.block.readingOrderIndex,
    confidence,
    pageIndex: ctx.pageIndex,
    bbox: ctx.block.bbox,
    sourceBlockIds: [ctx.block.id],
    styleProfileId: ctx.styleProfile?.id,
    runs: toSemanticRuns(ctx.block, ctx.styleProfile?.id),
    text,
  };
}

const MONO_FONTS = /mono|courier|consolas|menlo|monaco|source code|dejavu sans mono|lucida console/i;

export function detectCodeBlock(ctx: BlockContext): SemanticCodeBlock | null {
  if (ctx.block.type === 'code_block') return makeCode(ctx, 0.9);
  const text = blockPlainText(ctx.block);
  if (!text || text.length < 4) return null;

  const font = ctx.styleProfile?.features.fontFamily ?? '';
  const mono = MONO_FONTS.test(font);
  const codey =
    /[{};=<>]|function\s|const\s|let\s|var\s|def\s|class\s|import\s|#include|console\.|\$\s/.test(
      text,
    );

  if (mono || (codey && text.includes('\n'))) {
    return makeCode(ctx, mono ? 0.85 : 0.7);
  }
  if (ctx.block.styleCandidates.includes('Possible Code')) {
    return makeCode(ctx, 0.6);
  }
  return null;
}

function makeCode(ctx: BlockContext, confidence: number): SemanticCodeBlock {
  return {
    id: createId('scode'),
    type: 'code_block',
    parentId: null,
    childIds: [],
    readingOrderIndex: ctx.block.readingOrderIndex,
    confidence,
    pageIndex: ctx.pageIndex,
    bbox: ctx.block.bbox,
    sourceBlockIds: [ctx.block.id],
    styleProfileId: ctx.styleProfile?.id,
    runs: toSemanticRuns(ctx.block, ctx.styleProfile?.id),
    text: blockPlainText(ctx.block),
  };
}

export function detectImage(ctx: BlockContext): SemanticImage | null {
  if (ctx.block.type !== 'image') return null;
  const img = ctx.block;
  return {
    id: createId('simg'),
    type: 'image',
    parentId: null,
    childIds: [],
    readingOrderIndex: img.readingOrderIndex,
    confidence: 0.95,
    pageIndex: ctx.pageIndex,
    bbox: img.bbox,
    sourceBlockIds: [img.id],
    width: img.width,
    height: img.height,
    alt: img.alt,
    resourceId: img.originalResourceId,
  };
}

export function makeParagraph(ctx: BlockContext): SemanticParagraph {
  const text = reconstructParagraphText(blockPlainText(ctx.block));
  // Prefer left for long body blocks wrongly tagged center/mixed from full-page regions
  const alignment =
    ctx.block.alignment === 'center' && text.length > 120 ? 'left' : ctx.block.alignment;
  return {
    id: createId('sp'),
    type: 'paragraph',
    parentId: null,
    childIds: [],
    readingOrderIndex: ctx.block.readingOrderIndex,
    confidence: 0.8,
    pageIndex: ctx.pageIndex,
    bbox: ctx.block.bbox,
    sourceBlockIds: [ctx.block.id],
    styleProfileId: ctx.styleProfile?.id,
    runs: toSemanticRuns(ctx.block, ctx.styleProfile?.id),
    text,
    alignment,
    writingDirection: ctx.block.writingDirection,
  };
}

/**
 * Split multi-line IDM blocks into separate semantic nodes (paragraphs / lists /
 * headings) so resume-style documents don't collapse into one wall of text.
 */
export function expandAndClassifyBlock(
  ctx: BlockContext,
  classifyOne: (ctx: BlockContext) => SemanticNode,
): SemanticNode[] {
  if (ctx.block.type === 'image' || !('runs' in ctx.block)) {
    return [classifyOne(ctx)];
  }

  const raw = blockPlainText(ctx.block);
  const trimmedLines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  if (trimmedLines.length <= 1) {
    return [classifyOne(ctx)];
  }

  // Pure list block → keep as one list
  const parsedAll = trimmedLines.map(matchListPrefix);
  if (parsedAll.length > 0 && parsedAll.every((p) => p != null)) {
    const list = detectList(ctx);
    return list ? [list] : [classifyOne(ctx)];
  }

  // Collapse PDF soft-wraps / hyphenation first so wrapped bullets don't become
  // orphan fragments like "ing cost-saving…" after per-line expand.
  const lineSlices = mergeSoftWrappedLines(splitBlockIntoLines(ctx));
  if (lineSlices.length <= 1) {
    return [classifyOne(ctxFromLineSlices(ctx, lineSlices, 0))];
  }

  const nodes: SemanticNode[] = [];
  let i = 0;
  while (i < lineSlices.length) {
    const slice = lineSlices[i]!;
    if (matchListPrefix(slice.text)) {
      const group = [slice];
      while (
        i + group.length < lineSlices.length &&
        matchListPrefix(lineSlices[i + group.length]!.text)
      ) {
        group.push(lineSlices[i + group.length]!);
      }
      const listCtx = ctxFromLineSlices(ctx, group, i);
      const listNode = detectList(listCtx);
      if (listNode) nodes.push(listNode);
      else {
        for (let g = 0; g < group.length; g++) {
          nodes.push(classifyOne(ctxFromLineSlices(ctx, [group[g]!], i + g)));
        }
      }
      i += group.length;
      continue;
    }

    // "Personal Achievements: First item text" → label + first list item
    const labeled = splitInlineLabelContent(slice.text);
    if (labeled) {
      const labelSlice = {
        text: labeled.label,
        runs: [
          {
            ...(slice.runs[0]!),
            id: createId('run'),
            text: labeled.label,
            wordIds: [] as string[],
            characterIds: [] as string[],
          },
        ],
      };
      nodes.push(classifyOne(ctxFromLineSlices(ctx, [labelSlice], i)));

      const contentSlice = {
        text: labeled.content,
        runs: [
          {
            ...(slice.runs[slice.runs.length - 1] ?? slice.runs[0]!),
            id: createId('run'),
            text: labeled.content,
            wordIds: [] as string[],
            characterIds: [] as string[],
          },
        ],
      };
      // If following lines are bullets, fold content in as the first list item
      if (i + 1 < lineSlices.length && matchListPrefix(lineSlices[i + 1]!.text)) {
        const group = [contentSlice];
        let j = i + 1;
        while (j < lineSlices.length && matchListPrefix(lineSlices[j]!.text)) {
          group.push(lineSlices[j]!);
          j++;
        }
        // Prefix content as a bullet so detectList accepts every line
        const bulletPrefixed = group.map((g, idx) =>
          idx === 0 && !matchListPrefix(g.text)
            ? {
                text: `• ${g.text}`,
                runs: [
                  {
                    ...(g.runs[0]!),
                    id: createId('run'),
                    text: `• ${g.text}`,
                    wordIds: [] as string[],
                    characterIds: [] as string[],
                  },
                ],
              }
            : g,
        );
        const listNode = detectList(ctxFromLineSlices(ctx, bulletPrefixed, i));
        if (listNode) nodes.push(listNode);
        else nodes.push(classifyOne(ctxFromLineSlices(ctx, [contentSlice], i)));
        i = j;
        continue;
      }
      nodes.push(classifyOne(ctxFromLineSlices(ctx, [contentSlice], i)));
      i++;
      continue;
    }

    nodes.push(classifyOne(ctxFromLineSlices(ctx, [slice], i)));
    i++;
  }

  return nodes.length > 0 ? nodes : [classifyOne(ctx)];
}

/** Re-join PDF wrapped continuations; keep bullets / headers / sentence breaks. */
function mergeSoftWrappedLines(
  slices: Array<{ text: string; runs: Run[] }>,
): Array<{ text: string; runs: Run[] }> {
  if (slices.length <= 1) return slices;
  const out: Array<{ text: string; runs: Run[] }> = [];

  for (const slice of slices) {
    const prev = out[out.length - 1];
    if (!prev || !shouldSoftJoinLines(prev.text, slice.text)) {
      out.push({ text: slice.text, runs: [...slice.runs] });
      continue;
    }

    const hyphen = HYPHEN_BREAK_RE.test(prev.text.trimEnd());
    const joinedText = hyphen
      ? prev.text.replace(/-\s*$/, '') + slice.text.trimStart()
      : prev.text.replace(/\s+$/, '') + ' ' + slice.text.trimStart();

    let joinedRuns: Run[];
    if (hyphen) {
      joinedRuns = [...stripTrailingHyphenFromRuns(prev.runs), ...slice.runs];
    } else {
      const spacer: Run = {
        ...(prev.runs[prev.runs.length - 1] ?? slice.runs[0]!),
        id: createId('run'),
        text: ' ',
        wordIds: [],
        characterIds: [],
      };
      joinedRuns = [...prev.runs, spacer, ...slice.runs];
    }
    out[out.length - 1] = { text: joinedText, runs: joinedRuns };
  }
  return out;
}

function shouldSoftJoinLines(prev: string, next: string): boolean {
  const a = prev.trimEnd();
  const b = next.trim();
  if (!a || !b) return false;
  // Never join into a new bullet / header / label line
  if (isStructuralLine(b) || matchListPrefix(b)) return false;
  // Finished sentence → keep the break
  if (/[.!?:;]$/.test(a.trim())) return false;
  if (HYPHEN_BREAK_RE.test(a)) return true;
  // Wrapped continuation usually starts lowercase / comma
  if (/^[a-z,;]/.test(b)) return true;
  // Long body line wrapped onto another capitalized fragment — but never
  // across a new labeled section (Title Case words + colon handled above).
  if (a.length > 55 && b.length > 20 && !/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+:/.test(b)) return true;
  return false;
}

/**
 * Split "Personal Achievements: First achievement text" into label + content.
 * Keeps inline skill rows like "Technical Skills: Excel • Word" intact.
 */
function splitInlineLabelContent(text: string): { label: string; content: string } | null {
  const m = text.trim().match(/^([A-Z][A-Za-z0-9 /&()-]{1,40}:)\s+(.+)$/);
  if (!m) return null;
  const label = m[1]!.trim();
  const content = m[2]!.trim();
  if (content.length < 20) return null;
  if (/Technical Skills/i.test(label)) return null;
  if (/[•·]/.test(content)) return null;
  return { label, content };
}

function stripTrailingHyphenFromRuns(runs: Run[]): Run[] {
  if (runs.length === 0) return runs;
  const copy = runs.map((r) => ({ ...r, wordIds: [...r.wordIds], characterIds: [...r.characterIds] }));
  for (let i = copy.length - 1; i >= 0; i--) {
    const r = copy[i]!;
    if (!r.text) continue;
    if (r.text.endsWith('-')) {
      copy[i] = { ...r, text: r.text.replace(/-\s*$/, '') };
      break;
    }
    if (r.text.trim().length > 0) break;
  }
  return copy.filter((r) => r.text.length > 0);
}

function splitBlockIntoLines(
  ctx: BlockContext,
): Array<{ text: string; runs: Run[] }> {
  const block = ctx.block;
  if (!('runs' in block)) return [];
  const lines: Array<{ text: string; runs: Run[] }> = [];
  let runs: Run[] = [];
  let text = '';

  const flush = () => {
    if (text.trim().length === 0 && runs.length === 0) {
      runs = [];
      text = '';
      return;
    }
    lines.push({ text: text.trimEnd(), runs });
    runs = [];
    text = '';
  };

  for (const run of block.runs) {
    const parts = run.text.split('\n');
    for (let pi = 0; pi < parts.length; pi++) {
      if (pi > 0) flush();
      const part = parts[pi]!;
      if (!part) continue;
      runs.push({
        ...run,
        id: createId('run'),
        text: part,
        wordIds: [],
        characterIds: [],
      });
      text += part;
    }
  }
  flush();
  return lines.filter((l) => l.text.trim().length > 0);
}

function ctxFromLineSlices(
  ctx: BlockContext,
  slices: Array<{ text: string; runs: Run[] }>,
  ord: number,
): BlockContext {
  const runs: Run[] = [];
  for (let s = 0; s < slices.length; s++) {
    if (s > 0) {
      const prev = slices[s - 1]!.runs[0] ?? slices[s]!.runs[0]!;
      runs.push({
        ...prev,
        id: createId('run'),
        text: '\n',
        wordIds: [],
        characterIds: [],
      });
    }
    runs.push(...slices[s]!.runs);
  }
  const joinedText = slices.map((s) => s.text).join('\n');
  const block = {
    ...ctx.block,
    id: `${ctx.block.id}_L${ord}`,
    readingOrderIndex: ctx.block.readingOrderIndex + ord * 0.001,
    // Full-page regions often report center; body/job lines should be left.
    alignment:
      ctx.block.alignment === 'center' &&
      !/@/.test(joinedText) &&
      !(joinedText.length <= 40 && joinedText === joinedText.toUpperCase())
        ? 'left'
        : ctx.block.alignment,
    bbox: unionRunBounds(slices.flatMap((s) => s.runs)) ?? ctx.block.bbox,
    runs,
  } as Block;
  // The block's style profile describes its first line; a line split out of a
  // mixed block (heading + body) must be judged by its own runs.
  const own = runs.find((r) => r.text.trim() && r.fontSize);
  const first = 'runs' in ctx.block ? ctx.block.runs.find((r) => r.text.trim() && r.fontSize) : undefined;
  const sameStyle = own && first && own.fontSize === first.fontSize && own.fontName === first.fontName;
  return { ...ctx, block, styleProfile: sameStyle ? ctx.styleProfile : undefined };
}

/** Bounds of the given runs, so a line split from a page-sized block keeps its own position. */
function unionRunBounds(runs: Run[]): Block['bbox'] | undefined {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of runs) {
    const b = r.bbox;
    if (!b || r.text === '\n' || !(b.width > 0 || b.height > 0)) continue;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  if (!Number.isFinite(minX)) return undefined;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function bodyMedianFontSize(idm: IntermediateDocument, analysis: TypographyAnalysis): number {
  // Body size is the size most of the text is set in, weighted by length;
  // the typography profiles sample one style per block and over-count headings.
  const weight = new Map<number, number>();
  for (const page of idm.sections.flatMap((s) => s.pages)) {
    for (const b of page.blocks) {
      if (!('runs' in b)) continue;
      for (const r of b.runs) {
        if (!r.fontSize || !r.text.trim()) continue;
        weight.set(r.fontSize, (weight.get(r.fontSize) ?? 0) + r.text.trim().length);
      }
    }
  }
  if (weight.size > 1) {
    return [...weight.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  }
  const sizes = analysis.statistics.dominantFontSizes;
  if (sizes[0]) return sizes[0].size;
  const samples: number[] = [];
  for (const page of idm.sections.flatMap((s) => s.pages)) {
    for (const b of page.blocks) {
      if ('runs' in b && b.runs[0]?.fontSize) samples.push(b.runs[0].fontSize);
    }
  }
  if (samples.length === 0) return 12;
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)]!;
}

export function isNearImage(
  block: Block,
  layout: LayoutDocument | null | undefined,
  pageIndex: number,
): boolean {
  if (!layout || !block.bbox) return block.styleCandidates.includes('Possible Caption');
  const page = layout.pages.find((p) => p.pageIndex === pageIndex);
  if (!page) return false;
  const images = page.regions.filter((r) => r.kind === 'image');
  for (const img of images) {
    const gap =
      block.bbox.y > img.bbox.y + img.bbox.height
        ? block.bbox.y - (img.bbox.y + img.bbox.height)
        : img.bbox.y - (block.bbox.y + block.bbox.height);
    const xOverlap =
      Math.min(block.bbox.x + block.bbox.width, img.bbox.x + img.bbox.width) -
      Math.max(block.bbox.x, img.bbox.x);
    if (gap >= 0 && gap < 56 && xOverlap > 0) return true;
  }
  return false;
}
