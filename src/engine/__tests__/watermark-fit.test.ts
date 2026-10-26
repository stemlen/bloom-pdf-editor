import { describe, it, expect } from 'vitest';
import { watermarkFitScale, watermarkNaturalSize } from '@/lib/watermarkFit';

describe('watermark fit (BE-314)', () => {
  it('leaves a watermark that already fits unchanged', () => {
    expect(watermarkFitScale(200, 50, 45, 612, 792)).toBe(1);
  });

  it('shrinks an oversized rotated watermark to fit inside the page', () => {
    const { width, height } = watermarkNaturalSize('text', 'CONFIDENTIAL DRAFT', 400, null, 'rectangle');
    const fit = watermarkFitScale(width, height, 45, 612, 792);
    expect(fit).toBeLessThan(1);
    const rad = Math.PI / 4;
    const boxW = (width * Math.cos(rad) + height * Math.sin(rad)) * fit;
    expect(boxW).toBeLessThanOrEqual(612 - 60 + 1e-6);
  });
});
