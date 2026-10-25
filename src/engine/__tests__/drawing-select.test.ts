import { describe, it, expect } from 'vitest';
import { hitTestDrawnPath, drawnPathBounds } from '@/app/editor/drawingHitTest';
import type { DrawnPath } from '@/app/editor/types';
import {
  PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, type PDFObject,
} from '@/engine/types';
import { hitTestMarkupAnnotation } from '@/engine/editor/annotation-engine';

const stroke: DrawnPath = {
  id: 'a', type: 'draw', color: '#000', size: 4,
  points: [{ x: 10, y: 10 }, { x: 100, y: 10 }],
};
const rect: DrawnPath = {
  id: 'b', type: 'draw', kind: 'rectangle', color: '#000', size: 2, points: [],
  start: { x: 200, y: 200 }, end: { x: 300, y: 260 },
};

describe('Select tool picks drawings (BE-307)', () => {
  it('hits a freehand stroke near its line and misses elsewhere', () => {
    expect(hitTestDrawnPath([stroke], 50, 12)?.id).toBe('a');
    expect(hitTestDrawnPath([stroke], 50, 40)).toBeNull();
  });

  it('hits a rectangle on its border, not in its empty middle', () => {
    expect(hitTestDrawnPath([rect], 200, 230)?.id).toBe('b');
    expect(hitTestDrawnPath([rect], 250, 230)).toBeNull();
  });

  it('reports bounds that include the stroke width', () => {
    expect(drawnPathBounds(stroke)).toEqual({ x: 8, y: 8, width: 94, height: 4 });
  });

  it('finds a saved Ink annotation under the pointer', () => {
    const objects = new Map<string, PDFObject>();
    const ink = new PDFDict();
    ink.set('Subtype', new PDFName('Ink'));
    ink.set('Rect', new PDFArray([10, 10, 110, 20].map((n) => new PDFNumber(n))));
    ink.set('InkList', new PDFArray([new PDFArray([10, 15, 110, 15].map((n) => new PDFNumber(n)))]));
    objects.set('5_0', ink);
    const page = new PDFDict();
    page.set('Annots', new PDFArray([new PDFRef(5, 0)]));
    expect(hitTestMarkupAnnotation(page, objects, 60, 16, 3)?.ref.toKey()).toBe('5_0');
    expect(hitTestMarkupAnnotation(page, objects, 60, 60, 3)).toBeNull();
  });
});
