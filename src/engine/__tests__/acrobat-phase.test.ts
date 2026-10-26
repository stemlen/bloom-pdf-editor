import { describe, it, expect } from 'vitest';
import { knuthPlassWrap, greedyWrap } from '../flow/line-break';
import { resolveBidiLevels, reorderForDisplay } from '../flow/bidi';
import { moveCaret, graphemeClusters } from '../flow/caret';
import { resolveStyledFontName, mapSelectionToSegments } from '../flow/style-edit';
import type { StyledSegment } from '../flow/types';
import { invertAffine, composeTransform, multiplyAffine } from '../editing/transform-editor';
import { lineSelectionToQuadPoints } from '../flow/selection-quads';
import { comparePageText } from '../ai/compare';
import { distributeGlue, opticalMarginAdjust } from '../flow/justification';
import { unionRects } from '../editor/redaction';
import type { TextLine } from '../flow/types';

describe('knuthPlassWrap', () => {
  const measure = (s: string) => s.length * 5;

  it('wraps long text into multiple lines', () => {
    const text = 'The quick brown fox jumps over the lazy dog and then runs away quickly';
    const lines = knuthPlassWrap(text, 80, measure);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(measure(line)).toBeLessThanOrEqual(100);
    }
  });

  it('falls back to greedy for short text', () => {
    const text = 'Hello world';
    expect(knuthPlassWrap(text, 200, measure)).toEqual(greedyWrap(text, 200, measure));
  });
});

describe('bidi', () => {
  it('assigns higher level to Hebrew characters', () => {
    const text = 'Hello שלום';
    const levels = resolveBidiLevels(text);
    expect(levels.length).toBe(text.length);
    expect(Math.max(...levels)).toBeGreaterThanOrEqual(1);
  });

  it('reorders RTL runs', () => {
    const text = 'abc';
    expect(reorderForDisplay(text)).toBe('abc');
  });
});

describe('caret', () => {
  it('moves by grapheme', () => {
    const text = 'hi';
    expect(moveCaret(text, 0, 1)).toBe(1);
    expect(moveCaret(text, 1, -1)).toBe(0);
    expect(graphemeClusters('ab').length).toBe(2);
  });
});

describe('style-edit helpers', () => {
  it('resolves bold Helvetica', () => {
    expect(resolveStyledFontName('Helvetica', true, false)).toBe('Helvetica-Bold');
    expect(resolveStyledFontName('Times-Roman', false, true)).toBe('Times-Italic');
  });

  it('maps selection to segments', () => {
    const line = {
      text: 'HelloWorld',
      segments: [
        { startIndex: 0, endIndex: 5, text: 'Hello', run: {} as StyledSegment['run'] },
        { startIndex: 5, endIndex: 10, text: 'World', run: {} as StyledSegment['run'] },
      ],
    } as TextLine;
    const hits = mapSelectionToSegments(line, 3, 7);
    expect(hits.length).toBe(2);
    expect(hits[0].localStart).toBe(3);
    expect(hits[1].localEnd).toBe(2);
  });
});

describe('affine transforms', () => {
  it('inverts identity', () => {
    const inv = invertAffine([1, 0, 0, 1, 0, 0])!;
    expect(inv[0]).toBeCloseTo(1);
    expect(inv[1]).toBeCloseTo(0);
    expect(inv[2]).toBeCloseTo(0);
    expect(inv[3]).toBeCloseTo(1);
    expect(inv[4]).toBeCloseTo(0);
    expect(inv[5]).toBeCloseTo(0);
  });

  it('composes translate', () => {
    const m = composeTransform([1, 0, 0, 1, 0, 0], { translate: { dx: 10, dy: 20 } });
    expect(m[4]).toBe(10);
    expect(m[5]).toBe(20);
  });

  it('multiply then invert recovers', () => {
    const a = [2, 0, 0, 3, 5, 7];
    const inv = invertAffine(a)!;
    const id = multiplyAffine(a, inv);
    expect(id[0]).toBeCloseTo(1);
    expect(id[3]).toBeCloseTo(1);
    expect(id[4]).toBeCloseTo(0);
    expect(id[5]).toBeCloseTo(0);
  });
});

describe('quad points', () => {
  it('builds 8 numbers for a selection', () => {
    const line = {
      text: 'Hello',
      baseline: 100,
      height: 12,
      fontSize: 12,
      x: 50,
      rightEdge: 100,
      runs: [{
        text: 'Hello',
        x: 50,
        y: 100,
        width: 50,
        fontSize: 12,
        glyphs: [
          { tRm: { e: 50 }, width: 10 },
          { tRm: { e: 60 }, width: 10 },
          { tRm: { e: 70 }, width: 10 },
          { tRm: { e: 80 }, width: 10 },
          { tRm: { e: 90 }, width: 10 },
        ],
      }],
      segments: [],
    } as unknown as TextLine;
    const qp = lineSelectionToQuadPoints(line, 0, 5);
    expect(qp.length).toBe(8);
  });
});

describe('compare + glue + redaction union', () => {
  it('diffs page text', () => {
    const d = comparePageText('a\nb\nc', 'a\nx\nc');
    expect(d.removed).toContain('b');
    expect(d.added).toContain('x');
  });

  it('distributes glue', () => {
    const g = distributeGlue(100, [20, 20, 20]);
    expect(g.gaps.length).toBe(2);
  });

  it('optical margin returns dx array', () => {
    const dx = opticalMarginAdjust('Hello.', [0, 10, 20, 30, 40, 50], 12);
    expect(dx.length).toBeGreaterThan(0);
  });

  it('unions rects', () => {
    const u = unionRects([
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 5, y: 5, width: 10, height: 10 },
    ]);
    expect(u).toHaveLength(1);
    expect(u[0].width).toBe(15);
    expect(u[0].height).toBe(15);
  });
});
