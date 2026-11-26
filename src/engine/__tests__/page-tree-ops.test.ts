import { describe, it, expect } from 'vitest';
import * as engine from '../index';
import { saveDocumentBytes } from '@/workers/pdf/core';

/**
 * Six pages in a nested page tree, the shape Word, Chrome and pdfTeX write:
 *   root /Pages (MediaBox 612x792, shared font)
 *     ├─ /Pages A: Page1..Page3, /Rotate 90 inherited
 *     └─ /Pages B: Page4..Page6, landscape /MediaBox inherited
 */
function nestedTreePdf(): Uint8Array {
  const objs: string[] = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 6 /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> >>';
  objs[3] = '<< /Type /Pages /Parent 2 0 R /Kids [6 0 R 7 0 R 8 0 R] /Count 3 /Rotate 90 >>';
  objs[4] = '<< /Type /Pages /Parent 2 0 R /Kids [9 0 R 10 0 R 11 0 R] /Count 3 /MediaBox [0 0 842 595] >>';
  objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  for (let i = 0; i < 6; i++) {
    objs[6 + i] = `<< /Type /Page /Parent ${i < 3 ? 3 : 4} 0 R /Contents ${12 + i} 0 R >>`;
    const s = `BT /F1 24 Tf 72 400 Td (Page${i + 1}) Tj ET`;
    objs[12 + i] = `<< /Length ${s.length} >>\nstream\n${s}\nendstream`;
  }
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let n = 1; n < objs.length; n++) {
    offsets[n] = out.length;
    out += `${n} 0 obj\n${objs[n]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objs.length; n++) out += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** "text:rotation:WxH" per page, as an independent reader (pdf.js) sees the file. */
async function pagesSeenByPdfJs(bytes: Uint8Array): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const text = (await page.getTextContent()).items.map((it) => ('str' in it ? it.str : '')).join('');
    out.push(`${text || 'blank'}:${page.rotate}:${Math.round(page.view[2])}x${Math.round(page.view[3])}`);
  }
  return out;
}

const P = ['Page1:90:612x792', 'Page2:90:612x792', 'Page3:90:612x792', 'Page4:0:842x595', 'Page5:0:842x595', 'Page6:0:842x595'];

describe('page operations on a nested page tree', () => {
  it('the fixture reads as expected', async () => {
    expect(await pagesSeenByPdfJs(nestedTreePdf())).toEqual(P);
  });

  for (const mode of ['quick', 'optimized'] as const) {
    it(`deleting a page under an intermediate /Pages node removes it from the saved file (${mode})`, async () => {
      const doc = await engine.parsePDF(nestedTreePdf());
      engine.deletePage(doc, 1);
      engine.deletePage(doc, 3); // Page5
      const bytes = await saveDocumentBytes(doc, mode);
      expect(await pagesSeenByPdfJs(bytes)).toEqual([P[0], P[2], P[3], P[5]]);
      expect((await engine.parsePDF(bytes)).pages.length).toBe(4);
    });

    it(`moved pages keep inherited rotation, size and fonts (${mode})`, async () => {
      const doc = await engine.parsePDF(nestedTreePdf());
      engine.movePage(doc, 5, 0);
      engine.movePage(doc, 1, 5);
      const bytes = await saveDocumentBytes(doc, mode);
      expect(await pagesSeenByPdfJs(bytes)).toEqual([P[5], P[1], P[2], P[3], P[4], P[0]]);
      // Every page now hangs directly off the root, so the tree is consistent.
      const reparsed = await engine.parsePDF(bytes);
      const rootRef = reparsed.catalog.getRef('Pages')!;
      for (const page of reparsed.pages) expect(page.dict.getRef('Parent')?.equals(rootRef)).toBe(true);
    });
  }
});
