import type { ExportResult } from '../../common/interfaces.js';
import type { UnifiedDocumentModel } from '../../udm/types.js';
import {
  escXml,
  extractContentBlocks,
  sanitizeFilename,
  tableToRows,
} from '../content.js';

export class XmlExporter {
  readonly name = 'XmlExporter' as const;

  async export(udm: UnifiedDocumentModel): Promise<ExportResult> {
    const blocks = extractContentBlocks(udm);
    const content = blocks.map(blockToXml).join('\n');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<document id="${escXml(udm.id)}" version="${escXml(udm.version)}">
  <metadata>
${optionalXml('title', udm.metadata.title)}${optionalXml('author', udm.metadata.author)}${optionalXml('language', udm.metadata.language)}    <pageCount>${udm.metadata.pageCount}</pageCount>
  </metadata>
  <body>
${content}
  </body>
</document>
`;
    return {
      bytes: new TextEncoder().encode(xml),
      mimeType: 'application/xml',
      filename: `${sanitizeFilename(udm.metadata.title ?? 'document', 'document')}.xml`,
    };
  }
}

function blockToXml(b: ReturnType<typeof extractContentBlocks>[number]): string {
  switch (b.kind) {
    case 'heading':
      return `    <heading level="${b.level}">${escXml(b.text)}</heading>`;
    case 'paragraph':
      return `    <paragraph>${escXml(b.text)}</paragraph>`;
    case 'quote':
      return `    <quote>${escXml(b.text)}</quote>`;
    case 'code':
      return `    <code><![CDATA[${b.text}]]></code>`;
    case 'caption':
      return `    <caption>${escXml(b.text)}</caption>`;
    case 'list':
      return `    <list ordered="${b.ordered}">${b.items.map((i) => `<item>${escXml(i)}</item>`).join('')}</list>`;
    case 'table': {
      const rows = tableToRows(b.table)
        .map(
          (r) =>
            `<row>${r.map((c) => `<cell>${escXml(c)}</cell>`).join('')}</row>`,
        )
        .join('');
      return `    <table pageIndex="${b.table.pageIndex}">${rows}</table>`;
    }
    case 'image':
      return `    <image alt="${escXml(b.alt)}"/>`;
    case 'link':
      return `    <link href="${escXml(b.uri)}">${escXml(b.text)}</link>`;
  }
}

/** A metadata element, or nothing when the value is empty. */
function optionalXml(tag: string, value: string | undefined | null): string {
  return value && value.trim() ? `    <${tag}>${escXml(value)}</${tag}>\n` : '';
}
