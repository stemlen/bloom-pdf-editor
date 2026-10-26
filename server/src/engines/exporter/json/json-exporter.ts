import type { ExportResult } from '../../common/interfaces.js';
import type { UnifiedDocumentModel } from '../../udm/types.js';
import { extractContentBlocks, sanitizeFilename, tableToRows } from '../content.js';

/**
 * JSON export of UDM summary tree — strips heavy IDM character arrays.
 */
export class JsonExporter {
  readonly name = 'JsonExporter' as const;

  async export(udm: UnifiedDocumentModel): Promise<ExportResult> {
    const blocks = extractContentBlocks(udm);
    const payload = {
      id: udm.id,
      version: udm.version,
      // Leave out empty metadata rather than writing "" or [].
      metadata: Object.fromEntries(
        Object.entries(udm.metadata).filter(([, v]) =>
          v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)),
      ),
      content: blocks.map((b) => {
        if (b.kind === 'table') {
          return {
            kind: 'table',
            pageIndex: b.table.pageIndex,
            rows: tableToRows(b.table),
            columns: b.table.columns.map((c) => ({
              dataType: c.dataType,
              alignment: c.alignment,
            })),
          };
        }
        return b;
      }),
      structure: udm.structure
        ? {
            headers: udm.structure.headers,
            footers: udm.structure.footers,
            pageNumbers: udm.structure.pageNumbers,
            toc: udm.structure.toc,
            bookmarks: udm.structure.bookmarks,
            hyperlinks: udm.structure.hyperlinks,
            footnotes: udm.structure.footnotes,
            quality: udm.structure.quality,
          }
        : null,
      tables: udm.tables.map((t) => ({
        id: t.id,
        pageIndex: t.pageIndex,
        kind: t.kind,
        rowCount: t.rows.length,
        columnCount: t.columns.length,
        confidence: t.confidence,
      })),
      graphics: udm.graphics
        ? {
            id: udm.graphics.id,
            objectCount: udm.graphics.objects.length,
            kindCounts: countKinds(udm.graphics.objects.map((o) => o.kind)),
            quality: udm.graphics.quality,
          }
        : null,
      recognition: udm.recognition
        ? {
            id: udm.recognition.id,
            primaryLanguage: udm.recognition.primaryLanguage,
            pageCount: udm.recognition.pages.length,
            quality: udm.recognition.quality,
          }
        : null,
      semantic: {
        id: udm.semantic.id,
        title: udm.semantic.title,
        nodeCount: Object.keys(udm.semantic.nodes).length,
        readingOrder: udm.semantic.readingOrder,
        quality: udm.semantic.quality,
      },
    };

    const json = JSON.stringify(payload, null, 2);
    return {
      bytes: new TextEncoder().encode(json),
      mimeType: 'application/json',
      filename: `${sanitizeFilename(udm.metadata.title ?? 'document', 'document')}.json`,
    };
  }
}

function countKinds(kinds: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of kinds) out[k] = (out[k] ?? 0) + 1;
  return out;
}
