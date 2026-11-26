/**
 * Optimized save subsets embedded TrueType fonts; every glyph that is drawn
 * must survive. Fixture: j2-unicode-truetype-text (reportlab, simple TrueType
 * DejaVu Sans + Mukta, literal strings with escaped parentheses).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parsePDF, getPageContentBytes } from '../parser/parser';
import { interpretPage } from '../content/interpreter';
import { loadPageFonts } from '../fonts/font-parser';
import { getGlyphOutline } from '../fonts/truetype-parser';
import { subsetFonts } from '../optimize/font-subsetter';

const FIXTURES = join(__dirname, 'fixtures/fonts');
const load = async (name: string) => parsePDF(new Uint8Array(readFileSync(join(FIXTURES, name))));

describe('font subsetting on optimized save', () => {
  it('keeps every glyph that is drawn, including text in literal strings with escaped parentheses', async () => {
    const doc = await load('j2-unicode-truetype-text.pdf');
    const inkedGlyphs = () => {
      const page = doc.pages[0];
      const fonts = loadPageFonts(page.resources, doc.objects);
      const res = interpretPage(getPageContentBytes(page, doc.objects), page, doc.objects);
      const out: string[] = [];
      for (const run of res.textRuns) {
        const ttf = fonts.get(run.fontName)?.ttfFont;
        if (!ttf) continue;
        for (const g of run.glyphs) {
          const gid = ttf.cmapEntries.get(g.charCode) ?? ttf.cmapEntries.get(0xf000 + g.charCode) ?? 0;
          if ((getGlyphOutline(ttf, gid)?.commands.length ?? 0) > 0) out.push(`${run.fontName}:${gid}`);
        }
      }
      return out;
    };
    const before = inkedGlyphs();
    expect(before.length).toBeGreaterThan(150);
    const result = await subsetFonts(doc);
    expect(result.fontsSubsetted).toBeGreaterThan(0);
    expect(inkedGlyphs()).toEqual(before);
  });
});
