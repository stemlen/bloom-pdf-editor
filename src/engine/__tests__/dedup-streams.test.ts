/**
 * Stream deduplication (Optimize, optimized save) must only merge streams that
 * are interchangeable. It used to compare the stream bytes alone, so two form
 * XObjects or field appearances with the same content but a different /BBox or
 * /Resources were merged and one of them drew with the other's size/resources.
 */
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream } from '@/engine/types';
import { deduplicateStreams } from '@/engine/optimize/garbage-collect';
import { parsePDF, saveOptimized } from '@/engine';

const bytes = (s: string) => new TextEncoder().encode(s);
const box = (w: number, h: number) => new PDFArray([0, 0, w, h].map((n) => new PDFNumber(n)));

function form(w: number, h: number, content = '/Tx BMC EMC', extra?: (d: PDFDict) => void): PDFStream {
  const d = new PDFDict();
  d.set('Type', new PDFName('XObject'));
  d.set('Subtype', new PDFName('Form'));
  d.set('BBox', box(w, h));
  extra?.(d);
  const b = bytes(content);
  d.set('Length', new PDFNumber(b.length));
  return new PDFStream(d, b, b);
}

describe('deduplicateStreams', () => {
  it('merges streams with the same bytes and dictionary', () => {
    const objects = new Map([['1_0', form(100, 20)], ['2_0', form(100, 20)]]);
    expect(deduplicateStreams(objects).refMap.get('2_0')).toBe('1_0');
  });

  it('keeps streams whose dictionaries differ', () => {
    const objects = new Map([
      ['1_0', form(100, 20)],
      ['2_0', form(300, 22)],
      ['3_0', form(100, 20, '/Tx BMC EMC', (d) => d.set('Resources', new PDFRef(9, 0)))],
    ]);
    expect(deduplicateStreams(objects).refMap.size).toBe(0);
  });

  it('ignores Length / Filter differences (the keeper is written with its own)', () => {
    const a = form(100, 20);
    const b = form(100, 20);
    b.dict.set('Filter', new PDFName('FlateDecode'));
    b.dict.set('Length', new PDFNumber(99));
    expect(deduplicateStreams(new Map([['1_0', a], ['2_0', b]])).refMap.get('2_0')).toBe('1_0');
  });
});

it('Optimize reports duplicates without claiming to have merged them', async () => {
  // optimizeWithReport only counts duplicate groups; the optimized save merges them.
  const { secureOptimizer } = await import('@/engine/security/optimizer/secure-optimizer');
  const doc = await parsePDF(bytes(minimalPdf(['q /A Do Q', [10, 10], [10, 10]])));
  const report = await secureOptimizer.optimizeWithReport(doc);
  expect(report.notes.join(' ')).toContain('Found 1 duplicate stream group (merged by an optimized save)');
  expect(report.notes.join(' ')).not.toMatch(/Deduplicated/);
});

/** A one-page PDF whose content draws form XObjects /A and /B with the given box sizes. */
function minimalPdf([content, a, b]: [string, [number, number], [number, number]]): string {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /XObject << /A 5 0 R /B 6 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< /Type /XObject /Subtype /Form /BBox [0 0 ${a[0]} ${a[1]}] /Length 15 >>\nstream\n0 0 400 400 re f\nendstream`,
    `<< /Type /XObject /Subtype /Form /BBox [0 0 ${b[0]} ${b[1]}] /Length 15 >>\nstream\n0 0 400 400 re f\nendstream`,
  ];
  let pdf = '%PDF-1.7\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  return pdf + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

it('optimized save keeps differently sized appearances apart', async () => {
  // A page drawing two forms with identical content and different boxes.
  const pdf = minimalPdf(['q /A Do Q q 1 0 0 1 0 100 cm /B Do Q', [50, 10], [300, 80]]);
  const saved = await parsePDF(await saveOptimized(await parsePDF(bytes(pdf))));
  const xobjects = saved.pages[0].resources.get('XObject') as PDFDict;
  const bboxOf = (name: string) => {
    const s = saved.objects.get((xobjects.get(name) as PDFRef).toKey()) as PDFStream;
    return (s.dict.get('BBox') as PDFArray).items.map((n) => (n as PDFNumber).value);
  };
  expect(bboxOf('A')).toEqual([0, 0, 50, 10]);
  expect(bboxOf('B')).toEqual([0, 0, 300, 80]);
});
