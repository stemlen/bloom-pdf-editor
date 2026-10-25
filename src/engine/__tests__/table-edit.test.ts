/**
 * Table detection and row/column insertion on a real ReportLab table
 * (page 2 of invoice-table.pdf: Item | Qty | Price | Total, 8 rows, each cell
 * its own text object inside a translated q/cm block).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  detectTablesOnPage,
  duplicateTableRowBelow,
  getPageContentBytes,
  getTableRowLines,
  insertTableColumnRight,
  interpretPage,
  parsePDF,
} from '@/engine';
import { buildDocumentFlow } from '@/engine/flow';
import type { PDFDocumentData } from '@/engine';

const file = join(__dirname, 'fixtures', 'tables', 'invoice-table.pdf');

async function setup() {
  const doc = await parsePDF(new Uint8Array(readFileSync(file)));
  const bytes = getPageContentBytes(doc.pages[1], doc.objects);
  return { doc, bytes };
}
const linesOf = (doc: PDFDocumentData, bytes: Uint8Array) =>
  buildDocumentFlow(interpretPage(bytes, doc.pages[1], doc.objects).textRuns).lines;

describe('table editing on a ReportLab table', () => {
  it('splits tight cells and detects 8 rows × 4 columns', async () => {
    const { doc, bytes } = await setup();
    const lines = linesOf(doc, bytes);
    expect(lines.map(l => l.text)).toContain('Product 3');
    expect(lines.map(l => l.text)).not.toContain('QtyPrice');
    const [table] = detectTablesOnPage(lines, []);
    expect(table.rows).toBe(8);
    expect(table.cols).toBe(4);
  });

  it('Add Row Below inserts a row in place and moves the rows below down', async () => {
    const { doc, bytes } = await setup();
    const lines = linesOf(doc, bytes);
    const [table] = detectTablesOnPage(lines, []);
    const row = getTableRowLines(table, 3); // Product 3
    const base = Math.min(...row.map(l => l.baseline));
    const below = lines.filter(l => l.baseline < base - 1);
    const next = linesOf(doc, duplicateTableRowBelow(bytes, row, below, 18));

    const product3 = next.filter(l => l.text === 'Product 3').map(l => Math.round(l.baseline));
    expect(product3).toEqual([583, 565]);
    expect(Math.round(next.find(l => l.text === 'Product 4')!.baseline)).toBe(547);
    // Nothing merged into a stray line, and nothing dropped to the page bottom.
    expect(next.every(l => !/Product \d.*Product/.test(l.text))).toBe(true);
    expect(Math.min(...next.map(l => l.baseline))).toBeGreaterThan(400);
  });

  it('Add Column Right adds one visible cell per row on a common x', async () => {
    const { doc, bytes } = await setup();
    const lines = linesOf(doc, bytes);
    const [table] = detectTablesOnPage(lines, []);
    const rows = Array.from({ length: table.rows }, (_, r) => getTableRowLines(table, r));
    const next = linesOf(doc, insertTableColumnRight(bytes, rows));
    const added = next.filter(l => l.text === 'New');
    expect(added.length).toBe(8);
    expect(new Set(added.map(l => l.x.toFixed(1))).size).toBe(1);
    const [after] = detectTablesOnPage(next, []);
    expect(after.cols).toBe(5);
  });
});
