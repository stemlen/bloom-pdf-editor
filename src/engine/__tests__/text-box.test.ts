import { describe, expect, it } from 'vitest';
import {
  buildTextBoxOperators,
  encodeWinAnsi,
  insertTextBox,
  layoutTextBox,
  measureTextBoxString,
  resolveTextBoxStyle,
  textBoxFace,
} from '../editor/text-box';
import { PDFDict, PDFName, type PDFPageInfo } from '../types';

const page = () => ({ dict: new PDFDict() } as unknown as PDFPageInfo);

describe('text box faces', () => {
  it('maps family and style onto Standard 14 faces', () => {
    expect(textBoxFace('Helvetica', false, false)).toBe('Helvetica');
    expect(textBoxFace('Arial', true, true)).toBe('Helvetica-BoldOblique');
    expect(textBoxFace('Times New Roman', true, false)).toBe('Times-Bold');
    expect(textBoxFace('Times New Roman', false, true)).toBe('Times-Italic');
    expect(textBoxFace('Courier', false, true)).toBe('Courier-Oblique');
  });
});

describe('measurement', () => {
  it('uses AFM widths and adds letter spacing between characters', () => {
    // Helvetica "AV" = 667 + 667 per 1000 em
    expect(measureTextBoxString('AV', 'Helvetica', 10)).toBeCloseTo(13.34, 5);
    expect(measureTextBoxString('AV', 'Helvetica', 10, 1)).toBeCloseTo(14.34, 5);
    expect(measureTextBoxString('a b', 'Courier', 10, 0, 2)).toBeCloseTo(20, 5);
  });
  it('gives the bullet its AFM width', () => {
    expect(measureTextBoxString('\u2022', 'Helvetica', 10)).toBeCloseTo(3.5, 5);
  });
  it('encodes WinAnsi characters and replaces unsupported ones', () => {
    expect(encodeWinAnsi('é•—\u4e2d')).toBe('\u00e9\u0095\u0097?');
  });
});

describe('layout', () => {
  it('spaces lines by font size × line height', () => {
    const l = layoutTextBox('one\ntwo\nthree', { fontSize: 10, lineHeight: 1.5 });
    expect(l.lines).toHaveLength(3);
    expect(l.lines[1].baseline - l.lines[0].baseline).toBeCloseTo(15, 6);
    expect(l.height).toBeCloseTo(45, 6);
  });

  it('wraps at the box width and justifies every line but the last', () => {
    const text = 'The quick brown fox jumps over the lazy dog again and again';
    const l = layoutTextBox(text, { fontSize: 12, align: 'justify' }, 120);
    expect(l.lines.length).toBeGreaterThan(2);
    for (const line of l.lines.slice(0, -1)) {
      expect(line.width).toBeCloseTo(120, 6);
      expect(line.wordSpacing).toBeGreaterThan(0);
    }
    expect(l.lines.at(-1)!.wordSpacing).toBe(0);
  });

  it('centres and right-aligns within the box', () => {
    const c = layoutTextBox('Hi', { fontSize: 10, align: 'center' }, 100);
    const r = layoutTextBox('Hi', { fontSize: 10, align: 'right' }, 100);
    const w = measureTextBoxString('Hi', 'Helvetica', 10);
    expect(c.lines[0].x).toBeCloseTo((100 - w) / 2, 6);
    expect(r.lines[0].x + r.lines[0].width).toBeCloseTo(100, 6);
  });

  it('numbers non-empty paragraphs and hangs the text after the marker', () => {
    const l = layoutTextBox('first\n\nsecond', { fontSize: 10, list: 'numbered' });
    expect(l.lines.map(x => x.marker)).toEqual(['1.', undefined, '2.']);
    expect(l.indent).toBeGreaterThan(0);
    expect(l.lines[0].x).toBe(l.indent);
    expect(l.lines[0].markerX! + measureTextBoxString('1.', 'Helvetica', 10)).toBeLessThan(l.indent);
  });

  it('puts a bullet on the first line of each wrapped paragraph only', () => {
    const l = layoutTextBox('alpha beta gamma delta epsilon', { fontSize: 10, list: 'bullet' }, 60);
    expect(l.lines[0].marker).toBe('\u2022');
    expect(l.lines.slice(1).every(x => !x.marker && x.x === l.indent)).toBe(true);
  });
});

describe('PDF operators', () => {
  it('writes spacing, colour, highlight and decorations', () => {
    const style = resolveTextBoxStyle({
      fontSize: 10, color: '#ff0000', letterSpacing: 0.5, highlight: '#ffff00',
      underline: true, strikethrough: true, align: 'justify',
    });
    const layout = layoutTextBox('aa bb cc dd ee ff gg', style, 50);
    const ops = buildTextBoxOperators(layout, style, 100, 700, 'BTB-Helvetica');
    expect(ops).toContain('/BTB-Helvetica 10 Tf');
    expect(ops).toContain('0.5 Tc');
    expect(ops).toContain('1 0 0 rg');
    expect(ops).toContain('1 1 0 rg');
    expect(ops).toMatch(/[\d.]+ Tw/);
    // Highlight + underline + strike: three rectangles per non-empty line.
    expect((ops.match(/ re f/g) || []).length).toBe(layout.lines.length * 3);
    const firstTm = ops.match(/1 0 0 1 ([\d.]+) ([\d.]+) Tm/)!;
    expect(parseFloat(firstTm[2])).toBeCloseTo(700 - layout.lines[0].baseline, 3);
  });

  it('adds a WinAnsi Standard 14 font resource and keeps the stream ASCII', () => {
    const p = page();
    const out = insertTextBox(new Uint8Array(), p, new Map(), 'Café • ok', { bold: true }, 10, 100);
    const text = new TextDecoder().decode(out);
    expect(text).toContain('/BTB-Helvetica-Bold 12 Tf');
    expect(text).toContain('\\351'); // é as octal
    expect(out.every(b => b < 0x80)).toBe(true);
    const font = ((p.dict.get('Resources') as PDFDict).get('Font') as PDFDict).get('BTB-Helvetica-Bold') as PDFDict;
    expect((font.get('BaseFont') as PDFName).name).toBe('Helvetica-Bold');
    expect((font.get('Encoding') as PDFName).name).toBe('WinAnsiEncoding');
  });
});

describe('round trip through the PDF interpreter', () => {
  it('reads back the same font, size, positions and spacing', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const { parsePDF, getPageContentBytes, interpretPage } = await import('@/engine');
    const doc = await parsePDF(new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'editor', 'a-simple-1page.pdf'))));
    const pg = doc.pages[0];
    const style = { fontFamily: 'Times New Roman', fontSize: 14, italic: true, letterSpacing: 1, lineHeight: 2 };
    const before = getPageContentBytes(pg, doc.objects);
    const bytes = insertTextBox(before, pg, doc.objects, 'Line one\nLine two', style, 72, 500);
    const runs = interpretPage(bytes, pg, doc.objects).textRuns.filter(r => r.text.startsWith('Line'));
    expect(runs).toHaveLength(2);
    const layout = layoutTextBox('Line one\nLine two', style);
    expect(runs[0].x).toBeCloseTo(72, 2);
    expect(runs[0].y).toBeCloseTo(500 - layout.lines[0].baseline, 2);
    expect(runs[0].y - runs[1].y).toBeCloseTo(28, 2);
    expect(runs[0].width).toBeCloseTo(layout.lines[0].width, 1);
  });
});
