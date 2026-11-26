import { describe, it, expect } from 'vitest';
import { pdfBoxToCanvasRect } from '@/app/editor/utils';

// A 100x20 box near the top-left corner of an unrotated US Letter page.
const box = { x: 72, y: 700, width: 100, height: 20 };
const page = (rotate: number) => ({ mediaBox: { x: 0, y: 0, width: 612, height: 792 }, rotate });

describe('search highlights on /Rotate pages', () => {
  it('maps a box onto the page as the renderer turns it (clockwise)', () => {
    expect(pdfBoxToCanvasRect(box, page(0), 1)).toEqual({ left: 72, top: 72, width: 100, height: 20 });
    // 90: top-left corner moves to the top-right, the box stands upright.
    expect(pdfBoxToCanvasRect(box, page(90), 1)).toEqual({ left: 700, top: 72, width: 20, height: 100 });
    expect(pdfBoxToCanvasRect(box, page(180), 1)).toEqual({ left: 440, top: 700, width: 100, height: 20 });
    expect(pdfBoxToCanvasRect(box, page(-90), 1)).toEqual({ left: 72, top: 440, width: 20, height: 100 });
  });

  it('scales with zoom', () => {
    expect(pdfBoxToCanvasRect(box, page(90), 2)).toEqual({ left: 1400, top: 144, width: 40, height: 200 });
  });
});
