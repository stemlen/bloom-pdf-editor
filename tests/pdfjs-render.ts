/** Renders PDF pages with pdf.js in Node, to check what an independent reader actually draws. */

export interface RenderedPage {
  width: number;
  height: number;
  /** RGBA pixels. */
  data: Uint8ClampedArray;
  /** Pixels per PDF point. */
  scale: number;
  /** Page size in points, as displayed (after /Rotate). */
  pageWidth: number;
  pageHeight: number;
}

export async function renderWithPdfJs(bytes: Uint8Array, pageNumber = 1, scale = 1): Promise<RenderedPage> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const factory = (doc as unknown as { canvasFactory: { create(w: number, h: number): { canvas: unknown; context: CanvasRenderingContext2D } } }).canvasFactory;
  const { canvas, context } = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
  await page.render({ canvas: canvas as HTMLCanvasElement, canvasContext: context, viewport, annotationMode: pdfjs.AnnotationMode.ENABLE }).promise;
  const img = context.getImageData(0, 0, Math.ceil(viewport.width), Math.ceil(viewport.height));
  return { width: img.width, height: img.height, data: img.data, scale, pageWidth: viewport.width / scale, pageHeight: viewport.height / scale };
}

/**
 * Share of dark pixels inside a box given in displayed page points with the
 * origin at the top-left (as the page appears on screen).
 */
export function inkIn(page: RenderedPage, box: { x: number; y: number; width: number; height: number }): number {
  const x0 = Math.max(0, Math.floor(box.x * page.scale));
  const y0 = Math.max(0, Math.floor(box.y * page.scale));
  const x1 = Math.min(page.width, Math.ceil((box.x + box.width) * page.scale));
  const y1 = Math.min(page.height, Math.ceil((box.y + box.height) * page.scale));
  let dark = 0;
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * page.width + x) * 4;
      total++;
      if (page.data[i] + page.data[i + 1] + page.data[i + 2] < 3 * 160) dark++;
    }
  }
  return total ? dark / total : 0;
}
