/**
 * QA round 2 regressions: forms (flatten, choice /I, appearances, Hindi
 * values), content appended to pages that leave a transformed CTM, Hindi
 * watermarks and annotation text, OCR text layer and rotated-page drawing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import * as engine from '../index';
import {
  PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRef, PDFStream,
  type PDFDocumentData, type PDFObject, type PDFPageInfo,
} from '../types';
import { resolveRef } from '../parser/parser';
import { fieldDictForWidget } from '../forms/apply-field';
import { isolateGraphicsState } from '../editor/stream-compiler';
import { parseContentStream } from '../content/operator-lexer';
import type { RasterTextLine } from '../forms/text-appearance';
import { applyWatermarkToPage, type TextWatermark } from '../watermark/watermark-engine';
import { canvasToPdf, displayBoxToPage } from '@/app/editor/utils';

const FORMS = join(__dirname, 'fixtures/forms');
const latin1 = (b: Uint8Array) => Buffer.from(b).toString('latin1');

async function open(name: string): Promise<PDFDocumentData> {
  return engine.parsePDF(new Uint8Array(readFileSync(join(FORMS, name))));
}
const fields = (doc: PDFDocumentData, name: string) =>
  engine.detectFormFieldsOnPage(doc, 0).filter((f) => f.fieldName === name);
const reopen = async (doc: PDFDocumentData) => engine.parsePDF(await engine.saveOptimized(doc));

function apText(doc: PDFDocumentData, widget: { dict: PDFDict }): { text: string; stream: PDFStream } {
  const ap = resolveRef(widget.dict.get('AP') as PDFObject, doc.objects) as PDFDict;
  const stream = resolveRef(ap.get('N') as PDFObject, doc.objects) as PDFStream;
  return { text: latin1(stream.getBytes()), stream };
}

async function pdfjsText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const d = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  const content = await (await d.getPage(1)).getTextContent();
  return content.items.map((i) => ('str' in i ? i.str : '')).join(' ');
}

/** Stand-in for the browser rasterizer: a w×h block of full coverage. */
function fakeRaster(text: string, fontSize: number): RasterTextLine {
  const w = Math.max(1, text.length * 4);
  const h = Math.ceil(fontSize * 1.4);
  const rgbSamples = new Uint8Array(w * h * 3);
  const alphaSamples = new Uint8Array(w * h).fill(255);
  return {
    widthPx: w, heightPx: h,
    rgb: new Uint8Array(deflateSync(rgbSamples)), alpha: new Uint8Array(deflateSync(alphaSamples)),
    rgbSamples, alphaSamples,
    widthPt: w, heightPt: h, baselinePt: fontSize * 0.3, advancePt: w,
  };
}

afterEach(() => engine.setComplexTextRasterizer(null));

describe('isolateGraphicsState', () => {
  const ops = (b: Uint8Array) => parseContentStream(b).map((i) => i.operator);

  it('wraps content that leaves a transformed CTM (Chromium PDFs)', () => {
    const content = new TextEncoder().encode('.24 0 0 -.24 0 842 cm\nq 0 0 10 10 re f Q\n');
    const out = isolateGraphicsState(content);
    expect(ops(out)[0]).toBe('q');
    expect(ops(out).at(-1)).toBe('Q');
    expect(ops(out).filter((o) => o === 'q').length).toBe(ops(out).filter((o) => o === 'Q').length);
  });

  it('leaves balanced content alone', () => {
    const content = new TextEncoder().encode('q 1 0 0 1 5 5 cm 0 0 10 10 re f Q\n');
    expect(isolateGraphicsState(content)).toBe(content);
  });

  it('closes unbalanced q and absorbs stray Q', () => {
    const open1 = isolateGraphicsState(new TextEncoder().encode('q 2 0 0 2 0 0 cm\n'));
    expect(ops(open1).filter((o) => o === 'q').length).toBe(ops(open1).filter((o) => o === 'Q').length);
    const stray = isolateGraphicsState(new TextEncoder().encode('Q 2 0 0 2 0 0 cm\n'));
    const o = ops(stray);
    let depth = 0;
    for (const op of o) {
      if (op === 'q') depth++;
      if (op === 'Q') depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });
});

describe('form values', () => {
  it('keeps /I in step with a new choice value', async () => {
    const doc = await open('e-form-fields.pdf');
    engine.setChoiceFieldValue(doc, fields(doc, 'country')[0], 'Germany');
    const saved = await reopen(doc);
    const field = fieldDictForWidget(fields(saved, 'country')[0], saved.objects);
    const i = field.get('I') as PDFArray;
    expect((i.items[0] as PDFNumber).value).toBe(3);
  });

  it('regenerated appearances keep the /MK background and border', async () => {
    const doc = await open('e-form-fields.pdf');
    const name = fields(doc, 'full_name')[0];
    engine.setFormFieldValue(doc, name, 'Asha');
    const { text } = apText(doc, name);
    expect(text).toContain('0.8 0.843 1 rg');
    expect(text).toMatch(/0\.1 0\.1 0\.1 RG [\d.]+ w/);
    expect(text).toContain('(Asha) Tj');
  });

  it('draws Hindi values with the host rasterizer, not as "?"', async () => {
    engine.setComplexTextRasterizer(fakeRaster);
    const doc = await open('hindi-form.pdf');
    const naam = fields(doc, 'naam')[0];
    engine.setFormFieldValue(doc, naam, 'राजेश कुमार');
    const { text, stream } = apText(doc, naam);
    expect(text).not.toContain('?');
    expect(text).toContain('/BloomTx0 Do');
    const xo = (stream.dict.get('Resources') as PDFDict).get('XObject') as PDFDict;
    const img = resolveRef(xo.get('BloomTx0') as PDFObject, doc.objects) as PDFStream;
    expect((img.dict.get('Subtype') as PDFName).name).toBe('Image');
    expect(img.dict.get('SMask')).toBeInstanceOf(PDFRef);
    // Viewers would otherwise rebuild the appearance from /DA (Helvetica) and garble it.
    const acro = resolveRef(doc.catalog.get('AcroForm') as PDFObject, doc.objects) as PDFDict;
    expect(acro.get('NeedAppearances')).toBeUndefined();
    // The value itself is stored as UTF-16 text.
    expect(fieldDictForWidget(naam, doc.objects).get('V')).toBeInstanceOf(PDFHexString);

    // Retyping reuses the image objects instead of piling up new ones.
    const before = doc.objects.size;
    engine.setFormFieldValue(doc, naam, 'राजेश');
    engine.setFormFieldValue(doc, naam, 'क्षत्रिय श्री');
    expect(doc.objects.size).toBe(before);
  });

  it('flattening bakes each widget’s own appearance, values included', async () => {
    const doc = await open('e-form-fields.pdf');
    engine.setFormFieldValue(doc, fields(doc, 'full_name')[0], 'Asha Flat');
    engine.setButtonFieldValue(doc, fields(doc, 'subscribe')[0], true);
    engine.setChoiceFieldValue(doc, fields(doc, 'country')[0], 'UK');
    const subscribe = fields(doc, 'subscribe')[0];
    const states = resolveRef((resolveRef(subscribe.dict.get('AP') as PDFObject, doc.objects) as PDFDict).get('N') as PDFObject, doc.objects) as PDFDict;
    const yesKey = (states.get('Yes') as PDFRef).toKey();
    await engine.flattenFormFieldsOnPage(doc, 0, engine.detectFormFieldsOnPage(doc, 0));
    // The check box is baked with its "on" appearance (/Yes), not the off one.
    const xo = resolveRef((doc.pages[0].dict.get('Resources') as PDFDict).get('XObject') as PDFObject, doc.objects) as PDFDict;
    expect([...xo.entries()].map(([, v]) => (v as PDFRef).toKey())).toContain(yesKey);
    const bytes = await engine.saveOptimized(doc);
    const saved = await engine.parsePDF(bytes);
    expect(engine.detectFormFieldsOnPage(saved, 0)).toHaveLength(0);
    const content = latin1(engine.getPageContentBytes(saved.pages[0], saved.objects));
    expect(content).toMatch(/\/FlatAP\d+ Do/);
    // The values are drawn (pdf.js reads text inside the baked form XObjects).
    const text = await pdfjsText(bytes);
    expect(text).toContain('Asha Flat');
    expect(text).toContain('UK');
    expect(text).toContain('2026-10-19');
  });

  it('flattening on a page that leaves a flipped CTM draws in page space', async () => {
    const doc = await open('hindi-form.pdf');
    // pdf-lib wrapped Chromium's content in q … Q when it added the fields;
    // unwrap it to get the raw Chromium stream, which starts with a flipped CTM.
    const raw = latin1(engine.getPageContentBytes(doc.pages[0], doc.objects)).trim();
    const chromium = raw.replace(/^q\s+/, '').replace(/\s*Q$/, '');
    expect(chromium).toMatch(/^[-.\d]+ 0 0 -[.\d]+ 0 [.\d]+ cm/);
    await engine.updatePageContent(doc.pages[0].contentRefs, new Uint8Array(Buffer.from(chromium, 'latin1')), doc.objects);
    engine.setFormFieldValue(doc, fields(doc, 'naam')[0], 'Rajesh');
    await engine.flattenFormFieldsOnPage(doc, 0, engine.detectFormFieldsOnPage(doc, 0));
    const after = engine.getPageContentBytes(doc.pages[0], doc.objects);
    // Every baked appearance is drawn at depth 0, after the original content is closed.
    let depth = 0;
    let sawCmAtZero = false;
    for (const ins of parseContentStream(after)) {
      if (ins.operator === 'q') depth++;
      else if (ins.operator === 'Q') depth--;
      else if (ins.operator === 'cm' && depth === 0) sawCmAtZero = true;
      else if (ins.operator === 'Do') expect(depth).toBe(1);
    }
    expect(sawCmAtZero).toBe(false);
    expect(await pdfjsText(await engine.saveOptimized(doc))).toContain('Rajesh');
  });
});

describe('Hindi watermark and annotation text', () => {
  function page(objects: Map<string, PDFObject>): PDFPageInfo {
    const contentRef = new PDFRef(2, 0);
    const dict = new PDFDict();
    dict.set('Contents', contentRef);
    dict.set('Resources', new PDFDict());
    objects.set(contentRef.toKey(), new PDFStream(new PDFDict(), new Uint8Array(0)));
    return {
      index: 0, dict, ref: new PDFRef(1, 0), resources: dict.get('Resources') as PDFDict, contentRefs: [contentRef],
      mediaBox: { x: 0, y: 0, width: 595, height: 842 }, cropBox: { x: 0, y: 0, width: 595, height: 842 }, rotate: 0,
    };
  }

  it('draws a pre-shaped text image instead of mojibake', () => {
    const objects = new Map<string, PDFObject>();
    const pg = page(objects);
    let next = 10;
    const wm: TextWatermark = {
      id: 'wm-hindi-1', type: 'text', text: 'गोपनीय', opacity: 0.5, rotation: 45, tile: false, layer: 'above',
      fontName: 'Helvetica', fontSize: 48, color: [0.5, 0.5, 0.5], position: 'center',
      raster: fakeRaster('गोपनीय', 48),
    };
    const out = latin1(applyWatermarkToPage(new Uint8Array(0), pg, objects, wm, 595, 842, () => next++));
    expect(out).toContain('/ImWM_wm-hindi_tx Do');
    expect(out).not.toMatch(/\) Tj/);
    const xo = (pg.dict.get('Resources') as PDFDict).get('XObject') as PDFDict;
    const img = objects.get((xo.get('ImWM_wm-hindi_tx') as PDFRef).toKey()) as PDFStream;
    expect(img.dict.get('SMask')).toBeInstanceOf(PDFRef);
  });

  it('gives image watermarks their pixel size and keeps PNG transparency', () => {
    const objects = new Map<string, PDFObject>();
    const pg = page(objects);
    let next = 10;
    // JPEG header: SOI, an APP0 segment, then SOF0 for a 200 × 100 image.
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x64, 0x00, 0xc8, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const samples = new Uint8Array(200 * 100).fill(128);
    const out = latin1(applyWatermarkToPage(new Uint8Array(0), pg, objects, {
      id: 'wm-image-1', type: 'image', imageBytes: jpeg, mimeType: 'image/jpeg',
      softMask: { widthPx: 200, heightPx: 100, data: new Uint8Array(deflateSync(samples)), samples },
      width: 100, height: 50, opacity: 0.5, rotation: 0, tile: false, layer: 'above', position: 'center',
    }, 595, 842, () => next++));
    // One slash: "//ImWM_… Do" names an empty XObject, which Bloom's renderer skipped.
    expect(out).toMatch(/[^/]\/ImWM_wm-image\S* Do/);
    expect(out).not.toContain('//');
    const xo = (pg.dict.get('Resources') as PDFDict).get('XObject') as PDFDict;
    const img = objects.get(([...xo.entries()][0][1] as PDFRef).toKey()) as PDFStream;
    expect(img.dict.getNumber('Width')).toBe(200);
    expect(img.dict.getNumber('Height')).toBe(100);
    const mask = objects.get((img.dict.get('SMask') as PDFRef).toKey()) as PDFStream;
    expect((mask.dict.get('ColorSpace') as PDFName).name).toBe('DeviceGray');
  });

  it('stores Hindi comment text and author as UTF-16', async () => {
    const doc = await engine.parsePDF(new Uint8Array(readFileSync(join(FORMS, 'e-form-fields.pdf'))));
    const { dict } = engine.createAnnotationDict({
      type: 'FreeText', rect: { x: 50, y: 50, width: 200, height: 40 }, color: [1, 1, 0], opacity: 1,
      text: 'यह एक टिप्पणी है', fontName: 'Helv', fontSize: 12, textColor: [0, 0, 0], borderWidth: 0,
      author: 'राजेश', contents: 'यह एक टिप्पणी है',
    } as Parameters<typeof engine.createAnnotationDict>[0], engine.getNextObjNum(doc));
    expect(dict.get('Contents')).toBeInstanceOf(PDFHexString);
    expect(dict.get('T')).toBeInstanceOf(PDFHexString);
    const ref = new PDFRef(engine.getNextObjNum(doc), 0);
    engine.addAnnotationToPage(doc.pages[0].dict, dict, ref, doc.objects);
    const { PDFDocument, PDFName: LibName, PDFDict: LibDict, PDFArray: LibArray, PDFHexString: LibHex } = await import('pdf-lib');
    const lib = await PDFDocument.load(await engine.saveOptimized(doc));
    const annots = lib.getPage(0).node.lookup(LibName.of('Annots'), LibArray);
    const texts: string[] = [];
    for (let i = 0; i < annots.size(); i++) {
      const a = annots.lookup(i, LibDict);
      const c = a.get(LibName.of('Contents'));
      if (c instanceof LibHex) texts.push(c.decodeText());
    }
    expect(texts).toContain('यह एक टिप्पणी है');
  });
});

describe('OCR text layer', () => {
  it('writes WinAnsi bytes and stretches words over their boxes', async () => {
    const doc = await engine.parsePDF(new Uint8Array(readFileSync(join(FORMS, 'e-form-fields.pdf'))));
    await engine.insertInvisibleTextLayer(doc, 0, [{ text: 'café’s', bbox: { x: 100, y: 100, width: 80, height: 12 } }]);
    const content = latin1(engine.getPageContentBytes(doc.pages[0], doc.objects));
    // é = 0xE9 and ’ = 0x92 in WinAnsi (’ used to become the invalid escape \20031).
    expect(content).toContain('(caf\\351\\222s) Tj');
    expect(content).toMatch(/[\d.]+ Tz/);
    const fonts = resolveRef((doc.pages[0].dict.get('Resources') as PDFDict).get('Font') as PDFObject, doc.objects) as PDFDict;
    const helv = resolveRef(fonts.get('Helv') as PDFObject, doc.objects) as PDFDict;
    expect((helv.get('Encoding') as PDFName).name).toBe('WinAnsiEncoding');
  });
});

describe('drawing on /Rotate pages', () => {
  // A 400 × 600 portrait MediaBox shown landscape (600 × 400 on screen).
  const at = (x: number, y: number, rotate: number) =>
    canvasToPdf(x, y, 1, rotate % 180 ? 600 : 400, rotate % 180 ? 400 : 600, 0, 0, rotate);

  it('maps the displayed top-left corner to the right unrotated corner', () => {
    expect(at(0, 0, 0)).toEqual({ pdfX: 0, pdfY: 600 });
    expect(at(0, 0, 90)).toEqual({ pdfX: 0, pdfY: 0 });
    expect(at(0, 0, 180)).toEqual({ pdfX: 400, pdfY: 0 });
    expect(at(0, 0, 270)).toEqual({ pdfX: 400, pdfY: 600 });
  });

  it('moves placed boxes (images, signatures) into the page’s own space', () => {
    const pg = { mediaBox: { x: 0, y: 0, width: 400, height: 600 }, rotate: 90 };
    // A 100 × 50 box whose top-left is 20 pt in from the displayed top-left
    // (displayed page: 600 wide, 400 tall, so its top is at y = 400 - 20).
    const at = displayBoxToPage(20, 380, 100, 50, pg);
    // Its centre (70, 45 from the displayed top-left) sits at page (45, 70).
    expect(at.x + 50).toBeCloseTo(45);
    expect(at.yTop - 25).toBeCloseTo(70);
    expect(at.rotation).toBe(-90);
    expect(displayBoxToPage(20, 380, 100, 50, { ...pg, rotate: 0 })).toEqual({ x: 20, yTop: 380, rotation: 0 });
  });

  it('maps the displayed bottom-right corner too', () => {
    expect(at(600, 400, 90)).toEqual({ pdfX: 400, pdfY: 600 });
    expect(at(400, 600, 180)).toEqual({ pdfX: 0, pdfY: 600 });
    expect(at(600, 400, 270)).toEqual({ pdfX: 0, pdfY: 0 });
  });
});
