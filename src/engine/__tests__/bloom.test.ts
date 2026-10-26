/**
 * Bloom Engine tests — ingest, edit/layout, compile (no doubled text).
 */

import { describe, it, expect } from 'vitest';
import type { TextRun } from '../content/interpreter';
import { buildDocumentFlow } from '../flow/index';
import { ingestPage } from '../bloom/ingest';
import { blockPlainText } from '../bloom/types';
import { replaceBlockText, insertTextAtCaret } from '../bloom/edit';
import { layoutPage } from '../bloom/layout';
import { stripOwnedTextOps, collectOwnedIndices, compilePage } from '../bloom/compile';
import { parseContentStream } from '../content/operator-lexer';
import { PDFDict, PDFNumber, PDFRef, PDFArray, type PDFPageInfo } from '../types';

function makeRun(
  text: string,
  opts: { x?: number; y?: number; fontSize?: number; fontName?: string; indices?: number[] } = {},
): TextRun {
  const fontSize = opts.fontSize ?? 12;
  const x = opts.x ?? 50;
  const y = opts.y ?? 700;
  return {
    type: 'text',
    text,
    glyphs: text.split('').map((ch, i) => ({
      charCode: ch.charCodeAt(0),
      unicode: ch,
      x: x + i * fontSize * 0.5,
      y,
      width: fontSize * 0.5,
      fontSize,
      textSpaceWidth: 0.5,
      tRm: { a: fontSize, b: 0, c: 0, d: fontSize, e: x + i * fontSize * 0.5, f: y },
    })),
    sourceInstructionIndices: opts.indices ?? [0],
    x,
    y,
    width: text.length * fontSize * 0.5,
    height: fontSize,
    fontName: opts.fontName ?? 'F1',
    fontSize,
    textMatrix: { a: 1, b: 0, c: 0, d: 1, e: x, f: y },
    fillColor: [0, 0, 0],
    fillAlpha: 1,
    blendMode: 'Normal',
    softMask: null,
    clipPaths: [],
  };
}

describe('bloom ingest', () => {
  it('builds one block per line with correct plain text (preserves geometry)', () => {
    const runs = [
      makeRun('SHASHANK ', { x: 50, y: 750, fontSize: 18, indices: [1] }),
      makeRun('KUMAR', { x: 140, y: 750, fontSize: 18, indices: [2] }),
      makeRun('Built REST APIs', { x: 50, y: 700, fontSize: 11, indices: [5] }),
    ];
    const page = ingestPage(runs, {
      pageIndex: 0,
      width: 612,
      height: 792,
      flow: buildDocumentFlow(runs),
    });

    expect(page.blocks.length).toBeGreaterThanOrEqual(2);
    // Each block keeps a lineBox from PDF — no full-page reflow
    for (const b of page.blocks) {
      expect(b.lineBoxes.length).toBe(1);
      expect(b.lineBoxes[0].baseline).toBeGreaterThan(0);
    }
    const allText = page.blocks.map(b => blockPlainText(b)).join(' | ');
    expect(allText).toContain('SHASHANK');
    expect(allText).toContain('KUMAR');
    expect(allText).toContain('Built REST APIs');
    const owned = collectOwnedIndices(page);
    expect(owned.has(1)).toBe(true);
    expect(owned.has(2)).toBe(true);
    expect(owned.has(5)).toBe(true);
  });
});

describe('bloom edit + layout', () => {
  it('replaces block text and reflows without duplicating content', () => {
    const runs = [
      makeRun('Hello world from Bloom', { x: 50, y: 700, fontSize: 12, indices: [0] }),
    ];
    let page = ingestPage(runs, { pageIndex: 0, width: 612, height: 792 });
    const blockId = page.blocks[0].id;
    const original = blockPlainText(page.blocks[0]);

    page = replaceBlockText(page, blockId, 'Hello brave new world from Bloom engine');
    const next = blockPlainText(page.blocks[0]);

    expect(next).toBe('Hello brave new world from Bloom engine');
    expect(next).not.toContain(original + original);
    expect(next.indexOf('Hello')).toBe(0);
    expect(next.split('Hello').length - 1).toBe(1);
    expect(page.dirty).toBe(true);
    expect(page.blocks[0].lineBoxes.length).toBeGreaterThanOrEqual(1);
  });

  it('insert at caret grows text once', () => {
    const runs = [makeRun('ABC', { x: 50, y: 700, indices: [0] })];
    const page = ingestPage(runs, { pageIndex: 0, width: 612, height: 792 });
    const blockId = page.blocks[0].id;
    const result = insertTextAtCaret(page, { blockId, offset: 1 }, 'X');
    expect(blockPlainText(result.page.blocks[0])).toBe('AXBC');
    expect(result.caret.offset).toBe(2);
  });
});

describe('bloom compile', () => {
  it('strips owned text ops so glyphs are not doubled', () => {
    const content = 'BT /F1 12 Tf 50 700 Td (Hello) Tj 50 680 Td (World) Tj ET\n';
    const bytes = new TextEncoder().encode(content);
    const instructions = parseContentStream(bytes);

    const tjIndices = instructions
      .map((inst, i) => (inst.operator === 'Tj' ? i : -1))
      .filter(i => i >= 0);

    expect(tjIndices.length).toBe(2);

    const owned = new Set([tjIndices[0], tjIndices[1]]);
    const stripped = stripOwnedTextOps(instructions, owned);
    const remainingTj = stripped.filter(i => i.operator === 'Tj');
    expect(remainingTj.length).toBe(0);
  });

  it('compilePage appends bloom text after stripping', () => {
    const content = 'BT /F1 12 Tf 50 700 Td (OldText) Tj ET\nq 1 0 0 1 0 0 cm Q\n';
    const bytes = new TextEncoder().encode(content);
    const instructions = parseContentStream(bytes);
    const tjIdx = instructions.findIndex(i => i.operator === 'Tj');

    const runs = [makeRun('NewText', { x: 50, y: 700, indices: [tjIdx] })];
    let bloom = ingestPage(runs, { pageIndex: 0, width: 612, height: 792 });
    bloom = replaceBlockText(bloom, bloom.blocks[0].id, 'NewText');
    bloom.blocks[0].sourceInstructionIndices = [tjIdx];

    const pageDict = new PDFDict();
    const resources = new PDFDict();
    const fontDict = new PDFDict();
    resources.set('Font', fontDict);
    pageDict.set('Resources', resources);
    pageDict.set('MediaBox', new PDFArray([
      new PDFNumber(0), new PDFNumber(0), new PDFNumber(612), new PDFNumber(792),
    ]));

    const pageInfo: PDFPageInfo = {
      index: 0,
      dict: pageDict,
      mediaBox: { x: 0, y: 0, width: 612, height: 792 },
      cropBox: { x: 0, y: 0, width: 612, height: 792 },
      rotate: 0,
      ref: new PDFRef(1, 0),
      resources,
      contentRefs: [new PDFRef(2, 0)],
    };

    const objects = new Map();
    objects.set('1 0', pageDict);

    const result = compilePage(bytes, bloom, pageInfo, objects);
    const out = new TextDecoder().decode(result.newContentBytes);

    expect(out.includes('OldText')).toBe(false);
    expect(out.includes('NewText')).toBe(true);
    expect(out.includes('cm') || out.includes('Q')).toBe(true);
    expect(out.split('NewText').length - 1).toBe(1);
  });
});

describe('bloom layout page', () => {
  it('layoutPage is idempotent on plain text', () => {
    const runs = [makeRun('Short line', { x: 72, y: 720, indices: [0] })];
    const page = ingestPage(runs, { pageIndex: 0, width: 612, height: 792 });
    const again = layoutPage(page);
    expect(blockPlainText(again.blocks[0])).toBe(blockPlainText(page.blocks[0]));
  });
});
