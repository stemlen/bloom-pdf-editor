import type { UnifiedDocumentModel } from '../../../udm/types.js';
import { esc, paragraph, runText } from '../ooxml/xml.js';
import { firstRunColor, isNearBlack, pickAccentColors } from '../utils/colors.js';
import {
  isEducationHeaderRow,
  isSectionTitleLine,
  looksLikeContactLine,
  looksLikeEducationDataRow,
  splitLabelWithInlineBullets,
  splitTitleAndDate,
} from '../utils/heuristics.js';
import {
  contentRightTabTwips,
  mapAlign,
  styleForType,
  twipsFromPts,
} from '../utils/layout.js';
import { listParagraph, runsFromNode, sanitizeBookmarkName } from '../utils/runs.js';
import {
  buildFooter,
  buildFootnotes,
  buildHeader,
  buildSectPr,
  horizontalRule,
} from './sections.js';
import { writeEducationTable, writeTable } from './tables.js';
import {
  constrainToPageWidth,
  emuFromPx,
  extensionFromMime,
  writeInlineImage,
} from './image-writer.js';

export interface DocumentWriteResult {
  documentXml: string;
  headerXml: string | null;
  footerXml: string | null;
  footnotesXml: string | null;
  rels: Array<{ id: string; type: string; target: string; targetMode?: string }>;
  media: Array<{ name: string; data: Uint8Array; contentType: string }>;
}

/**
 * Resolve typography profile for a semantic node's source block to get
 * indentation / line height / etc. from the original PDF.
 */
function resolveBlockIndent(
  udm: UnifiedDocumentModel,
  node: { sourceBlockIds?: string[] },
): { left?: number; firstLine?: number } | undefined {
  if (!udm.typography?.typographyMap?.blockToProfile) return undefined;
  const blockId = (node.sourceBlockIds ?? [])[0];
  if (!blockId) return undefined;
  const profileId = udm.typography.typographyMap.blockToProfile[blockId];
  if (!profileId) return undefined;
  const profile = udm.typography.profiles.find((p) => p.id === profileId);
  if (!profile) return undefined;
  const feats = profile.features;
  const leftTwips = feats.leftIndent > 2 ? Math.round(feats.leftIndent * 20) : undefined;
  const firstLineTwips =
    feats.firstLineIndent > 2 ? Math.round(feats.firstLineIndent * 20) : undefined;
  if (!leftTwips && !firstLineTwips) return undefined;
  return { left: leftTwips, firstLine: firstLineTwips };
}

/** Resolve image from UDM imageStore via semantic node resourceId or IDM block originalResourceId. */
function resolveImageData(
  udm: UnifiedDocumentModel,
  node: { resourceId?: string; sourceBlockIds?: string[] },
): { data: Uint8Array; mimeType: string; widthPx: number; heightPx: number } | null {
  const store = udm.imageStore;
  if (!store || store.size === 0) return null;

  // Try direct resourceId lookup
  if (node.resourceId && store.has(node.resourceId)) {
    return store.get(node.resourceId)!;
  }

  // Try IDM block originalResourceId lookup
  for (const blockId of node.sourceBlockIds ?? []) {
    // Walk IDM pages to find image block
    for (const section of udm.idm.sections) {
      for (const page of section.pages) {
        for (const block of page.blocks) {
          if (block.id === blockId && block.type === 'image') {
            const imgBlock = block as { originalResourceId?: string; resourceName?: string };
            if (imgBlock.originalResourceId && store.has(imgBlock.originalResourceId)) {
              return store.get(imgBlock.originalResourceId)!;
            }
            if (imgBlock.resourceName && store.has(imgBlock.resourceName)) {
              return store.get(imgBlock.resourceName)!;
            }
          }
        }
      }
    }
  }

  // Last resort: try first entry if only one image in store
  if (store.size === 1) {
    return store.values().next().value ?? null;
  }

  return null;
}

/**
 * Build page break tracking: set of first semantic node IDs per page
 * (except the very first page).
 */
function buildPageBreakSet(udm: UnifiedDocumentModel): Set<string> {
  const breaks = new Set<string>();
  const readingOrder = udm.semantic.readingOrder;
  if (readingOrder.length === 0) return breaks;

  // Collect page-index boundaries from semantic nodes
  let prevPage = -1;
  for (const nodeId of readingOrder) {
    const node = udm.semantic.nodes[nodeId];
    if (!node) continue;
    const page = node.pageIndex;
    if (page > prevPage && prevPage >= 0) {
      // First node on a new page → page break before
      breaks.add(nodeId);
    }
    prevPage = page;
  }
  return breaks;
}

/** Map UDM → word/document.xml body (no PDF access). */
export function writeDocument(udm: UnifiedDocumentModel): DocumentWriteResult {
  const body: string[] = [];
  const rels: DocumentWriteResult['rels'] = [];
  const media: DocumentWriteResult['media'] = [];
  let relSeq = 10;
  const nextRid = () => `rId${relSeq++}`;
  let docPrSeq = 1;
  const nextDocPrId = () => docPrSeq++;

  const tableById = new Map(udm.tables.map((t) => [t.id, t]));
  const emittedTables = new Set<string>();

  // Bookmarks from structure
  const bookmarks = udm.structure?.bookmarks ?? [];
  let bookmarkId = 0;

  const accent = pickAccentColors(udm);
  const contentRightTwips = contentRightTabTwips(udm);
  // Section/contact rules: use detected PDF accent when present, else black (no invented theme).
  const sectionRuleColor = accent.border.replace(/^#/, '');
  const contactRuleColor = accent.border.replace(/^#/, '');
  const SECTION_RULE_SZ = 8; // 1pt — original section lines are thin
  const CONTACT_RULE_SZ = 24; // 3pt — original contact rule is visibly thicker
  // Spacing from measured typography (PDF pts → twips); fall back to readable defaults.
  const averages = udm.typography?.statistics?.averages;
  const bodyAfter = twipsFromPts(averages?.paragraphGap, 60, 40, 200);
  const headingBefore = twipsFromPts(averages?.sectionGap, 160, 100, 320);
  const headingAfter = Math.max(40, Math.round(bodyAfter * 0.75));
  const jobBefore = Math.max(80, Math.round(headingBefore * 0.55));

  // Page break tracking
  const pageBreaks = buildPageBreakSet(udm);
  // Max content width for image constraining (page width - 2 * margin, in EMU)
  const pageWidthTwips = contentRightTwips;
  const maxImageWidthEmu = Math.round(pageWidthTwips * (914400 / 1440));

  const order = udm.semantic.readingOrder;
  for (let oi = 0; oi < order.length; oi++) {
    const nodeId = order[oi]!;
    const node = udm.semantic.nodes[nodeId];
    if (!node) continue;

    // Page break before this node (except first page)
    const needsPageBreak = pageBreaks.has(nodeId);

    if (node.type === 'table') {
      const logicalId = 'logicalTableId' in node ? String(node.logicalTableId) : '';
      const table = tableById.get(logicalId);
      if (table && !emittedTables.has(table.id)) {
        if (needsPageBreak) {
          body.push(paragraph('', { pageBreakBefore: true, spacingBefore: 0, spacingAfter: 0 }));
        }
        body.push(writeTable(table));
        emittedTables.add(table.id);
      }
      continue;
    }

    if (node.type === 'image') {
      // Try to embed actual image from imageStore
      const imgData = resolveImageData(udm, node as { resourceId?: string; sourceBlockIds?: string[] });
      if (imgData) {
        const rid = nextRid();
        const ext = extensionFromMime(imgData.mimeType);
        const filename = `image${media.length + 1}.${ext}`;

        media.push({ name: filename, data: imgData.data, contentType: imgData.mimeType });
        rels.push({
          id: rid,
          type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
          target: `media/${filename}`,
        });

        // Compute size in EMU, constrained to page width
        const rawCx = emuFromPx(imgData.widthPx, 96);
        const rawCy = emuFromPx(imgData.heightPx, 96);
        const { cx, cy } = constrainToPageWidth(rawCx, rawCy, maxImageWidthEmu);

        const alt = 'alt' in node ? String((node as { alt?: string }).alt ?? 'Image') : 'Image';
        body.push(writeInlineImage({
          cx,
          cy,
          rId: rid,
          docPrId: nextDocPrId(),
          name: alt,
        }));
      } else {
        // Fallback: placeholder text when no image bytes available
        const alt = 'alt' in node ? String((node as { alt?: string }).alt ?? 'Image') : 'Image';
        body.push(paragraph(runText(`[Image: ${alt}]`, { italic: true }), {
          style: 'Caption',
          pageBreakBefore: needsPageBreak,
        }));
      }
      continue;
    }

    if (node.type === 'list') {
      const items = node.childIds
        .map((id) => udm.semantic.nodes[id])
        .filter((n) => n && n.type === 'list_item');
      const numbered =
        'listStyle' in node &&
        (node.listStyle === 'numbered' ||
          node.listStyle === 'alphabetic' ||
          node.listStyle === 'roman');
      const numId =
        'listStyle' in node && node.listStyle === 'roman'
          ? 3
          : numbered
            ? 2
            : 1;
      let isFirst = true;
      for (const item of items) {
        if (!item || !('text' in item)) continue;
        const text = String(item.text ?? '');
        // Use runsFromNode to preserve bold/italic/color formatting within list items
        const itemRuns = 'runs' in item && item.runs?.length
          ? runsFromNode(item)
          : runText(text);
        if (isFirst && needsPageBreak) {
          // Emit a page-break paragraph before the first list item
          body.push(paragraph('', { pageBreakBefore: true, spacingBefore: 0, spacingAfter: 0 }));
        }
        body.push(listParagraph(itemRuns, numId));
        isFirst = false;
      }
      continue;
    }

    if (node.type === 'list_item') continue; // emitted with list

    if (!('text' in node) || node.text == null) continue;
    const text = String(node.text);
    // Drop empty placeholder paragraphs
    if (!text.trim()) continue;

    // Resolve indentation from typography profile
    const indent = resolveBlockIndent(udm, node);

    // Flattened education header + rows → real Word table
    if (node.type === 'paragraph' && isEducationHeaderRow(text)) {
      const rowTexts: string[] = [];
      let look = oi + 1;
      while (look < order.length) {
        const n2 = udm.semantic.nodes[order[look]!];
        if (!n2 || !('text' in n2)) break;
        if (n2.type !== 'paragraph' && n2.type !== 'subtitle') break;
        const t2 = String(n2.text ?? '').trim();
        if (!t2 || isEducationHeaderRow(t2)) break;
        // Soft-wrapped header fragment like "Remarks" / "Board" — skip
        if (/^(Remarks|Board)\b/i.test(t2) && t2.length < 24) {
          look++;
          continue;
        }
        if (!looksLikeEducationDataRow(t2)) break;
        rowTexts.push(t2);
        look++;
      }
      if (rowTexts.length >= 2) {
        if (needsPageBreak) {
          body.push(paragraph('', { pageBreakBefore: true, spacingBefore: 0, spacingAfter: 0 }));
        }
        body.push(writeEducationTable(rowTexts, accent));
        oi = look - 1;
        continue;
      }
    }

    const style = styleForType(node.type, 'level' in node ? Number(node.level) : undefined);
    const nodeColor = firstRunColor(node as { runs?: Array<{ color?: string }> });
    const resolveColor = (preferred?: string) =>
      preferred && !isNearBlack(preferred) ? preferred : (nodeColor ?? '#000000');
    let runs = runsFromNode(node);
    // Label-only lines ("Personal Achievements:") → bold, preserve PDF color
    if (/^[A-Z][^:\n]{1,40}:\s*$/.test(text.trim())) {
      const labelColor = resolveColor(
        accent.fromPdf ? accent.text : nodeColor,
      );
      runs = runText(text.trim(), { bold: true, color: labelColor });
    }
    // Competency/skills labels with inline • content
    const extra = splitLabelWithInlineBullets(text);
    if (extra) {
      const isTechnicalSkills = /Technical Skills|^Skills:/i.test(extra.label);
      const labelColor = resolveColor(accent.fromPdf ? accent.text : nodeColor);
      const labelRun = runText(extra.label + ' ', { bold: true, color: labelColor });
      if (isTechnicalSkills) {
        // Original: "Technical Skills: MS Excel • MS Word • …" on one line
        const joined = extra.items.join(' • ');
        body.push(
          paragraph(labelRun + runText(joined, { color: nodeColor }), {
            spacingBefore: bodyAfter,
            spacingAfter: headingAfter,
            line: 240,
            indent,
            pageBreakBefore: needsPageBreak,
          }),
        );
      } else {
        // Original: first item after label; later items as "• …" plain lines (not Word lists)
        const firstItem = extra.items[0] ?? '';
        body.push(
          paragraph(labelRun + runText(firstItem, { color: nodeColor }), {
            spacingBefore: bodyAfter,
            spacingAfter: headingAfter,
            line: 240,
            indent,
            pageBreakBefore: needsPageBreak,
          }),
        );
        for (let ii = 1; ii < extra.items.length; ii++) {
          body.push(
            paragraph(runText(`• ${extra.items[ii]!}`, { color: nodeColor }), {
              spacingBefore: 0,
              spacingAfter: bodyAfter,
              line: 240,
              indent,
            }),
          );
        }
      }
      continue;
    }
    let align = mapAlign('alignment' in node ? (node as { alignment?: string }).alignment : undefined);
    // Name/title lines are centered on resumes even when alignment is missing
    if (!align && node.type === 'title') align = 'center';
    // Only name + contact stay centered; section/job lines are left
    if (align === 'center' && node.type !== 'title' && !looksLikeContactLine(text)) {
      align = undefined;
    }

    // Hyperlink wrapper
    if (node.type === 'hyperlink' && 'uri' in node && node.uri) {
      const rid = nextRid();
      rels.push({
        id: rid,
        type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
        target: String(node.uri),
        targetMode: 'External',
      });
      body.push(
        paragraph(
          `<w:hyperlink r:id="${rid}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${runs}</w:hyperlink>`,
          { style, align, indent, pageBreakBefore: needsPageBreak },
        ),
      );
      continue;
    }

    // ALL-CAPS section titles misclassified as subtitle → still emit as heading
    if (isSectionTitleLine(text) && (node.type === 'subtitle' || node.type === 'paragraph')) {
      body.push(
        paragraph(runsFromNode({ ...node, type: 'heading' }), {
          style: 'Heading3',
          align,
          keepNext: true,
          spacingBefore: headingBefore,
          spacingAfter: headingAfter,
          line: 240,
          bottomBorder: { color: sectionRuleColor, sz: SECTION_RULE_SZ, space: 1 },
          indent,
          pageBreakBefore: needsPageBreak,
        }),
      );
      continue;
    }

    // Heading bookmarks — Word/Pages bookmark names: letter/digit/underscore only
    if ((node.type === 'heading' || node.type === 'title') && bookmarks.length) {
      const bm = bookmarks.find((b) => b.title === text);
      if (bm) {
        const id = bookmarkId++;
        const bmName = sanitizeBookmarkName(bm.title) || `bm_${id}`;
        body.push(
          paragraph(
            `<w:bookmarkStart w:id="${id}" w:name="${esc(bmName)}"/>${runs}<w:bookmarkEnd w:id="${id}"/>`,
            {
              style,
              align,
              keepNext: true,
              spacingBefore: node.type === 'title' ? 0 : headingBefore,
              spacingAfter: headingAfter,
              line: 240,
              bottomBorder: node.type === 'heading'
                ? { color: sectionRuleColor, sz: SECTION_RULE_SZ, space: 1 }
                : undefined,
              indent,
              pageBreakBefore: needsPageBreak,
            },
          ),
        );
        continue;
      }
    }

    // Resume job lines: "Assistant Manager Nov 2025 - Apr 2026" → title left, date right
    const split = splitTitleAndDate(text);
    if (split && (node.type === 'paragraph' || node.type === 'subtitle' || node.type === 'heading')) {
      const titleColor = nodeColor ?? '#000000';
      const titleBold = node.type === 'heading' || node.type === 'subtitle';
      const titleRun = runText(split.title, {
        bold: titleBold,
        color: titleColor,
      });
      const dateRun = runText(split.date, { italic: true, color: accent.muted });
      body.push(
        paragraph(`${titleRun}<w:r><w:tab/></w:r>${dateRun}`, {
          rightTabPos: contentRightTwips,
          spacingBefore: jobBefore,
          spacingAfter: bodyAfter,
          line: 240,
          indent,
          pageBreakBefore: needsPageBreak,
        }),
      );
      continue;
    }

    // Company lines under job titles → italic, preserve PDF color (never invent green)
    if (
      node.type === 'subtitle' &&
      !splitTitleAndDate(text) &&
      !isSectionTitleLine(text) &&
      text.trim().split(/\s+/).length <= 6
    ) {
      const companyColor = nodeColor ?? '#000000';
      body.push(
        paragraph(runText(text.trim(), { italic: true, bold: false, color: companyColor }), {
          spacingBefore: 0,
          spacingAfter: bodyAfter,
          line: 240,
          indent,
          pageBreakBefore: needsPageBreak,
        }),
      );
      continue;
    }

    // Spacing from measured PDF gaps (heading vs body)
    const isHeadingLike =
      node.type === 'heading' ||
      node.type === 'title' ||
      (style != null && style.startsWith('Heading'));
    const isContact = looksLikeContactLine(text);
    const spacingBefore = node.type === 'title' ? 0 : isHeadingLike ? headingBefore : 0;
    const spacingAfter = isContact || isHeadingLike ? headingAfter : bodyAfter;
    body.push(
      paragraph(runs, {
        style,
        align,
        spacingBefore,
        spacingAfter,
        line: 240,
        keepNext: isHeadingLike || isContact ? true : undefined,
        bottomBorder: node.type === 'heading'
          ? { color: sectionRuleColor, sz: SECTION_RULE_SZ, space: 1 }
          : undefined,
        indent,
        pageBreakBefore: needsPageBreak,
      }),
    );
    if (isContact) {
      body.push(
        horizontalRule(
          contactRuleColor,
          contentRightTwips,
          CONTACT_RULE_SZ,
        ),
      );
    }
  }

  // Remaining tables not in reading order
  for (const t of udm.tables) {
    if (!emittedTables.has(t.id)) body.push(writeTable(t));
  }

  if (body.length === 0) {
    body.push(paragraph(runText(udm.metadata.title ?? 'Document')));
  }

  // Build header/footer parts first — sectPr must only reference parts that actually exist.
  // Contact-like headers are intentionally omitted from the Word header (moved into body);
  // referencing a missing rIdHeader makes Word refuse to open the file.
  const headerXml = buildHeader(udm);
  const footerXml = buildFooter(udm);
  const footnotesXml = buildFootnotes(udm);
  const sectPr = buildSectPr(udm, !!headerXml, !!footerXml);

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>
    ${body.join('\n')}
    ${sectPr}
  </w:body>
</w:document>`;

  return { documentXml, headerXml, footerXml, footnotesXml, rels, media };
}
