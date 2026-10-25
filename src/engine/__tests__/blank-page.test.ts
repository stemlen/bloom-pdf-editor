import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as engine from '../index';

describe('insertBlankPage', () => {
  it('uses the size of the neighbouring page (BE-510)', async () => {
    const doc = await engine.parsePDF(new Uint8Array(readFileSync(join(__dirname, 'fixtures/tables/invoice-table.pdf'))));
    const { width, height } = doc.pages[0].mediaBox;
    engine.insertBlankPage(doc, 1);
    const reopened = await engine.parsePDF(await engine.saveOptimized(doc));
    expect(reopened.pages[1].mediaBox.width).toBeCloseTo(width);
    expect(reopened.pages[1].mediaBox.height).toBeCloseTo(height);
  });
});
