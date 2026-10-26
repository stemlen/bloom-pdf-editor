import { describe, it, expect } from 'vitest';
import { LayoutEngine } from '../engines/layout/layout-engine.js';
import { IntermediateDocumentEngine } from '../engines/idm/idm-engine.js';
import { TypographyAnalyzer } from '../engines/typography/analyzer.js';
import { SemanticStructureEngine } from '../engines/semantic/engine.js';
import { TableDetectionEngine } from '../engines/table/engine.js';
import { GraphicsReconstructionEngine } from '../engines/graphics/engine.js';
import { DocumentStructureEngine } from '../engines/structure/engine.js';
import { assembleUnifiedDocument } from '../engines/udm/assemble.js';
import { ExportManager } from '../engines/exporter/export-manager.js';
import { readZipEntry } from '../engines/exporter/zip.js';
import { ALL_CONVERT_TARGETS, type ConvertTarget } from '../jobs/types.js';
import {
  buildPage,
  buildRawDocument,
  wordChars,
  type CharSpec,
} from './helpers/raw-fixtures.js';
import { borderlessGrid2x3Chars } from './helpers/table-fixtures.js';

async function buildUdm(chars: CharSpec[]) {
  const raw = buildRawDocument([buildPage({ chars })]);
  const layout = await new LayoutEngine().analyze(raw);
  const idm = await new IntermediateDocumentEngine().build(raw, layout);
  const typography = await new TypographyAnalyzer().analyze(idm);
  const semantic = await new SemanticStructureEngine().generate({ idm, layout, typography });
  const tables = await new TableDetectionEngine().detect({ semantic, layout, raw, typography });
  const graphics = await new GraphicsReconstructionEngine().reconstruct({
    semantic: tables.semantic,
    layout,
    raw,
    tables,
  });
  const structure = await new DocumentStructureEngine().build({
    semantic: tables.semantic,
    tables: tables.tables,
    graphics: graphics.graphics,
    layout,
    raw,
    idm,
  });
  return assembleUnifiedDocument({
    idm,
    semantic: tables.semantic,
    tables: tables.tables,
    graphics: graphics.graphics,
    structure: structure.structure,
    typography,
  });
}

const UNIVERSAL: ConvertTarget[] = [
  'html',
  'markdown',
  'epub',
  'rtf',
  'odt',
  'txt',
  'json',
  'xml',
  'svg',
];

describe('Phase 14 — Universal Export Engine', () => {
  it('registers all ConvertTarget exporters via plugin SDK', () => {
    const manager = new ExportManager(true);
    for (const t of ALL_CONVERT_TARGETS) {
      expect(manager.supportedTargets()).toContain(t);
    }
    expect(manager.listPlugins().length).toBeGreaterThanOrEqual(ALL_CONVERT_TARGETS.length);
  });

  it('exports every universal format with non-empty bytes', async () => {
    const chars: CharSpec[] = [
      ...wordChars('Overview', 72, 700, 18),
      ...wordChars('Body paragraph for universal export.', 72, 500, 12),
    ];
    for (const c of chars) {
      if (c.fontSize === 18) c.fontWeight = 700;
    }
    const udm = await buildUdm(chars);
    const manager = new ExportManager(true);

    for (const target of UNIVERSAL) {
      const result = await manager.export(udm, target);
      expect(result.bytes.byteLength, target).toBeGreaterThan(20);
      expect(result.filename, target).toBeTruthy();
      expect(result.mimeType, target).toBeTruthy();
    }
  });

  it('HTML is semantic document; Markdown has heading markers', async () => {
    const udm = await buildUdm([
      ...wordChars('Title Here', 72, 700, 18),
      ...wordChars('Some body', 72, 500, 12),
    ]);
    const manager = new ExportManager(true);
    const html = new TextDecoder().decode((await manager.export(udm, 'html')).bytes);
    expect(html).toContain('<html');
    expect(html).toContain('<main');

    const md = new TextDecoder().decode((await manager.export(udm, 'markdown')).bytes);
    expect(md).toMatch(/^#/m);
  });

  it('EPUB and ODT are ZIP packages with required entries', async () => {
    const udm = await buildUdm([...wordChars('Chapter text', 72, 500, 12)]);
    const manager = new ExportManager(true);

    const epub = await manager.export(udm, 'epub');
    expect(epub.bytes[0]).toBe(0x50);
    expect(readZipEntry(epub.bytes, 'mimetype')).toBeTruthy();
    expect(readZipEntry(epub.bytes, 'META-INF/container.xml')).toBeTruthy();
    expect(readZipEntry(epub.bytes, 'OEBPS/content.opf')).toBeTruthy();

    const odt = await manager.export(udm, 'odt');
    expect(odt.bytes[0]).toBe(0x50);
    expect(readZipEntry(odt.bytes, 'content.xml')).toBeTruthy();
    expect(readZipEntry(odt.bytes, 'META-INF/manifest.xml')).toBeTruthy();
  });

  it('JSON parses as UDM summary without heavy character arrays', async () => {
    const udm = await buildUdm(borderlessGrid2x3Chars());
    const manager = new ExportManager(true);
    const json = JSON.parse(new TextDecoder().decode((await manager.export(udm, 'json')).bytes));
    expect(json.metadata).toBeTruthy();
    expect(json.content).toBeInstanceOf(Array);
    expect(JSON.stringify(json)).not.toMatch(/"characters":\s*\[/);
  });

  it('XML and SVG are well-formed markup', async () => {
    const udm = await buildUdm([...wordChars('Vector page text', 72, 400, 12)]);
    const manager = new ExportManager(true);
    const xml = new TextDecoder().decode((await manager.export(udm, 'xml')).bytes);
    expect(xml).toContain('<?xml');
    expect(xml).toContain('<document');

    const svg = new TextDecoder().decode((await manager.export(udm, 'svg')).bytes);
    expect(svg).toContain('<svg');
    expect(svg).toContain('<text');
  });

  it('joins soft-wrapped lines with a space in every text export', async () => {
    const udm = await buildUdm([
      ...wordChars('Bloom wraps this paragraph so that', 72, 500, 12),
      ...wordChars('exporters keep words apart.', 72, 486, 12),
    ]);
    const manager = new ExportManager(true);
    for (const target of ['markdown', 'txt', 'rtf', 'json'] as const) {
      const text = new TextDecoder().decode((await manager.export(udm, target)).bytes);
      expect(text, target).toContain('so that exporters');
      expect(text, target).not.toContain('thatexporters');
    }
  });
});
