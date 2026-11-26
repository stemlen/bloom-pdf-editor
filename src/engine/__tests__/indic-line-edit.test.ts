/**
 * Editing a word in a Chromium-printed Hindi line: the new word must be drawn
 * with the page's own shaped glyph clusters (never Helvetica "?????"), keep an
 * /ActualText text layer, leave every untouched run byte-for-byte alone, and
 * paint its erase box under the page's CTM.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parsePDF, getPageContentBytes } from '../parser/parser';
import { interpretPage } from '../content/interpreter';
import { parseContentStream } from '../content/operator-lexer';
import { buildDocumentFlow, applyLineTextEdit } from '../flow';
import { PDFNumber, type PDFDocumentData } from '../types';

const FIXTURES = join(__dirname, 'fixtures/fonts');
const load = async (name: string) => parsePDF(new Uint8Array(readFileSync(join(FIXTURES, name))));

function flowOf(doc: PDFDocumentData, bytes: Uint8Array) {
  const page = doc.pages[0];
  return buildDocumentFlow(interpretPage(bytes, page, doc.objects).textRuns);
}

function editLine(doc: PDFDocumentData, lineText: string, newText: string) {
  const page = doc.pages[0];
  const bytes = getPageContentBytes(page, doc.objects);
  const flow = flowOf(doc, bytes);
  const line = flow.lines.find(l => l.text === lineText);
  expect(line, `line "${lineText}"`).toBeTruthy();
  const result = applyLineTextEdit(bytes, page, doc.objects, line!, newText, flow, {
    oldText: line!.text,
    caretAfter: newText.length,
  });
  return { before: bytes, after: result.newContentBytes, result, flow: flowOf(doc, result.newContentBytes) };
}

const latin1 = (b: Uint8Array) => Buffer.from(b).toString('latin1');

describe('editing Hindi lines (Chromium PDFs)', () => {
  it('CIDFontType2 invoice: a new word built from page clusters, text layer intact', async () => {
    const doc = await load('hi-2-table-invoice.pdf');
    // चीनी → चावल: both clusters (चा, व, ल) are printed elsewhere on the page.
    const { after, result, flow } = editLine(doc, 'चीनी', 'चावल');
    const texts = flow.lines.map(l => l.text);
    expect(texts.filter(t => t === 'चावल')).toHaveLength(2);
    expect(texts).not.toContain('चीनी');
    expect(texts).toContain('धन्यवाद! पुनः पधारें।');
    expect(result.needsFontAugmentation).toBe(false);
    expect(latin1(after)).not.toContain('HelvAug');
    expect(latin1(after)).not.toContain('?');
  });

  it('Type3 line: only the edited word changes, untouched clusters keep their bytes', async () => {
    const doc = await load('j-unicode-hindi-emoji.pdf');
    const old = 'Hindi: नमस्ते दुनिया! यह एक परीक्षण दस्तावेज़ है। क्षत्रिय, श्री, द्वार, हिन्दी, प्रोग्राम।';
    // दुनिया → हिन्दी: clusters taken from "हिन्दी" later on the same line.
    const next = old.replace('दुनिया', 'हिन्दी');
    const { before, after, result, flow } = editLine(doc, old, next);
    expect(flow.lines.map(l => l.text)).toContain(next);
    expect(result.needsFontAugmentation).toBe(false);

    // The text after the word moves with it: same spacing before "!" as before.
    const gapBeforeBang = (text: string, f: ReturnType<typeof flowOf>) => {
      const glyphs = f.lines.find(l => l.text === text)!.runs.flatMap(r => r.glyphs);
      const bang = glyphs.find(g => g.unicode === '!')!;
      const right = Math.max(...glyphs.filter(g => g.tRm.e < bang.tRm.e - 0.01).map(g => g.tRm.e + g.width));
      return bang.tRm.e - right;
    };
    const oldGap = gapBeforeBang(old, flowOf(doc, before));
    const newGap = gapBeforeBang(next, flow);
    expect(Math.abs(newGap - oldGap)).toBeLessThan(1.5);
    expect(latin1(after)).not.toContain('HelvAug');

    // Every show operator outside the edited word is unchanged.
    const shows = (b: Uint8Array) => parseContentStream(b)
      .filter(i => i.operator === 'Tj' || i.operator === 'TJ')
      .map(i => i.operands.map(String).join(' '))
      .filter(s => s !== '()' && s !== '[()]');
    const kept = shows(before).filter(s => shows(after).includes(s));
    expect(kept.length).toBeGreaterThan(shows(before).length - 12);
  });

  it('falls back (without corrupting other runs) when a cluster never occurs on the page', async () => {
    const doc = await load('hi-2-table-invoice.pdf');
    const { flow } = editLine(doc, 'चीनी', 'ज्ञान');
    expect(flow.lines.map(l => l.text)).toContain('शुद्ध घी');
    expect(flow.lines.map(l => l.text)).toContain('धन्यवाद! पुनः पधारें।');
  });

  it('paints the erase box under the page CTM, over the edited word', async () => {
    const doc = await load('hi-2-table-invoice.pdf');
    const { after, flow: before } = (() => {
      const r = editLine(doc, 'चीनी', 'चावल');
      return { after: r.after, flow: flowOf(doc, r.before) };
    })();
    const word = before.lines.find(l => l.text === 'चीनी')!;
    const ins = parseContentStream(after);
    // CTM at each `re` (Chromium: .24 0 0 -.24 0 842.88 cm, then 3.125 0 0 3.125 0 0 cm)
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack: number[][] = [];
    const rects: number[][] = [];
    let fillWhite = false;
    for (const i of ins) {
      const n = i.operands.map(o => (o instanceof PDFNumber ? o.value : 0));
      if (i.operator === 'q') stack.push(ctm);
      else if (i.operator === 'Q') ctm = stack.pop() ?? ctm;
      else if (i.operator === 'cm') {
        const [a, b, c, d, e, f] = n;
        const [A, B, C, D, E, F] = ctm;
        ctm = [a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D, e * A + f * C + E, e * B + f * D + F];
      } else if (i.operator === 'rg') fillWhite = n.every(v => v === 1);
      else if (i.operator === 're' && fillWhite) {
        const [x, y, w, h] = n;
        const px = (u: number, v: number) => [u * ctm[0] + v * ctm[2] + ctm[4], u * ctm[1] + v * ctm[3] + ctm[5]];
        const p1 = px(x, y);
        const p2 = px(x + w, y + h);
        rects.push([Math.min(p1[0], p2[0]), Math.min(p1[1], p2[1]), Math.max(p1[0], p2[0]), Math.max(p1[1], p2[1])]);
      }
    }
    expect(rects.length).toBeGreaterThan(0);
    const covers = rects.some(([x0, y0, x1, y1]) =>
      x0 <= word.x + 1 && x1 >= word.x + word.width - 1 && y0 <= word.baseline && y1 >= word.baseline);
    expect(covers).toBe(true);
  });
});
