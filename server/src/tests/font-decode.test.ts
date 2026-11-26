import { describe, it, expect } from 'vitest';
import { decodeTextString, type LoadedFont } from '../engines/parser/font-decode.js';
import { parseCMap } from '../engines/parser/cmap.js';

function font(partial: Partial<LoadedFont>): LoadedFont {
  return {
    resourceName: 'F1',
    baseFont: 'Test',
    subtype: 'Type0',
    encoding: 'Identity-H',
    isComposite: true,
    codeBytes: 2,
    toUnicode: new Map(),
    toCID: new Map(),
    widths: new Map(),
    defaultWidth: 500,
    differences: new Map(),
    ...partial,
  };
}

describe('PDF font decoding', () => {
  it('maps Identity-H 2-byte codes via ToUnicode', () => {
    const cmapSrc = `
/CIDInit /ProcSet findresource begin
12 dict begin begincmap
/CMapType 2 def
1 begincodespacerange <0000> <FFFF> endcodespacerange
3 beginbfchar
<0048> <0048>
<0069> <0069>
<0021> <0021>
endbfchar
endcmap end end
`;
    const cmap = parseCMap(new TextEncoder().encode(cmapSrc));
    const f = font({ toUnicode: cmap.toUnicode, codeBytes: 2 });
    // Hex <004800690021> as latin1 bytes
    const raw = String.fromCharCode(0x00, 0x48, 0x00, 0x69, 0x00, 0x21);
    const glyphs = decodeTextString(raw, f);
    expect(glyphs.map((g) => g.unicode).join('')).toBe('Hi!');
  });

  it('uses WinAnsi for high bytes on simple fonts', () => {
    const f = font({
      subtype: 'TrueType',
      encoding: 'WinAnsiEncoding',
      isComposite: false,
      codeBytes: 1,
    });
    const raw = String.fromCharCode(0x95); // bullet
    const glyphs = decodeTextString(raw, f);
    expect(glyphs[0]?.unicode).toBe('\u2022');
  });

  it('keeps painted glyphs that have no Unicode mapping, so the pen still advances', () => {
    // A shaped Devanagari half-form has a glyph and a width but no ToUnicode entry.
    const f = font({ toUnicode: new Map([[0x0001, 'क']]), widths: new Map([[2, 300], [1, 600]]) });
    const glyphs = decodeTextString(String.fromCharCode(0, 2, 0, 1), f);
    expect(glyphs.map((g) => [g.unicode, g.width1000])).toEqual([
      ['', 300],
      ['क', 600],
    ]);
  });
});
