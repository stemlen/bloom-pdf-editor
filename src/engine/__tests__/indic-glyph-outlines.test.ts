/**
 * Complex-script CID TrueType fonts are drawn from their embedded glyph
 * outlines (Devanagari conjuncts, reph and pre-base ि exactly as printed).
 * Fixtures: hi-2-table-invoice (Chromium, Devanagari Sangam MN, Identity-H)
 * and j2-unicode-truetype-text (reportlab, simple TrueType).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parsePDF, getPageContentBytes } from '../parser/parser';
import { interpretPage } from '../content/interpreter';
import { loadPageFonts } from '../fonts/font-parser';
import { getGlyphOutline } from '../fonts/truetype-parser';
import { usesGlyphOutlines, outlineGlyphId, drawOutlineGlyph } from '../render/glyph-outlines';

const FIXTURES = join(__dirname, 'fixtures/fonts');
const load = async (name: string) => parsePDF(new Uint8Array(readFileSync(join(FIXTURES, name))));

function pageRuns(doc: Awaited<ReturnType<typeof parsePDF>>, pageIndex = 0) {
  const page = doc.pages[pageIndex];
  return interpretPage(getPageContentBytes(page, doc.objects), page, doc.objects).textRuns;
}

describe('glyph-outline rendering of complex-script CID TrueType fonts', () => {
  it('selects the embedded Devanagari CIDFontType2 fonts and not simple/Latin fonts', async () => {
    const hi2 = await load('hi-2-table-invoice.pdf');
    const fonts = [...loadPageFonts(hi2.pages[0].resources, hi2.objects).values()];
    expect(fonts.filter(f => f.ttfFont).every(f => usesGlyphOutlines(f))).toBe(true);

    const j2 = await load('j2-unicode-truetype-text.pdf');
    const simple = [...loadPageFonts(j2.pages[0].resources, j2.objects).values()];
    expect(simple.some(f => usesGlyphOutlines(f))).toBe(false);
  });

  it('draws every glyph of the invoice from the font program', async () => {
    const doc = await load('hi-2-table-invoice.pdf');
    const fonts = loadPageFonts(doc.pages[0].resources, doc.objects);
    const runs = pageRuns(doc);
    const calls: string[] = [];
    const ctx = new Proxy({}, {
      get: (_t, prop) => (...args: unknown[]) => { calls.push(String(prop)); return args; },
    }) as unknown as CanvasRenderingContext2D;
    let drawn = 0;
    for (const run of runs) {
      const font = fonts.get(run.fontName);
      if (!usesGlyphOutlines(font)) continue;
      for (const g of run.glyphs) {
        if (g.unicode === ' ') continue;
        expect(drawOutlineGlyph(ctx, font.ttfFont, outlineGlyphId(font, g.charCode), g.tRm, g.tRm.e, g.tRm.f)).toBe(true);
        drawn++;
      }
    }
    expect(drawn).toBeGreaterThan(100);
    expect(calls.filter(c => c === 'fill').length).toBeGreaterThan(100);
  });

  it('walks each TrueType contour exactly once and closes it at its start point', async () => {
    const doc = await load('hi-2-table-invoice.pdf');
    const font = [...loadPageFonts(doc.pages[0].resources, doc.objects).values()].find(f => f.ttfFont)!.ttfFont!;
    let contours = 0;
    for (let gid = 1; gid < font.numGlyphs; gid++) {
      const outline = getGlyphOutline(font, gid);
      if (!outline) continue;
      let start: number[] = [];
      let last: number[] = [];
      for (const cmd of outline.commands) {
        if (cmd.type === 'M') start = cmd.args;
        else if (cmd.type === 'Z') {
          expect(last[0]).toBeCloseTo(start[0], 6);
          expect(last[1]).toBeCloseTo(start[1], 6);
          contours++;
        } else last = cmd.args.slice(-2);
      }
    }
    expect(contours).toBeGreaterThan(10);
  });
});
