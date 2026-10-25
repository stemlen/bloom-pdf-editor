import type { ExportResult } from '../../common/interfaces.js';
import type { UnifiedDocumentModel } from '../../udm/types.js';
import { escXml, sanitizeFilename } from '../content.js';

/**
 * Editable SVG from semantic text + vector graphics (no full-page raster).
 */
export class SvgExporter {
  readonly name = 'SvgExporter' as const;

  async export(udm: UnifiedDocumentModel): Promise<ExportResult> {
    const page = udm.idm.sections[0]?.pages[0];
    const width = page?.width ?? 612;
    const height = page?.height ?? 792;

    // Group by page; stack vertically for multi-page
    const pageIndices = new Set<number>();
    for (const n of Object.values(udm.semantic.nodes)) pageIndices.add(n.pageIndex);
    for (const o of udm.graphics?.objects ?? []) pageIndices.add(o.pageIndex);
    if (pageIndices.size === 0) pageIndices.add(0);
    const pages = [...pageIndices].sort((a, b) => a - b);

    const parts: string[] = [];
    pages.forEach((pi, idx) => {
      const yOff = idx * (height + 36);
      parts.push(`<g id="page-${pi}" transform="translate(0,${yOff})">`);
      parts.push(
        `<rect x="0" y="0" width="${width}" height="${height}" fill="#fff" stroke="#ddd"/>`,
      );

      for (const o of udm.graphics?.objects ?? []) {
        if (o.pageIndex !== pi || o.kind !== 'vector') continue;
        const v = o;
        if (v.shape === 'rectangle' || v.shape === 'rounded_rectangle') {
          parts.push(
            `<rect x="${v.bbox.x}" y="${flipY(v.bbox.y, v.bbox.height, height)}" width="${v.bbox.width}" height="${v.bbox.height}" fill="none" stroke="#333" stroke-width="1"/>`,
          );
        } else if (v.shape === 'line') {
          parts.push(
            `<line x1="${v.bbox.x}" y1="${flipY(v.bbox.y, 0, height)}" x2="${v.bbox.x + v.bbox.width}" y2="${flipY(v.bbox.y + v.bbox.height, 0, height)}" stroke="#333" stroke-width="1"/>`,
          );
        }
      }

      for (const n of Object.values(udm.semantic.nodes)) {
        if (n.pageIndex !== pi || !n.bbox || n.type === 'list_item' || n.type === 'table') continue;
        if (!('text' in n) || !n.text) continue;
        const heading = n.type === 'heading' || n.type === 'title' || n.type === 'subtitle';
        const runSize =
          'runs' in n && Array.isArray(n.runs) ? n.runs.find((r) => r.fontSize)?.fontSize : undefined;
        const fs = runSize ?? (heading ? 16 : 12);
        parts.push(
          textElement(String(n.text), n.bbox, fs, height, heading ? ' font-weight="bold"' : ''),
        );
      }

      // Table cells are placed in their own cells rather than as one line.
      for (const t of udm.tables) {
        if (t.pageIndex !== pi) continue;
        for (const c of t.cells) {
          if (!c.text.trim()) continue;
          const fs = c.runs.find((r) => r.fontSize)?.fontSize ?? 10;
          const box = { ...c.bbox, x: c.bbox.x + 3, width: Math.max(c.bbox.width - 6, fs) };
          parts.push(textElement(c.text, box, fs, height, ''));
        }
      }
      parts.push('</g>');
    });

    const totalH = pages.length * (height + 36);
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${totalH}" viewBox="0 0 ${width} ${totalH}">
${parts.join('\n')}
</svg>
`;
    return {
      bytes: new TextEncoder().encode(svg),
      mimeType: 'image/svg+xml',
      filename: `${sanitizeFilename(udm.metadata.title ?? 'document', 'document')}.svg`,
    };
  }
}

/**
 * A `<text>` for a block: one `<tspan>` per wrapped line inside the block's
 * box, so multi-line paragraphs do not run off the page or overlap.
 */
function textElement(
  text: string,
  bbox: { x: number; y: number; width: number; height: number },
  fontSize: number,
  pageHeight: number,
  extra: string,
): string {
  const top = flipY(bbox.y, bbox.height, pageHeight);
  // Helvetica averages about half an em per character.
  const perLine = Math.max(1, Math.floor(bbox.width / (fontSize * 0.5)));
  const lines = wrapWords(text, perLine);
  const leading = lines.length > 1 ? Math.max(fontSize * 1.15, bbox.height / lines.length) : fontSize;
  const first = top + fontSize * 0.8;
  const spans = lines
    .map((line, i) => `<tspan x="${num(bbox.x)}" y="${num(first + i * leading)}">${escXml(line)}</tspan>`)
    .join('');
  return `<text font-size="${num(fontSize)}" font-family="Helvetica,Arial,sans-serif"${extra}>${spans}</text>`;
}

function wrapWords(text: string, perLine: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (cur && cur.length + 1 + word.length > perLine) {
      lines.push(cur);
      cur = word;
    } else {
      cur = cur ? `${cur} ${word}` : word;
    }
  }
  if (cur) lines.push(cur);
  return lines.length > 0 ? lines : [''];
}

/** Round to hundredths so coordinates do not carry float noise. */
function num(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/** PDF y (bottom-up) → SVG y (top-down). */
function flipY(y: number, h: number, pageHeight: number): number {
  return pageHeight - y - h;
}
