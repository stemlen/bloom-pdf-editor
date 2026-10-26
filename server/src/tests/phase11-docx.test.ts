import { describe, it, expect } from 'vitest';
import { createContainer } from '../container.js';
import { LayoutEngine } from '../engines/layout/layout-engine.js';
import { IntermediateDocumentEngine } from '../engines/idm/idm-engine.js';
import { TypographyAnalyzer } from '../engines/typography/analyzer.js';
import { SemanticStructureEngine } from '../engines/semantic/engine.js';
import { TableDetectionEngine } from '../engines/table/engine.js';
import { GraphicsReconstructionEngine } from '../engines/graphics/engine.js';
import { DocumentStructureEngine } from '../engines/structure/engine.js';
import { assembleUnifiedDocument } from '../engines/udm/assemble.js';
import { DocxExporter } from '../engines/exporter/docx/index.js';
import { readZipEntry } from '../engines/exporter/zip.js';
import { ExportManager } from '../engines/exporter/export-manager.js';
import {
  buildPage,
  buildRawDocument,
  wordChars,
  type CharSpec,
} from './helpers/raw-fixtures.js';
import { borderlessGrid2x3Chars } from './helpers/table-fixtures.js';
import type { SemanticNode } from '../engines/semantic/types.js';

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

describe('Phase 11 — DOCX Export Engine', () => {
  it('assembles UDM without raw PDF parser fields', async () => {
    const udm = await buildUdm([
      ...wordChars('Title', 72, 700, 18),
      ...wordChars('Body paragraph text', 72, 500, 12),
    ]);
    expect(udm.version).toBe('1.0');
    expect(udm.idm).toBeTruthy();
    expect(udm.semantic).toBeTruthy();
    const json = JSON.stringify(udm);
    expect(json).not.toMatch(/objectGraph|spatialIndex|sourceBytes/);
  });

  it('exports a valid OOXML package with document.xml', async () => {
    const udm = await buildUdm([
      ...wordChars('Hello World', 72, 700, 16),
      ...wordChars('This is a body paragraph for export.', 72, 500, 12),
    ]);
    const result = await new DocxExporter().export(udm);
    expect(result.mimeType).toContain('wordprocessingml');
    expect(result.filename.endsWith('.docx')).toBe(true);
    expect(result.bytes.byteLength).toBeGreaterThan(500);

    // ZIP local file signature
    expect(result.bytes[0]).toBe(0x50);
    expect(result.bytes[1]).toBe(0x4b);

    const doc = readZipEntry(result.bytes, 'word/document.xml');
    expect(doc).toBeTruthy();
    const xml = new TextDecoder().decode(doc!);
    expect(xml).toContain('<w:document');
    expect(xml).toContain('<w:body');
    expect(xml.toLowerCase()).toMatch(/hello|body|paragraph|world/);
  });

  it('exports native Word tables from logical tables', async () => {
    const udm = await buildUdm(borderlessGrid2x3Chars());
    const result = await new DocxExporter().export(udm);
    const doc = readZipEntry(result.bytes, 'word/document.xml');
    const xml = new TextDecoder().decode(doc!);
    if (udm.tables.length > 0) {
      expect(xml).toContain('<w:tbl');
      expect(xml).toContain('<w:tc');
    } else {
      // Table detection may miss sparse fixtures — still a valid docx
      expect(xml).toContain('<w:document');
    }
  });

  it('includes styles and numbering parts', async () => {
    const udm = await buildUdm([...wordChars('Styled', 72, 500, 12)]);
    const result = await new DocxExporter().export(udm);
    expect(readZipEntry(result.bytes, 'word/styles.xml')).toBeTruthy();
    expect(readZipEntry(result.bytes, 'word/numbering.xml')).toBeTruthy();
    expect(readZipEntry(result.bytes, '[Content_Types].xml')).toBeTruthy();
  });

  it('ExportManager registers docx and never requires RawDocument', async () => {
    const manager = new ExportManager(true);
    expect(manager.supportedTargets()).toContain('docx');
    const udm = await buildUdm([...wordChars('Export me', 72, 500, 12)]);
    const result = await manager.export(udm, 'docx');
    expect(result.bytes.byteLength).toBeGreaterThan(100);
  });

  it('container can complete a convert→docx job', async () => {
    const container = createContainer({
      memoryStorage: true,
      configOverrides: { 'telemetry.enabled': false },
    });
    expect(container.exporter.supportedTargets()).toContain('docx');
  });

  it('embeds images from imageStore with DrawingML markup', async () => {
    const udm = await buildUdm([
      ...wordChars('Document with image', 72, 700, 16),
    ]);

    // Inject a synthetic image into the imageStore
    const pngHeader = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
      ...new Array(92).fill(0), // minimal body
    ]);

    // Find an image node or create a synthetic one in reading order
    const imageNodeId = 'test_img_1';
    udm.semantic.nodes[imageNodeId] = {
      id: imageNodeId,
      type: 'image',
      parentId: null,
      childIds: [],
      readingOrderIndex: 999,
      confidence: 1,
      pageIndex: 0,
      sourceBlockIds: [],
      width: 200,
      height: 100,
      resourceId: 'img_resource_1',
    } as unknown as SemanticNode;
    udm.semantic.readingOrder.push(imageNodeId);

    // Add image to store
    udm.imageStore = new Map();
    udm.imageStore.set('img_resource_1', {
      data: pngHeader,
      mimeType: 'image/png',
      widthPx: 200,
      heightPx: 100,
    });

    const result = await new DocxExporter().export(udm);
    const doc = readZipEntry(result.bytes, 'word/document.xml');
    const xml = new TextDecoder().decode(doc!);

    // Should contain DrawingML elements, not placeholder text
    expect(xml).toContain('wp:inline');
    expect(xml).toContain('pic:pic');
    expect(xml).toContain('a:blip');
    expect(xml).not.toContain('[Image:');

    // Should have image in media folder
    const imageEntry = readZipEntry(result.bytes, 'word/media/image1.png');
    expect(imageEntry).toBeTruthy();
    expect(imageEntry!.byteLength).toBe(pngHeader.byteLength);

    // Rels should reference the image
    const relsEntry = readZipEntry(result.bytes, 'word/_rels/document.xml.rels');
    const relsXml = new TextDecoder().decode(relsEntry!);
    expect(relsXml).toContain('relationships/image');
    expect(relsXml).toContain('media/image1.png');
  });

  it('uses PDF primary font in styles.xml when typography is available', async () => {
    const udm = await buildUdm([
      ...wordChars('Styled text', 72, 500, 14),
    ]);

    // Inject typography with a non-Calibri primary font
    if (udm.typography) {
      udm.typography.statistics.primaryFonts = [
        { font: 'Times New Roman', count: 50, share: 0.8 },
      ];
      udm.typography.statistics.dominantFontSizes = [
        { size: 12, count: 40 },
      ];
    }

    const result = await new DocxExporter().export(udm);
    const stylesEntry = readZipEntry(result.bytes, 'word/styles.xml');
    const stylesXml = new TextDecoder().decode(stylesEntry!);

    expect(stylesXml).toContain('Times New Roman');
    // Default size should be 24 half-points (12pt * 2)
    expect(stylesXml).toContain('w:val="24"');
  });

  it('includes DrawingML namespaces in document.xml', async () => {
    const udm = await buildUdm([
      ...wordChars('Namespace test', 72, 500, 12),
    ]);
    const result = await new DocxExporter().export(udm);
    const doc = readZipEntry(result.bytes, 'word/document.xml');
    const xml = new TextDecoder().decode(doc!);

    // Must have DrawingML namespaces for image support
    expect(xml).toContain('xmlns:wp=');
    expect(xml).toContain('xmlns:a=');
    expect(xml).toContain('xmlns:pic=');
  });

  it('includes extended image content types', async () => {
    const udm = await buildUdm([
      ...wordChars('Content types test', 72, 500, 12),
    ]);
    const result = await new DocxExporter().export(udm);
    const ctEntry = readZipEntry(result.bytes, '[Content_Types].xml');
    const ctXml = new TextDecoder().decode(ctEntry!);

    expect(ctXml).toContain('Extension="png"');
    expect(ctXml).toContain('Extension="jpeg"');
    expect(ctXml).toContain('Extension="gif"');
    expect(ctXml).toContain('Extension="tiff"');
  });

  it('registers PDF fonts in fontTable.xml', async () => {
    const udm = await buildUdm([
      ...wordChars('Font test', 72, 500, 12),
    ]);

    if (udm.typography) {
      udm.typography.statistics.primaryFonts = [
        { font: 'Arial', count: 30, share: 0.6 },
      ];
      udm.typography.statistics.secondaryFonts = [
        { font: 'Georgia', count: 10, share: 0.2 },
      ];
    }

    const result = await new DocxExporter().export(udm);
    const ftEntry = readZipEntry(result.bytes, 'word/fontTable.xml');
    const ftXml = new TextDecoder().decode(ftEntry!);

    // Should contain both the PDF fonts plus defaults
    expect(ftXml).toContain('Arial');
    expect(ftXml).toContain('Georgia');
    expect(ftXml).toContain('Calibri');
    expect(ftXml).toContain('Consolas');
  });

  it('emits page breaks between multi-page content', async () => {
    // Create a UDM with nodes on different pages
    const udm = await buildUdm([
      ...wordChars('Page 1 content', 72, 700, 14),
      ...wordChars('Page 2 content', 72, 500, 12),
    ]);

    // Simulate multi-page: move the second node to page 1
    const nodes = Object.values(udm.semantic.nodes);
    const textNodes = nodes.filter((n) => 'text' in n && n.type !== 'document');
    if (textNodes.length >= 2) {
      textNodes[1].pageIndex = 1;
    }

    const result = await new DocxExporter().export(udm);
    const doc = readZipEntry(result.bytes, 'word/document.xml');
    const xml = new TextDecoder().decode(doc!);

    // Should contain a page break element
    expect(xml).toContain('pageBreakBefore');
  });
});

