/**
 * OCR adapter interface — lives outside @/engine so the PDF core stays dependency-free.
 */

export interface OcrWord {
  text: string;
  bbox: { x: number; y: number; width: number; height: number };
  confidence: number;
}

export interface OcrAdapter {
  recognize(imageData: ImageData): Promise<OcrWord[]>;
}

/** Stub adapter — returns empty or mock words (tests). */
export class StubOcrAdapter implements OcrAdapter {
  constructor(private mockWords: OcrWord[] = []) {}

  async recognize(_imageData: ImageData): Promise<OcrWord[]> {
    return this.mockWords.slice();
  }
}

/**
 * Tesseract.js adapter — real OCR in the browser.
 * Lazily loads the worker on first recognize() call.
 */
export class TesseractOcrAdapter implements OcrAdapter {
  private workerPromise: Promise<import('tesseract.js').Worker> | null = null;

  private async getWorker() {
    if (!this.workerPromise) {
      this.workerPromise = (async () => {
        const Tesseract = await import('tesseract.js');
        const worker = await Tesseract.createWorker('eng');
        return worker;
      })();
    }
    return this.workerPromise;
  }

  async recognize(imageData: ImageData): Promise<OcrWord[]> {
    const worker = await this.getWorker();

    // Tesseract accepts canvas / ImageData via a temporary canvas
    const canvas = document.createElement('canvas');
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return [];
    ctx.putImageData(imageData, 0, 0);

    // tesseract.js ≥ 6 only returns word boxes when `blocks` output is requested,
    // nested as blocks → paragraphs → lines → words.
    const result = await worker.recognize(canvas, {}, { blocks: true });
    type TWord = { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } };
    const data = result.data as {
      words?: TWord[];
      blocks?: Array<{ paragraphs?: Array<{ lines?: Array<{ words?: TWord[] }> }> }> | null;
    };
    const found: TWord[] = data.words?.length
      ? data.words
      : (data.blocks ?? []).flatMap((b) => (b.paragraphs ?? []).flatMap((p) => (p.lines ?? []).flatMap((l) => l.words ?? [])));
    const words: OcrWord[] = [];

    for (const w of found) {
      const text = (w.text || '').trim();
      if (!text) continue;
      if (w.confidence < 35) continue;
      words.push({
        text,
        confidence: w.confidence / 100,
        bbox: {
          x: w.bbox.x0,
          y: w.bbox.y0,
          width: Math.max(1, w.bbox.x1 - w.bbox.x0),
          height: Math.max(1, w.bbox.y1 - w.bbox.y0),
        },
      });
    }

    return words;
  }

  async terminate(): Promise<void> {
    if (this.workerPromise) {
      const w = await this.workerPromise;
      await w.terminate();
      this.workerPromise = null;
    }
  }
}

/** Default production adapter. */
export function createDefaultOcrAdapter(): OcrAdapter {
  if (typeof window !== 'undefined') {
    return new TesseractOcrAdapter();
  }
  return new StubOcrAdapter();
}

export function canvasToImageData(canvas: HTMLCanvasElement): ImageData {
  // The page canvas is transparent where nothing is painted; flatten it onto
  // white first, or OCR sees black text on a black (alpha 0) background.
  const flat = document.createElement('canvas');
  flat.width = canvas.width;
  flat.height = canvas.height;
  const ctx = flat.getContext('2d');
  if (!ctx) throw new Error('2D context unavailable');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, flat.width, flat.height);
  ctx.drawImage(canvas, 0, 0);
  return ctx.getImageData(0, 0, flat.width, flat.height);
}

/**
 * Map OCR pixel boxes (CSS/canvas space, y-down) to PDF user-space (y-up).
 * `scale` is the render scale used when the canvas was produced.
 * `dpr` accounts for devicePixelRatio backing-store sizing.
 */
export function mapOcrWordsToPdf(
  words: OcrWord[],
  pageHeight: number,
  scale: number,
  mediaBoxY = 0,
  dpr = 1,
  mediaBoxX = 0,
): OcrWord[] {
  const s = scale * dpr;
  return words.map(w => {
    const pdfX = w.bbox.x / s + mediaBoxX;
    const pdfHeight = w.bbox.height / s;
    const topCss = w.bbox.y / s;
    const pdfY = pageHeight - topCss - pdfHeight + mediaBoxY;
    return {
      text: w.text,
      confidence: w.confidence,
      bbox: {
        x: pdfX,
        y: pdfY,
        width: w.bbox.width / s,
        height: pdfHeight,
      },
    };
  });
}
