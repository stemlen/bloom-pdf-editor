/**
 * Styling one existing line must change that line only (BE-102): italic,
 * bold and size on fonts set outside the text object or shared by a T*
 * paragraph, and left/centre/right alignment within the text column.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getPageContentBytes, interpretPage, parsePDF, applyStyleToSelection } from '@/engine';
import { buildDocumentFlow } from '@/engine/flow';
import { alignmentBoundsForLine, type TextStylePatch } from '@/engine/flow/style-edit';

async function load(name: string) {
  const doc = await parsePDF(new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'editor', name))));
  const page = doc.pages[0];
  const bytes = getPageContentBytes(page, doc.objects);
  const linesOf = (b: Uint8Array) => buildDocumentFlow(interpretPage(b, page, doc.objects).textRuns).lines;
  return { doc, page, bytes, linesOf, lines: linesOf(bytes) };
}

async function styled(name: string, index: number, style: TextStylePatch) {
  const { doc, page, bytes, linesOf, lines } = await load(name);
  const line = lines[index];
  const options = style.align ? { alignBounds: alignmentBoundsForLine(line, lines, page) } : undefined;
  const result = applyStyleToSelection(bytes, page, doc.objects, line, 0, line.text.length, style, options);
  return { before: lines, after: linesOf(result.newContentBytes), result };
}

const fonts = (l: { runs: { fontName: string }[] }) => l.runs.map(r => r.fontName).join(',');

describe('line styling (BE-102)', () => {
  it('italicises a line whose font was set in an earlier text object', async () => {
    const { before, after } = await styled('a-simple-1page.pdf', 2, { italic: true });
    expect(fonts(after[2])).toBe('HelveticaOblique');
    for (const i of [1, 3, 4, 5]) expect(fonts(after[i])).toBe(fonts(before[i]));
  });

  it('italicises one line of a T* paragraph, not the whole paragraph', async () => {
    const { before, after } = await styled('b-mixed-5pages.pdf', 2, { italic: true });
    expect(fonts(after[2])).not.toBe(fonts(before[2]));
    for (const i of [3, 4, 5]) expect(fonts(after[i])).toBe(fonts(before[i]));
  });

  it('adds an underline stroke under the line', async () => {
    const { result } = await styled('a-simple-1page.pdf', 2, { underline: true });
    expect(result.addedUnderline).toBe(true);
  });

  it.each([
    ['right', 312.5],
    ['center', 192.3],
  ] as const)('aligns a line %s within the column', async (align, x) => {
    const { before, after } = await styled('a-simple-1page.pdf', 2, { align });
    expect(after[2].x).toBeCloseTo(x, 0);
    for (const i of [1, 3]) expect(after[i].x).toBeCloseTo(before[i].x, 1);
  });

  it('aligns one line of a T* paragraph without moving the next lines', async () => {
    const { before, after } = await styled('b-mixed-5pages.pdf', 2, { align: 'right' });
    expect(after[2].x).toBeGreaterThan(before[2].x + 5);
    for (const i of [3, 4, 5]) expect(after[i].x).toBeCloseTo(before[i].x, 1);
  });
});

describe('Add Row Below moves the table grid (BE-103)', () => {
  it('adds a row of borders and lengthens the grid', async () => {
    const { detectTablesOnPage, duplicateTableRowBelow, getTableRowLines } = await import('@/engine');
    const doc = await parsePDF(new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'editor', 'b-mixed-5pages.pdf'))));
    const page = doc.pages[1];
    const bytes = getPageContentBytes(page, doc.objects);
    const lines = buildDocumentFlow(interpretPage(bytes, page, doc.objects).textRuns).lines;
    const [table] = detectTablesOnPage(lines, []);
    const row = getTableRowLines(table, 3);
    const base = Math.min(...row.map(l => l.baseline));
    const out = duplicateTableRowBelow(bytes, row, lines.filter(l => l.baseline < base - 1), 18);
    const paths = (b: Uint8Array) => interpretPage(b, page, doc.objects).displayList
      .filter((d) => d.type === 'path') as { width: number; height: number; y: number }[];
    const horizontals = (b: Uint8Array) => paths(b).filter(p => p.height < 0.1 && p.width > 100).map(p => Math.round(p.y));
    expect(horizontals(out).length).toBe(horizontals(bytes).length + 1);
    expect(Math.min(...horizontals(out))).toBe(Math.min(...horizontals(bytes)) - 18);
    const tallest = (b: Uint8Array) => Math.max(...paths(b).map(p => p.height));
    expect(tallest(out)).toBeCloseTo(tallest(bytes) + 18, 1);
  });
});
