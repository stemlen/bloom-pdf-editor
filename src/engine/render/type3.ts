/**
 * Type3 font glyph rendering — interpret CharProcs content streams as glyph outlines.
 */

import type { FontData } from '../fonts/font-parser';
import { parseContentStream, type CSInstruction } from '../content/operator-lexer';
import { PDFName, PDFNumber, type PDFObject, type PDFStream } from '../types';
import { decodeImage } from './image-decoder';

/** Decoded Type3 glyph images, ready for synchronous drawing (BE-205). */
const type3ImageCache = new WeakMap<PDFStream, OffscreenCanvas | null>();

/**
 * Decode the images Type3 glyphs paint (colour emoji) ahead of drawing, since
 * glyphs are drawn synchronously and image decoding is asynchronous.
 */
export async function prepareType3Images(
  fonts: Map<string, FontData>,
  objects: Map<string, PDFObject>,
): Promise<void> {
  if (typeof OffscreenCanvas === 'undefined') return;
  const jobs: Promise<void>[] = [];
  for (const font of fonts.values()) {
    if (!font.type3Images) continue;
    for (const stream of font.type3Images.values()) {
      if (type3ImageCache.has(stream)) continue;
      type3ImageCache.set(stream, null);
      jobs.push((async () => {
        try {
          const decoded = await decodeImage(stream, objects);
          if (!decoded) return;
          const canvas = new OffscreenCanvas(decoded.width, decoded.height);
          const ctx = canvas.getContext('2d');
          if (!ctx) return;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ctx.putImageData(new ImageData(decoded.data as any, decoded.width, decoded.height), 0, 0);
          type3ImageCache.set(stream, canvas);
        } catch {
          // Leave the glyph blank rather than failing the page.
        }
      })());
    }
  }
  await Promise.all(jobs);
}

/**
 * Parsed CharProcs are cached per stream object (not per draw call). The same
 * few glyph shapes are typically reused hundreds of times across a page
 * (e.g. common letters), and the underlying PDFStream instances stay stable
 * across re-renders (zoom, scroll) since the parsed document is reused —
 * re-parsing on every glyph occurrence was a significant, avoidable cost.
 */
const charProcInstructionCache = new WeakMap<PDFStream, CSInstruction[] | null>();

function getCharProcInstructions(stream: PDFStream): CSInstruction[] | null {
  const cached = charProcInstructionCache.get(stream);
  if (cached !== undefined) return cached;

  const bytes = stream.getBytes();
  let instructions: CSInstruction[] | null = null;
  if (bytes && bytes.length > 0) {
    try {
      instructions = parseContentStream(bytes);
    } catch {
      instructions = null;
    }
  }
  charProcInstructionCache.set(stream, instructions);
  return instructions;
}

/**
 * Draw a Type3 glyph into the current canvas context.
 * CharProcs are miniature content streams in glyph space (FontMatrix).
 */
export function drawType3Glyph(
  ctx: CanvasRenderingContext2D,
  fontData: FontData,
  charName: string,
  x: number,
  y: number,
  fontSize: number,
): boolean {
  const stream = fontData.charProcs?.get(charName);
  if (!stream) return false;

  const instructions = getCharProcInstructions(stream);
  if (!instructions) return false;

  const matrix = fontData.fontMatrix ?? [0.001, 0, 0, 0.001, 0, 0];
  ctx.save();
  ctx.translate(x, y);
  ctx.transform(
    matrix[0] * fontSize,
    matrix[1] * fontSize,
    matrix[2] * fontSize,
    matrix[3] * fontSize,
    matrix[4] * fontSize,
    matrix[5] * fontSize,
  );

  ctx.beginPath();
  let cx = 0;
  let cy = 0;

  for (const inst of instructions) {
    const ops = inst.operands;
    const n = (i: number) => {
      const o = ops[i];
      return o instanceof PDFNumber ? o.value : 0;
    };

    switch (inst.operator) {
      case 'm':
        cx = n(0); cy = n(1);
        ctx.moveTo(cx, cy);
        break;
      case 'l':
        cx = n(0); cy = n(1);
        ctx.lineTo(cx, cy);
        break;
      case 'c':
        ctx.bezierCurveTo(n(0), n(1), n(2), n(3), n(4), n(5));
        cx = n(4); cy = n(5);
        break;
      case 'v':
        ctx.bezierCurveTo(cx, cy, n(0), n(1), n(2), n(3));
        cx = n(2); cy = n(3);
        break;
      case 'y':
        ctx.bezierCurveTo(n(0), n(1), n(2), n(3), n(2), n(3));
        cx = n(2); cy = n(3);
        break;
      case 'h':
        ctx.closePath();
        break;
      case 're':
        ctx.rect(n(0), n(1), n(2), n(3));
        break;
      case 'f':
      case 'F':
      case 'f*':
        ctx.fill();
        ctx.beginPath();
        break;
      case 'S':
        ctx.stroke();
        ctx.beginPath();
        break;
      case 'B':
      case 'B*':
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        break;
      case 'd0':
      case 'd1':
        break;
      case 'q':
        ctx.save();
        break;
      case 'Q':
        ctx.restore();
        break;
      case 'cm':
        ctx.transform(n(0), n(1), n(2), n(3), n(4), n(5));
        break;
      case 'Do': {
        // Image glyph: paint the decoded image into the unit square.
        const nameOp = ops[0];
        const stream = nameOp instanceof PDFName ? fontData.type3Images?.get(nameOp.name) : undefined;
        const img = stream ? type3ImageCache.get(stream) : undefined;
        if (img) {
          ctx.save();
          ctx.scale(1 / img.width, -1 / img.height);
          ctx.translate(0, -img.height);
          ctx.drawImage(img, 0, 0);
          ctx.restore();
        }
        break;
      }
      default:
        break;
    }
  }

  ctx.restore();
  return true;
}

/** Resolve a character code to a Type3 CharProcs name. */
export function type3CharName(fontData: FontData, charCode: number): string | null {
  if (!fontData.charProcs || fontData.charProcs.size === 0) return null;

  // The font's /Encoding Differences array is the authoritative source for
  // charCode → glyph name (Type3 fonts have no standard/built-in encoding).
  // Generators are free to name procs arbitrarily (decimal, hex, custom),
  // so trust this mapping before guessing a naming convention.
  const diffName = fontData.differences.get(charCode);
  if (diffName) {
    return fontData.charProcs.has(diffName) ? diffName : null;
  }

  const candidates = [
    `g${charCode}`,
    `g${charCode.toString(16).toUpperCase()}`,
    `C${charCode}`,
    String(charCode),
  ];
  for (const c of candidates) {
    if (fontData.charProcs.has(c)) return c;
  }
  // No reliable mapping — return null so callers fall back to drawing the
  // resolved Unicode glyph instead of an arbitrary (likely wrong) proc.
  return null;
}
