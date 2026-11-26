import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as engine from '../index';
import type { TextRun } from '../content/interpreter';

const fixture = (name: string) => new Uint8Array(readFileSync(join(__dirname, '../../../tests/fixtures', name)));

async function load(name: string) {
  const doc = await engine.parsePDF(fixture(name));
  const page = doc.pages[0];
  const runs = () => engine.interpretPage(engine.getPageContentBytes(page, doc.objects), page, doc.objects).textRuns;
  const count = (q: string, caseSensitive = false) => engine.findTextMatches(runs(), q, caseSensitive).length;
  const replace = async (q: string, r: string, occurrence?: number) => {
    const bytes = engine.getPageContentBytes(page, doc.objects);
    const result = engine.findAndReplace(bytes, page, doc.objects, q, r, false, occurrence);
    await engine.updatePageContent(page.contentRefs, result.newContentBytes, doc.objects);
    return result;
  };
  return { doc, runs, count, replace };
}

async function pdfJsText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  const content = await (await doc.getPage(1)).getTextContent();
  return content.items.map((i) => ('str' in i ? i.str : '')).join('');
}

const run = (text: string, x: number, width: number, y = 700): TextRun =>
  ({ text, x, y, width, height: 12, fontSize: 12, glyphs: [] }) as unknown as TextRun;

describe('find & replace across text runs', () => {
  it('chains runs that touch on one baseline, including zero-width matras', () => {
    // "क" ends at 22.9; the matra "ृ" is drawn inside it (zero width); "ष्ण" starts at 22.9.
    const chains = engine.buildTextChains([
      run(' क', 11, 11.9), run('ृ', 20.1, 0), run('ष्ण', 22.9, 12.1),
      run('next', 60, 20), // a visible gap: separate chain
      run('below', 35, 20, 680), // another line
    ]);
    expect(chains.map((c) => c.text)).toEqual([' कृष्ण', 'next', 'below']);
  });

  it('finds Latin and Devanagari words that a PDF draws with several runs', async () => {
    // hindi-mixed-en.pdf draws "M"+"eeting", "N"+"otes" and "नोट"+"्स" as separate runs.
    const { runs, count } = await load('hindi-mixed-en.pdf');
    expect(runs().some((r) => r.text.includes('Meeting'))).toBe(false);
    expect(count('Meeting')).toBe(1);
    expect(count('meeting notes')).toBe(1);
    expect(count('meeting', true)).toBe(0);
    expect(count('नोट्स')).toBe(1);
    expect(count('भारत')).toBe(4);
  });

  it('highlights cover the whole split word', async () => {
    const { runs } = await load('hindi-mixed-en.pdf');
    const [m] = engine.findTextMatches(runs(), 'Meeting');
    const box = engine.textMatchBounds(m);
    const notes = engine.textMatchBounds(engine.findTextMatches(runs(), 'Notes')[0]);
    expect(box.width).toBeGreaterThan(30);
    expect(box.x + box.width).toBeLessThanOrEqual(notes.x);
  });

  it('replaces a split word and the saved file reads correctly', async () => {
    const { doc, count, replace } = await load('hindi-mixed-en.pdf');
    const result = await replace('Meeting', 'Session');
    expect(result.missingCharCodes).toEqual([]);
    expect(count('Meeting')).toBe(0);
    expect(count('Session')).toBe(1);
    expect(await pdfJsText(await engine.saveOptimized(doc))).toMatch(/^Session\s*Notes/);
  });

  it('replaces one occurrence only, counted like the match list', async () => {
    const { count, replace } = await load('hindi-mixed-en.pdf');
    await replace('भारत', 'देश', 2);
    expect(count('भारत')).toBe(3);
  });

  it('writes Devanagari the document fonts can show', async () => {
    const { doc, count, replace } = await load('hindi-mixed-en.pdf');
    const result = await replace('बजट', 'भारत');
    expect(result.missingCharCodes).toEqual([]);
    expect(count('बजट')).toBe(0);
    expect(count('भारत')).toBe(5);
    const text = await pdfJsText(await engine.saveOptimized(doc));
    expect(text).not.toContain('बजट');
    expect(text).not.toContain('?');
  });

  it('reports letters the fonts cannot show instead of hiding them', async () => {
    const { replace } = await load('hindi-mixed-en.pdf');
    const result = await replace('भारत', 'हिंदुस्तान');
    expect(result.missingCharCodes.length).toBeGreaterThan(0);
  });

  it('treats $ patterns in the replacement literally', async () => {
    const { count, replace } = await load('sample.pdf');
    await replace('Bloom', 'US$$');
    expect(count('Bloom', true)).toBe(0);
    expect(count('US$$', true)).toBeGreaterThan(0);
  });
});
