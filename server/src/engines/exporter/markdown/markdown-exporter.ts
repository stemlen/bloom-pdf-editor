import type { ExportResult } from '../../common/interfaces.js';
import type { UnifiedDocumentModel } from '../../udm/types.js';
import {
  extractContentBlocks,
  sanitizeFilename,
  tableToRows,
} from '../content.js';

export class MarkdownExporter {
  readonly name = 'MarkdownExporter' as const;

  async export(udm: UnifiedDocumentModel): Promise<ExportResult> {
    const blocks = extractContentBlocks(udm);
    const lines: string[] = [];
    // The title is often the first heading itself; don't print it twice.
    const title = udm.metadata.title?.trim();
    const first = blocks[0];
    const firstText = first && 'text' in first ? first.text.trim() : '';
    if (title && title !== firstText) lines.push(`# ${title}`, '');

    for (const b of blocks) {
      switch (b.kind) {
        case 'heading':
          lines.push(`${'#'.repeat(b.level)} ${b.text}`, '');
          break;
        case 'paragraph':
          lines.push(b.text, '');
          break;
        case 'quote':
          lines.push(...b.text.split('\n').map((l) => `> ${l}`), '');
          break;
        case 'code':
          lines.push('```', b.text, '```', '');
          break;
        case 'caption':
          lines.push(`*${b.text}*`, '');
          break;
        case 'list':
          b.items.forEach((item, i) => {
            lines.push(b.ordered ? `${i + 1}. ${item}` : `- ${item}`);
          });
          lines.push('');
          break;
        case 'table': {
          const rows = tableToRows(b.table);
          if (rows[0]) {
            lines.push(`| ${rows[0].join(' | ')} |`);
            lines.push(`| ${rows[0].map(() => '---').join(' | ')} |`);
            for (const r of rows.slice(1)) lines.push(`| ${r.join(' | ')} |`);
            lines.push('');
          }
          break;
        }
        case 'image':
          lines.push(`![${b.alt}]()`, '');
          break;
        case 'link':
          lines.push(`[${b.text}](${b.uri})`, '');
          break;
      }
    }

    // Footnotes from structure
    const notes = udm.structure?.footnotes ?? [];
    if (notes.length) {
      lines.push('---', '');
      for (const n of notes) {
        lines.push(`[^${n.marker}]: ${n.body}`);
      }
      lines.push('');
    }

    const md = lines.join('\n');
    return {
      bytes: new TextEncoder().encode(md),
      mimeType: 'text/markdown; charset=utf-8',
      filename: `${sanitizeFilename(udm.metadata.title ?? 'document', 'document')}.md`,
    };
  }
}
