/**
 * Appearance streams for text and choice widgets, so the saved value shows in
 * every viewer (and on Bloom's canvas) without relying on NeedAppearances.
 * ISO 32000-2 §12.7.4.3.
 */

import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, type PDFDocumentData } from '../types';
import { getNextObjNum } from '../writer/serializer';
import type { AcroFormWidget } from './types';

/** WinAnsiEncoding bytes 0x80–0x9F (the rest of Latin-1 maps 1:1). */
const WIN_ANSI_HIGH: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** Encode one line as a PDF literal string in WinAnsiEncoding; unmappable characters become "?". */
function winAnsiLiteral(line: string): number[] {
  const out: number[] = [0x28];
  for (const ch of line) {
    const cp = ch.codePointAt(0)!;
    let b = WIN_ANSI_HIGH[cp] ?? (cp < 0x100 && (cp < 0x80 || cp > 0x9f) ? cp : 0x3f);
    if (b < 0x20) b = 0x20;
    if (b === 0x28 || b === 0x29 || b === 0x5c) out.push(0x5c);
    out.push(b);
  }
  out.push(0x29);
  return out;
}

function parseDa(da: string): { size: number; color: string } {
  const size = Number(/([\d.]+)\s+Tf/.exec(da)?.[1] ?? 0);
  const rgb = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(da);
  const gray = /([\d.]+)\s+g(?:\s|$)/.exec(da);
  const color = rgb ? `${rgb[1]} ${rgb[2]} ${rgb[3]} rg` : gray ? `${gray[1]} g` : '0 g';
  return { size, color };
}

/** Build and attach a /AP /N stream that draws `value` inside the widget. */
export function regenerateTextAppearance(doc: PDFDocumentData, widget: AcroFormWidget, value: string): void {
  const w = Math.max(1, widget.rect?.width ?? 100);
  const h = Math.max(1, widget.rect?.height ?? 20);
  const { size: daSize, color } = parseDa(widget.defaultAppearance);
  const lines = widget.multiline ? value.split(/\r\n|\r|\n/) : [value.replace(/\s*[\r\n]+\s*/g, ' ')];
  const auto = widget.multiline ? 10 : Math.min(12, (h - 4) * 0.75);
  const size = daSize > 0 ? daSize : Math.max(4, auto);
  const leading = size * 1.15;
  const pad = 2;

  const enc = new TextEncoder();
  const parts: number[] = [];
  const push = (s: string) => parts.push(...enc.encode(s));
  push(`/Tx BMC\nq\n${pad} ${pad} ${w - pad * 2} ${h - pad * 2} re W n\nBT\n/Helv ${size} Tf\n${color}\n`);
  const firstY = widget.multiline ? h - pad - size : (h - size * 0.72) / 2;
  lines.forEach((line, i) => {
    push(i === 0 ? `${pad + 1} ${firstY.toFixed(2)} Td\n` : `0 ${(-leading).toFixed(2)} Td\n`);
    parts.push(...winAnsiLiteral(line));
    push(' Tj\n');
  });
  push('ET\nQ\nEMC\n');
  const bytes = new Uint8Array(parts);

  const font = new PDFDict();
  font.set('Type', new PDFName('Font'));
  font.set('Subtype', new PDFName('Type1'));
  font.set('BaseFont', new PDFName('Helvetica'));
  font.set('Encoding', new PDFName('WinAnsiEncoding'));
  const fonts = new PDFDict();
  fonts.set('Helv', font);
  const resources = new PDFDict();
  resources.set('Font', fonts);

  const dict = new PDFDict();
  dict.set('Type', new PDFName('XObject'));
  dict.set('Subtype', new PDFName('Form'));
  dict.set('BBox', new PDFArray([new PDFNumber(0), new PDFNumber(0), new PDFNumber(w), new PDFNumber(h)]));
  dict.set('Resources', resources);
  dict.set('Length', new PDFNumber(bytes.length));
  // Reuse the widget's own /N object when it has one, so typing doesn't pile up streams.
  const oldAp = widget.dict.get('AP');
  const oldN = oldAp instanceof PDFDict ? oldAp.get('N') : undefined;
  const ref = oldN instanceof PDFRef && doc.objects.get(oldN.toKey()) instanceof PDFStream
    ? oldN
    : new PDFRef(getNextObjNum(doc), 0);
  doc.objects.set(ref.toKey(), new PDFStream(dict, bytes, bytes));

  const ap = new PDFDict();
  ap.set('N', ref);
  widget.dict.set('AP', ap);
}
