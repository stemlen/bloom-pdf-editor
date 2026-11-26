/**
 * End-to-end conversion fidelity: PDF bytes → container job → exported file.
 * Covers PDFs as Chrome/Skia writes them (flipped CTM, Type3 subsets, Devanagari
 * through /ActualText) and the exporters' handling of Unicode, lists and spans.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContainer, type BloomContainer } from '../container.js';
import { ParserEngine } from '../engines/parser/parser-engine.js';
import { readZipEntry } from '../engines/exporter/zip.js';
import { escRtf } from '../engines/exporter/rtf/rtf-exporter.js';
import { writeTable } from '../engines/exporter/docx/writers/tables.js';
import { ExportManager } from '../engines/exporter/export-manager.js';
import type { LogicalTable } from '../engines/table/types.js';
import type { ConvertTarget } from '../jobs/types.js';
import { LayoutEngine } from '../engines/layout/layout-engine.js';
import { IntermediateDocumentEngine } from '../engines/idm/idm-engine.js';
import { TypographyAnalyzer } from '../engines/typography/analyzer.js';
import { SemanticStructureEngine } from '../engines/semantic/engine.js';
import { TableDetectionEngine } from '../engines/table/engine.js';
import { GraphicsReconstructionEngine } from '../engines/graphics/engine.js';
import { DocumentStructureEngine } from '../engines/structure/engine.js';
import { assembleUnifiedDocument } from '../engines/udm/assemble.js';
import { buildPage, buildRawDocument, wordChars, type CharSpec } from './helpers/raw-fixtures.js';

const fixture = (name: string) => new Uint8Array(readFileSync(join(__dirname, 'fixtures', name)));
const decode = (b: Uint8Array) => new TextDecoder().decode(b);
const utf16Hex = (s: string) =>
  'FEFF' + [...s].map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('').toUpperCase();

/** A one-page PDF around a content stream (Helvetica as F1, Helvetica-Bold as F2). */
function buildPdf(opts: {
  content: string;
  mediaBox?: [number, number, number, number];
  rotate?: number;
  extraResources?: string;
  info?: string;
  image?: boolean;
}): Uint8Array {
  const [x0, y0, x1, y1] = opts.mediaBox ?? [0, 0, 612, 792];
  const xobj = opts.image ? '/XObject << /Im1 8 0 R >>' : '';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [${x0} ${y0} ${x1} ${y1}]${opts.rotate ? ` /Rotate ${opts.rotate}` : ''} /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> ${xobj} ${opts.extraResources ?? ''} >> >>`,
    `<< /Length ${opts.content.length} >>\nstream\n${opts.content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    opts.info ?? '<< >>',
    '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\x80\nendstream',
  ];
  let body = '%PDF-1.7\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array([...body].map((c) => c.charCodeAt(0) & 0xff));
}

let bloom: BloomContainer;
beforeAll(() => {
  bloom = createContainer({ memoryStorage: true, configOverrides: { 'telemetry.enabled': false } });
  bloom.startWorkers();
});
afterAll(async () => {
  await bloom.stop();
});

async function convert(bytes: Uint8Array, target: ConvertTarget): Promise<Uint8Array> {
  const job = await bloom.documentEngine.enqueueConversion({ filename: 't.pdf', target, options: {} }, bytes);
  for (let i = 0; i < 2000; i++) {
    const j = await bloom.documentEngine.getJob(job.id);
    if (j?.state === 'Completed') break;
    if (j?.state === 'Failed' || j?.state === 'Cancelled') throw new Error(j.error ?? j.state);
    await new Promise((r) => setTimeout(r, 10));
  }
  const out = await bloom.documentEngine.getDownload(job.id);
  if (!out) throw new Error('no download');
  return out.bytes;
}

const zipText = (zip: Uint8Array, name: string) => decode(readZipEntry(zip, name) ?? new Uint8Array());

describe('content stream geometry', () => {
  it('applies cm as M × CTM, so nested translate + scale places objects where they are drawn', async () => {
    const raw = await new ParserEngine().parse(
      buildPdf({
        image: true,
        content: 'q 1 0 0 1 100 400 cm 200 0 0 100 0 0 cm /Im1 Do Q\nq 1 0 0 1 72 300 cm 2 0 0 2 0 0 cm BT /F1 10 Tf 5 0 Td (AB) Tj ET Q',
      }),
    );
    const page = raw.pages[0]!;
    expect(page.images[0]!.bbox).toMatchObject({ x: 100, y: 400, width: 200, height: 100 });
    const [a, b] = page.characters;
    // Td offsets and glyph advances are in text space, so the 2× scale applies to them.
    expect(a!.bbox.x).toBeCloseTo(82);
    expect(a!.bbox.y).toBeCloseTo(300);
    expect(a!.bbox.height).toBeCloseTo(20);
    expect(b!.bbox.x).toBeCloseTo(92); // 500/1000 × 10pt × 2
  });

  it('reads a Chrome-style page (flipped CTM and text matrix) top to bottom without splitting words at font switches', async () => {
    const pdf = buildPdf({
      content: [
        '.75 0 0 -.75 0 792 cm',
        'BT /F1 20 Tf 1 0 0 -1 40 60 Tm (M) Tj /F2 20 Tf (eeting) Tj /F1 20 Tf ( notes) Tj ET',
        'BT /F1 14 Tf 1 0 0 -1 40 110 Tm (Second line of the page) Tj ET',
      ].join('\n'),
    });
    const txt = decode(await convert(pdf, 'txt'));
    expect(txt).toContain('Meeting notes');
    expect(txt).not.toContain('M eeting');
    expect(txt.indexOf('Meeting')).toBeLessThan(txt.indexOf('Second line'));
  });

  it('reads text on a /Rotate 90 page left to right', async () => {
    // Content drawn bottom-to-top so it is upright once the page is turned.
    const pdf = buildPdf({
      mediaBox: [0, 0, 300, 500],
      rotate: 90,
      content:
        'q 0 1 -1 0 300 0 cm BT /F1 14 Tf 40 250 Td (Landscape heading) Tj ET BT /F1 14 Tf 40 220 Td (Second row) Tj ET Q',
    });
    const txt = decode(await convert(pdf, 'txt'));
    expect(txt).toContain('Landscape heading');
    expect(txt.indexOf('Landscape heading')).toBeLessThan(txt.indexOf('Second row'));
  });

  it('keeps a paragraph that sits just under a picture', async () => {
    const pdf = buildPdf({
      image: true,
      content:
        'q 1 0 0 1 100 400 cm 200 0 0 100 0 0 cm /Im1 Do Q\nBT /F1 10 Tf 100 386 Td (Caption text under the picture) Tj ET',
    });
    const md = decode(await convert(pdf, 'markdown'));
    expect(md).toContain('Caption text under the picture');
  });
});

describe('ActualText and Unicode', () => {
  it('replaces the glyphs of an /ActualText span (inline and named property lists)', async () => {
    const pdf = buildPdf({
      extraResources: `/Properties << /MC0 << /ActualText <${utf16Hex('श्र')}> >> >>`,
      content: `BT /F1 12 Tf 72 700 Td /Span <</ActualText <${utf16Hex('क्ष')}> /Lang (hi)>> BDC (xy) Tj EMC (a) Tj /Span /MC0 BDC (zz) Tj EMC ET`,
    });
    const txt = decode(await convert(pdf, 'txt'));
    expect(txt).toContain('क्षaश्र');
    expect(txt).not.toMatch(/xy|zz/);
  });

  it('decodes UTF-16 document info into titles and authors', async () => {
    const pdf = buildPdf({
      info: `<< /Title <${utf16Hex('हिन्दी रिपोर्ट')}> /Author <${utf16Hex('अमित')}> >>`,
      content: 'BT /F1 12 Tf 72 700 Td (Body text) Tj ET',
    });
    expect(decode(await convert(pdf, 'html'))).toContain('<title>हिन्दी रिपोर्ट</title>');
    const core = zipText(await convert(pdf, 'docx'), 'docProps/core.xml');
    expect(core).toContain('<dc:title>हिन्दी रिपोर्ट</dc:title>');
    expect(core).toContain('<dc:creator>अमित</dc:creator>');
  });

  it('escapes non-ASCII text in RTF as \\uN? so readers do not see mojibake', () => {
    expect(escRtf('\u0915\u093c é {x}\\')).toBe('\\u2325?\\u2364? \\u233? \\{x\\}\\\\');
    expect(escRtf('😀')).toBe('\\u-10179?\\u-8704?');
  });
});

describe('Chrome-made Hindi PDFs', () => {
  it('hi-3: Devanagari conjuncts and matras come out in order in every text format', async () => {
    const pdf = fixture('hi-3-mixed-en.pdf');
    const txt = decode(await convert(pdf, 'txt'));
    expect(txt.trimStart().startsWith('Meeting Notes / बैठक के नोट्स')).toBe(true);
    expect(txt).toContain('दिनांक: १२ मार्च २०२६');
    expect(txt).toContain('बजट स्वीकृत हुआ');
    expect(txt).toContain('क्षत्रिय, त्रिशूल, श्रद्धा, द्वार, प्रोग्राम, कृष्ण, ज्ञान, स्त्री, हृदय, उद्योग।');
    expect(txt).toContain('The quick brown fox jumps over the lazy dog.');
    // Label + value lines are paragraphs, not a table.
    expect(decode(await convert(pdf, 'markdown'))).not.toContain('| --- |');
    const rtf = decode(await convert(pdf, 'rtf'));
    expect(/^[\x00-\x7f]*$/.test(rtf)).toBe(true);
    expect(rtf).toContain(escRtf('श्रद्धा'));
  });

  it('hi-2: the ruled invoice table is detected with its four columns and no empty border rows', async () => {
    const pdf = fixture('hi-2-table-invoice.pdf');
    const md = decode(await convert(pdf, 'markdown'));
    expect(md).toContain('| क्रम | विवरण | मात्रा | मूल्य (₹) |');
    expect(md).toContain('| 2 | गेहूँ का आटा | 3 | 240.00 |');
    expect(md).toContain('| कुल योग |  |  | 1800.00 |');
    expect(md.match(/# बीजक संख्या ४५६/g)).toHaveLength(1);
    const doc = zipText(await convert(pdf, 'docx'), 'word/document.xml');
    expect(doc).toContain('<w:tbl>');
    expect(doc).toContain('शुद्ध घी');
    const xlsx = await convert(pdf, 'xlsx');
    expect(zipText(xlsx, 'xl/sharedStrings.xml') + zipText(xlsx, 'xl/worksheets/sheet1.xml')).toContain('मूल्य (₹)');
  });
});

async function buildUdm(chars: CharSpec[]) {
  const raw = buildRawDocument([buildPage({ chars })]);
  const layout = await new LayoutEngine().analyze(raw);
  const idm = await new IntermediateDocumentEngine().build(raw, layout);
  const typography = await new TypographyAnalyzer().analyze(idm);
  const semantic = await new SemanticStructureEngine().generate({ idm, layout, typography });
  const tables = await new TableDetectionEngine().detect({ semantic, layout, raw, typography });
  const graphics = await new GraphicsReconstructionEngine().reconstruct({ semantic: tables.semantic, layout, raw, tables });
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

describe('exporters', () => {
  it('SVG and PPTX draw list items (a list node has no text of its own)', async () => {
    const udm = await buildUdm([
      ...wordChars('1. First numbered point of the list', 72, 700, 12),
      ...wordChars('2. Second numbered point of the list', 72, 684, 12),
      ...wordChars('3. Third numbered point of the list', 72, 668, 12),
    ]);
    expect(Object.values(udm.semantic.nodes).some((n) => n.type === 'list')).toBe(true);
    const manager = new ExportManager(true);
    const svg = decode((await manager.export(udm, 'svg')).bytes);
    const slide = zipText((await manager.export(udm, 'pptx')).bytes, 'ppt/slides/slide1.xml');
    for (const out of [svg, slide]) {
      expect(out).toContain('Second numbered point');
      expect(out).toContain('Third numbered point');
    }
  });

  it('DOCX tables never let a span swallow another cell, and every row keeps its cells', () => {
    const cell = (rowIndex: number, colIndex: number, text: string, rowSpan = 1, colSpan = 1) => ({
      id: `c${rowIndex}${colIndex}`,
      rowIndex,
      colIndex,
      rowSpan,
      colSpan,
      text,
      runs: [],
    });
    const table = {
      columns: [{ width: 100 }, { width: 100 }, { width: 100 }],
      rows: [{ role: 'header' }, { role: 'body' }, { role: 'body' }],
      cells: [
        cell(0, 0, 'Title', 3, 3), // claims the whole table
        cell(1, 2, 'Kept value'),
        cell(2, 0, 'Spans down', 1, 1),
        cell(1, 0, 'Left', 2, 1), // would cover "Spans down"
      ],
    } as unknown as LogicalTable;
    const xml = writeTable(table);
    for (const t of ['Title', 'Kept value', 'Spans down', 'Left']) expect(xml).toContain(t);
    expect(xml).not.toMatch(/<w:tr>(<w:trPr>.*?<\/w:trPr>)?<\/w:tr>/);
    // Every row covers the 3 grid columns.
    for (const row of xml.match(/<w:tr>.*?<\/w:tr>/g) ?? []) {
      const spans = [...row.matchAll(/<w:tc>(?:<w:tcPr>(?:<w:gridSpan w:val="(\d+)"\/>)?)?/g)].map((m) => Number(m[1] ?? 1));
      expect(spans.reduce((s, n) => s + n, 0)).toBe(3);
    }
  });
});
