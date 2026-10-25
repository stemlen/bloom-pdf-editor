/**
 * Colour emoji printed by Chrome are Type3 glyphs that paint an image from
 * the font's own resources (BE-205).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as engine from '../index';
import { loadPageFonts } from '../fonts/font-parser';

const FIXTURE = join(__dirname, 'fixtures/fonts/j-unicode-hindi-emoji.pdf');

describe('Type3 image glyphs (BE-205)', () => {
  it('collects the images that emoji glyphs paint', async () => {
    const doc = await engine.parsePDF(new Uint8Array(readFileSync(FIXTURE)));
    const fonts = loadPageFonts(doc.pages[0].resources, doc.objects);
    const withImages = [...fonts.values()].filter((f) => (f.type3Images?.size ?? 0) > 0);
    expect(withImages.length).toBeGreaterThan(0);
    for (const font of withImages) {
      for (const stream of font.type3Images!.values()) {
        expect(stream.dict.getNumber('Width')).toBeGreaterThan(0);
      }
    }
  });

  it('detects newly typed emoji', () => {
    expect(engine.hasEmoji('Hello 🌸')).toBe(true);
    expect(engine.hasEmoji('नमस्ते')).toBe(false);
    expect(engine.countEmoji('🌸 and 🎉')).toBe(2);
  });
});
