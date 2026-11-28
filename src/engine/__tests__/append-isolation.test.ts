/**
 * Content appended to a page (text boxes, duplicated lines, new table cells)
 * must not inherit graphics state the page's own content leaves behind.
 * Chrome/Skia PDFs (like j-unicode-hindi-emoji.pdf) begin with a bare
 * `.24 0 0 -.24 0 792 cm` that is never restored and write one Td per glyph.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  applyLineTextEdit,
  applyRunPositionShifts,
  duplicateLineBelow,
  getPageContentBytes,
  insertTableColumnRight,
  interpretPage,
  parsePDF,
  visualFontSize,
} from '@/engine';
import { buildDocumentFlow } from '@/engine/flow';
import { insertTextBox } from '@/engine/editor/text-box';
import { analyzeStateLeak, appendIsolatedContent } from '@/engine/content/append-isolation';
import { parseContentStream } from '@/engine/content/operator-lexer';
import type { PDFDocumentData } from '@/engine';

const enc = (s: string) => new TextEncoder().encode(s);
const leakOf = (s: string) => analyzeStateLeak(parseContentStream(enc(s)));

const chromeFile = join(__dirname, 'fixtures', 'fonts', 'j-unicode-hindi-emoji.pdf');
async function chrome() {
  const doc = await parsePDF(new Uint8Array(readFileSync(chromeFile)));
  const bytes = getPageContentBytes(doc.pages[0], doc.objects);
  return { doc, bytes };
}
const linesOf = (doc: PDFDocumentData, bytes: Uint8Array) =>
  buildDocumentFlow(interpretPage(bytes, doc.pages[0], doc.objects).textRuns).lines;

describe('analyzeStateLeak', () => {
  it('leaves balanced content that restores its own state alone', () => {
    expect(leakOf('q 1 0 0 1 5 5 cm BT /F1 12 Tf (a) Tj ET Q').leaks).toBe(false);
    expect(leakOf('BT /F1 12 Tf 1 0 0 1 9 9 Tm (a) Tj ET').leaks).toBe(false);
  });

  it('flags a top-level cm, clip or text state, and unbalanced q/Q', () => {
    expect(leakOf('.24 0 0 -.24 0 792 cm q Q')).toEqual({ leaks: true, prefix: 1, suffix: 1 });
    expect(leakOf('0 0 10 10 re W n').leaks).toBe(true);
    expect(leakOf('3 Tr').leaks).toBe(true);
    expect(leakOf('q q 2 0 0 2 0 0 cm')).toEqual({ leaks: true, prefix: 1, suffix: 3 });
    // A stray Q must not pop the wrapper's own q.
    expect(leakOf('Q q 2 0 0 2 0 0 cm Q')).toEqual({ leaks: true, prefix: 2, suffix: 1 });
  });

  it('wraps the original bytes verbatim, closing any open q', () => {
    const out = new TextDecoder().decode(appendIsolatedContent(enc('q 2 0 0 2 0 0 cm'), enc('INJ')));
    expect(out).toBe('q\nq 2 0 0 2 0 0 cm\nQ\nQ\nINJ');
    expect(new TextDecoder().decode(appendIsolatedContent(enc('q Q'), enc('INJ')))).toBe('q QINJ');
  });
});

describe('appending to a Chrome-printed page (flipped, scaled CTM)', () => {
  it('a text box lands where it was placed, at its size, upright', async () => {
    const { doc, bytes } = await chrome();
    const page = doc.pages[0];
    const next = insertTextBox(bytes, page, doc.objects, 'Approved by QA', { fontSize: 14 }, 100, 300);
    const run = interpretPage(next, page, doc.objects).textRuns.find(r => r.text.includes('Approved'));
    expect(run).toBeDefined();
    expect(run!.x).toBeCloseTo(100, 0);
    expect(run!.y).toBeGreaterThan(280);
    expect(run!.y).toBeLessThan(300);
    expect(visualFontSize(run!)).toBeCloseTo(14, 0);
    // Upright: the rendering matrix keeps a positive y scale.
    expect(run!.glyphs[0].tRm.d).toBeGreaterThan(0);
  });

  it('Duplicate Line Below copies the line one row down without scattering its glyphs', async () => {
    const { doc, bytes } = await chrome();
    const before = linesOf(doc, bytes);
    const line = before.find(l => l.text.startsWith('Math:'))!; // last line: room below it
    expect(line).toBeDefined();
    const after = linesOf(doc, duplicateLineBelow(bytes, line));
    const copies = after.filter(l => l.text === line.text);
    expect(copies.length).toBe(2);
    const copy = copies.find(l => l.baseline < line.baseline - 1)!;
    expect(copy).toBeDefined();
    expect(copy.x).toBeCloseTo(line.x, 0);
    expect(line.baseline - copy.baseline).toBeGreaterThan(line.fontSize);
    expect(line.baseline - copy.baseline).toBeLessThan(line.fontSize * 2);
    // Every other line is untouched (no glyph strays onto new baselines).
    expect(after.length).toBe(before.length + 1);
  });

  it('Add Column Right puts readable placeholders on each row baseline at the row size', async () => {
    const { doc, bytes } = await chrome();
    const page = doc.pages[0];
    const lines = linesOf(doc, bytes).slice(0, 2);
    const next = insertTableColumnRight(bytes, lines.map(l => [l]), page, doc.objects);
    const added = linesOf(doc, next).filter(l => l.text === 'New');
    expect(added.length).toBe(2);
    for (let i = 0; i < 2; i++) {
      expect(added.some(a => Math.abs(a.baseline - lines[i].baseline) < 1)).toBe(true);
    }
    const sizes = added.map(a => visualFontSize(a.runs[0])).sort((a, b) => a - b);
    const want = lines.map(l => visualFontSize(l.runs[0])).sort((a, b) => a - b);
    expect(sizes[0]).toBeCloseTo(want[0], 0);
    expect(sizes[1]).toBeCloseTo(want[1], 0);
  });
});

describe('moving runs on a Chrome-printed page (shifts are in page space)', () => {
  const runs = (doc: PDFDocumentData, bytes: Uint8Array) =>
    interpretPage(bytes, doc.pages[0], doc.objects).textRuns;

  it('a relative Td under a scaled, flipped CTM moves the run by exactly dx / dy', async () => {
    const { doc, bytes } = await chrome();
    const line = linesOf(doc, bytes).find(l => l.text.startsWith('Accents'))!;
    const dash = line.segments.find(s => s.text === '—')!.run; // positioned by "4.16 0 Td"
    const next = applyRunPositionShifts(bytes, [{ run: dash, dx: 20, dy: -6 }]);
    const moved = runs(doc, next).find(r => r.text === '—' && Math.abs(r.y - (dash.y - 6)) < 0.5);
    expect(moved).toBeDefined();
    expect(moved!.x - dash.x).toBeCloseTo(20, 1);
  });

  it('typing mid-line pushes the rest of the line right by the full growth', async () => {
    const { doc, bytes } = await chrome();
    const page = doc.pages[0];
    const flow = buildDocumentFlow(interpretPage(bytes, page, doc.objects).textRuns);
    const line = flow.lines.find(l => l.text.startsWith('Accents'))!;
    const dashBefore = line.segments.find(s => s.text === '—')!.run.x;
    const caret = 'Accents: café'.length;
    const newText = `${line.text.slice(0, caret)} XYZW${line.text.slice(caret)}`;
    const res = applyLineTextEdit(bytes, page, doc.objects, line, newText, flow, { oldText: line.text, caretAfter: caret + 5 });
    const dash = runs(doc, res.newContentBytes).find(r => r.text === '—' && Math.abs(r.y - line.baseline) < 2)!;
    // " XYZW" is ~38pt of 12pt Helvetica; under the 0.75 CTM the trailer
    // used to move only three quarters of the budgeted growth (~20pt).
    expect(dash.x - dashBefore).toBeGreaterThan(25);
  });
});
