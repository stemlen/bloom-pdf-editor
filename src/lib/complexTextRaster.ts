/**
 * Browser rasterizer for text the PDF engine can't draw with a standard font
 * (Devanagari and other complex scripts, CJK, emoji). The browser shapes the
 * text on a canvas (conjuncts, matras and reph come out right) and the engine
 * places the result as an image with a soft mask, so it looks the same in
 * every viewer. Lives outside @/engine so the PDF core stays DOM-free.
 */
import pako from 'pako';
import type { RasterTextLine } from '@/engine';

/** Fonts with good Devanagari coverage first, then Latin fallbacks. */
export const COMPLEX_TEXT_FONT_FAMILY =
  '"Noto Sans Devanagari", "Kohinoor Devanagari", "Nirmala UI", "Mangal", "Devanagari Sangam MN", ' +
  '"Noto Sans", Helvetica, Arial, sans-serif';

/** Pixels per PDF point: sharp when printed and when zoomed to 400 %. */
const PX_PER_PT = 4;
/** Canvas size limit (px) per side, well under every browser's maximum. */
const MAX_PX = 8000;

export function rasterizeTextLine(
  text: string,
  fontSize: number,
  color: [number, number, number],
  fontFamily = COMPLEX_TEXT_FONT_FAMILY,
): RasterTextLine | null {
  if (typeof document === 'undefined' || !text || fontSize <= 0) return null;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  let ppt = PX_PER_PT;
  const font = () => `${fontSize * ppt}px ${fontFamily}`;
  ctx.font = font();
  let m = ctx.measureText(text);
  if (m.width * 1.2 > MAX_PX) {
    ppt = Math.max(0.5, (PX_PER_PT * MAX_PX) / (m.width * 1.2));
    ctx.font = font();
    m = ctx.measureText(text);
  }
  const px = fontSize * ppt;
  // Room for ascenders, matras above the headline and descenders below.
  const ascent = Math.ceil(Math.max(m.actualBoundingBoxAscent || 0, m.fontBoundingBoxAscent || 0, px * 0.9)) + 2;
  const descent = Math.ceil(Math.max(m.actualBoundingBoxDescent || 0, m.fontBoundingBoxDescent || 0, px * 0.3)) + 2;
  const left = Math.ceil(Math.max(0, m.actualBoundingBoxLeft || 0)) + 1;
  const width = Math.min(MAX_PX, Math.ceil(left + Math.max(m.width, m.actualBoundingBoxRight || 0)) + 2);
  const height = Math.min(MAX_PX, ascent + descent);
  canvas.width = width;
  canvas.height = height;
  ctx.font = font();
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#000';
  ctx.fillText(text, left, ascent);

  const rgba = ctx.getImageData(0, 0, width, height).data;
  const alpha = new Uint8Array(width * height);
  const rgb = new Uint8Array(width * height * 3);
  const [r, g, b] = color.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255));
  for (let i = 0; i < width * height; i++) {
    alpha[i] = rgba[i * 4 + 3];
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
  }
  return {
    widthPx: width,
    heightPx: height,
    rgb: pako.deflate(rgb),
    alpha: pako.deflate(alpha),
    rgbSamples: rgb,
    alphaSamples: alpha,
    widthPt: width / ppt,
    heightPt: height / ppt,
    baselinePt: descent / ppt,
    advancePt: m.width / ppt,
  };
}
