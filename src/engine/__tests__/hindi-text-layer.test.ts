/**
 * Hindi / Devanagari text layer: /ActualText extraction, Indic normalization,
 * line detection, line-edit distribution across cluster runs, caret mapping.
 *
 * Fixtures (fixtures/fonts/): Chromium-printed PDFs — j-unicode-hindi-emoji
 * (Type3 glyphs + /ActualText) and hi-2-table-invoice (Devanagari Sangam MN as
 * Identity-H CIDFontType2 + /ActualText).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parsePDF, getPageContentBytes } from '../parser/parser';
import { interpretPage, type TextRun, type GlyphPosition } from '../content/interpreter';
import { buildDocumentFlow } from '../flow';
import { detectColumnSplitIndices } from '../flow/justification-detect';
import { distributeTextChangeToSegments } from '../flow/reflow';
import { caretIndexFromLineX, lineXFromCaretIndex } from '../flow/hit-test';
import type { TextLine } from '../flow/types';
import { reorderPreBaseVowels, reorderIndicGlyphs } from '../fonts/indic-normalizer';
import { identityMatrix } from '../render/graphics-state';
import type { PDFDocumentData } from '../types';

const FIXTURES = join(__dirname, 'fixtures/fonts');
const load = async (name: string) => parsePDF(new Uint8Array(readFileSync(join(FIXTURES, name))));

function pageLines(doc: PDFDocumentData, pageIndex = 0) {
  const page = doc.pages[pageIndex];
  const res = interpretPage(getPageContentBytes(page, doc.objects), page, doc.objects);
  return { runs: res.textRuns, lines: buildDocumentFlow(res.textRuns).lines };
}

/** Minimal one-page PDF with Helvetica as /F1 and the given content stream. */
function buildPdf(content: string, extraResources = ''): Uint8Array {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> ${extraResources} >> >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let out = '%PDF-1.7\n';
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

describe('/ActualText marked content', () => {
  it('replaces the glyphs of a span with its text (inline property dict)', async () => {
    // "कि" printed as two shaped glyphs whose codes map to nothing useful.
    const doc = await parsePDF(buildPdf(
      'BT /F1 12 Tf 10 100 Td (A) Tj /Span <</ActualText <FEFF0915093F>>> BDC (BC) Tj EMC (D) Tj ET',
    ));
    const { runs } = pageLines(doc);
    const glyphs = runs.flatMap(r => r.glyphs);
    expect(glyphs.map(g => g.unicode)).toEqual(['A', 'कि', '', 'D']);
    expect(runs.map(r => r.text).join('')).toBe('AकिD');
  });

  it('resolves a named /Properties entry and spans several show operators', async () => {
    const doc = await parsePDF(buildPdf(
      'BT /F1 12 Tf 10 100 Td /Span /MC0 BDC (X) Tj [(Y) -50 (Z)] TJ EMC ET',
      '/Properties << /MC0 << /ActualText (r\\351sum\\351) >> >>',
    ));
    const { lines } = pageLines(doc);
    expect(lines.map(l => l.text).join('|')).toBe('résumé');
  });

  it('extracts Chromium Hindi text (Type3 glyphs) in logical order', async () => {
    const { lines } = pageLines(await load('j-unicode-hindi-emoji.pdf'));
    const text = lines.map(l => l.text);
    expect(text).toContain('Unicode test — यूनिकोड परीक्षण 🌸');
    expect(text).toContain('Hindi: नमस्ते दुनिया! यह एक परीक्षण दस्तावेज़ है। क्षत्रिय, श्री, द्वार, हिन्दी, प्रोग्राम।');
  });

  it('extracts Chromium Hindi text (CIDFontType2 glyphs) with conjuncts, reph and ि', async () => {
    const { lines } = pageLines(await load('hi-2-table-invoice.pdf'));
    const text = lines.map(l => l.text);
    for (const expected of [
      'बीजक संख्या ४५६',
      'ग्राहक: श्री राजेश कुमार, नई दिल्ली',
      'क्रम', 'विवरण', 'मात्रा', 'मूल्य (₹)',
      'गेहूँ का आटा', 'शुद्ध घी', 'चीनी', 'कुल योग',
      'धन्यवाद! पुनः पधारें।',
    ]) {
      expect(text).toContain(expected);
    }
    expect(text.join('')).not.toMatch(/[\u0000◌']/);
  });
});

describe('Indic normalizer', () => {
  it('keeps ि after a nukta consonant (बढ़िया) in logical order', () => {
    expect(reorderPreBaseVowels('बढ़िया')).toBe('बढ़िया');
    expect(reorderPreBaseVowels('पढ़िए')).toBe('पढ़िए');
  });

  it('never moves /ActualText glyphs', () => {
    const tRm = { a: 12, b: 0, c: 0, d: 12, e: 0, f: 0 };
    const g = (unicode: string, e: number, actualText = true) =>
      ({ charCode: 1, unicode, x: e, y: 0, width: 4, fontSize: 12, tRm: { ...tRm, e }, actualText });
    const out = reorderIndicGlyphs([g('ि', 0, false), g('कि', 4), g('', 8)]);
    expect(out.map(x => x.unicode)).toEqual(['ि', 'कि', '']);
  });
});

function textRun(glyphs: Array<[string, number, number]>, fontName = 'F1'): TextRun {
  const gs: GlyphPosition[] = glyphs.map(([unicode, x, width]) => ({
    charCode: 1, unicode, x, y: 700, width, fontSize: 15, textSpaceWidth: width / 15,
    tRm: { a: 15, b: 0, c: 0, d: 15, e: x, f: 700 },
  }));
  return {
    type: 'text', text: gs.map(g => g.unicode).join(''), glyphs: gs,
    x: gs[0].x, y: 700, width: gs[gs.length - 1].x + gs[gs.length - 1].width - gs[0].x, height: 15,
    fontName, fontSize: 15, textMatrix: identityMatrix(), fillColor: [0, 0, 0], fillAlpha: 1,
    blendMode: 'Normal', softMask: null, clipPaths: [],
  };
}

describe('line detection', () => {
  it('a zero-width mark run inside a word is not a column gutter', () => {
    // "…भाषाएँ" ends at 212; a zero-width matra run from another font sits at
    // 134 (inside the previous run); the line continues at 211.
    const runs = [
      textRun([['भारत', 27, 100], ['है', 127, 7]]),
      textRun([['। यहाँ', 134, 78]]),
      textRun([['', 134, 0]], 'F2'),
      textRun([['', 211, 0]], 'F2'),
      textRun([[',', 212.5, 3], [' धर्म', 215.5, 40]]),
    ];
    expect(detectColumnSplitIndices(runs, 15)).toEqual([]);
  });

  it('the Hindi lines of the invoice are one line per table cell', async () => {
    const { lines } = pageLines(await load('hi-2-table-invoice.pdf'));
    const header = lines.filter(l => Math.abs(l.baseline - lines.find(x => x.text === 'क्रम')!.baseline) < 2);
    expect(header.map(l => l.text)).toEqual(['क्रम', 'विवरण', 'मात्रा', 'मूल्य (₹)']);
  });
});

function lineOf(segments: string[]): TextLine {
  let x = 10;
  let start = 0;
  const runs = segments.map((t, i) => {
    const r = textRun([[t, x, 10]], `F${i}`);
    x += 10;
    return r;
  });
  return {
    id: 'l', runs, text: segments.join(''),
    segments: runs.map((run, i) => {
      const seg = { run, startIndex: start, endIndex: start + segments[i].length, text: segments[i] };
      start += segments[i].length;
      return seg;
    }),
    baseline: 700, x: 10, y: 690, width: x - 10, height: 15, leftMargin: 10, rightEdge: x,
    fontSize: 15, isJustified: false, tabSplitIndex: -1,
  };
}

describe('line edit distribution', () => {
  it('a word drawn as several cluster runs is rewritten without touching the rest', () => {
    // As Chromium prints "क्षत्रिय, त्रिशूल, श्रद्धा": one run per cluster/font switch.
    const segs = ['क्ष', 'त्रि', 'य, ', 'त्रि', 'शू', 'ल', ', ', 'श्र', 'द्धा'];
    const line = lineOf(segs);
    const newText = line.text.replace('त्रिशूल', 'राष्ट्रीय');
    const edits = distributeTextChangeToSegments(line, line.text, newText, newText.length);
    expect(edits.map(e => e.newText).join('')).toBe(newText);
    const changed = edits.map((e, i) => e.newText !== segs[i]);
    expect(changed).toEqual([false, false, false, true, true, true, false, false, false]);
  });

  it('never splits an Indic cluster when only a matra changes', () => {
    const line = lineOf(['क', 'कि', 'ता']);
    const edits = distributeTextChangeToSegments(line, 'ककिता', 'ककाता', 3);
    expect(edits.map(e => e.newText)).toEqual(['क', 'का', 'ता']);
  });
});

describe('caret mapping over Indic clusters', () => {
  it('counts characters per glyph, including empty /ActualText continuation glyphs', () => {
    // "कि" = 2 chars on the first glyph + 1 empty glyph; then "त" (1 char).
    const run = textRun([['कि', 10, 6], ['', 16, 4], ['त', 20, 8]]);
    const line = lineOf(['x']);
    line.runs = [run];
    line.text = 'कित';
    line.segments = [{ run, startIndex: 0, endIndex: 3, text: 'कित' }];
    line.rightEdge = 28;
    expect(caretIndexFromLineX(21, line)).toBe(2);
    expect(lineXFromCaretIndex(line, 2)).toBe(20);
    expect(lineXFromCaretIndex(line, 1)).toBe(16);
  });
});
