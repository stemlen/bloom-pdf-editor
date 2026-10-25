/**
 * Bloom's own Ink and Highlight annotations must survive a save and reopen
 * with their appearance streams (BE-301).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as engine from '../index';
import { PDFArray, PDFDict, PDFName, PDFRef, PDFStream } from '../types';
import { resolveRef } from '../parser/parser';

describe('annotation round trip', () => {
  it('keeps /AP /N as an indirect stream after reopening', async () => {
    const doc = await engine.parsePDF(new Uint8Array(readFileSync(join(__dirname, 'fixtures/tables/invoice-table.pdf'))));
    const page = doc.pages[0];
    const ink = engine.createAnnotationDict({
      type: 'Ink',
      rect: { x: 90, y: 90, width: 120, height: 40 },
      color: [1, 0, 0],
      opacity: 1,
      inkPaths: [[100, 100, 150, 120, 200, 110]],
      lineWidth: 2,
    }, engine.getNextObjNum(doc));
    engine.addAnnotationToPage(page.dict, ink.dict, new engine.PDFRef(engine.getNextObjNum(doc), 0), doc.objects);

    const reopened = await engine.parsePDF(await engine.saveOptimized(doc));
    const annots = resolveRef(reopened.pages[0].dict.get('Annots') as PDFRef, reopened.objects) as PDFArray;
    const inkDict = annots.items
      .map((r) => resolveRef(r, reopened.objects))
      .find((d) => d instanceof PDFDict && (d.get('Subtype') as PDFName)?.name === 'Ink') as PDFDict;
    expect(inkDict).toBeTruthy();
    const ap = resolveRef(inkDict.get('AP') as PDFRef, reopened.objects) as PDFDict;
    expect(ap.get('N')).toBeInstanceOf(PDFRef);
    expect(resolveRef(ap.get('N') as PDFRef, reopened.objects)).toBeInstanceOf(PDFStream);
  });
});
