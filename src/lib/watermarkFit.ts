/**
 * Factor (at most 1) that shrinks a single watermark so its rotated bounding
 * box fits inside the page with `pad` points to spare on every side (BE-314).
 * The editor applies it to both the live preview and the saved watermark, so
 * the two always match.
 */
export function watermarkFitScale(
  width: number,
  height: number,
  rotationDeg: number,
  pageWidth: number,
  pageHeight: number,
  pad = 30,
): number {
  if (width <= 0 || height <= 0) return 1;
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const boxW = width * cos + height * sin;
  const boxH = width * sin + height * cos;
  const availW = Math.max(1, pageWidth - 2 * pad);
  const availH = Math.max(1, pageHeight - 2 * pad);
  return Math.min(1, availW / boxW, availH / boxH);
}

/** Natural (unscaled) size in points of a watermark at `sizePercent`. */
export function watermarkNaturalSize(
  type: 'text' | 'image' | 'shape',
  text: string,
  sizePercent: number,
  imageDims: { width: number; height: number } | null,
  shapeType: 'rectangle' | 'circle' | 'pill',
): { width: number; height: number } {
  const fontSize = 72 * (sizePercent / 100);
  if (type === 'image') {
    return imageDims
      ? { width: imageDims.width * (sizePercent / 100), height: imageDims.height * (sizePercent / 100) }
      : { width: 0, height: 0 };
  }
  const textWidth = text.length * fontSize * 0.5;
  if (type === 'text') return { width: textWidth, height: fontSize };
  let w = textWidth + 40;
  let h = fontSize + 40;
  if (shapeType === 'circle') w = h = Math.max(w, h);
  return { width: w, height: h };
}
