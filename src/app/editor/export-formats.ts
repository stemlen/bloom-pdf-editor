/**
 * Client-side export for editor-only formats (images + plain text).
 *
 * Document conversion (DOCX / Markdown / XLSX / …) uses the Bloom engine
 * (`server/`) via the Intermediate Document Model, run in a Web Worker
 * (see src/lib/bloom-api.ts).
 */

import type { PDFDocumentData } from '@/engine';
import type { ConvertTarget } from '@/lib/bloom-api';

// ─── Types ─────────────────────────────────────────────────────────────────────

export type ExportFormat = 'png' | 'jpeg' | 'svg' | 'txt';

export interface ExportFormatInfo {
  id: ExportFormat;
  label: string;
  description: string;
  extension: string;
  icon: string;
  mimeType: string;
  supportsQuality: boolean;
  supportsDpi: boolean;
  supportsPageRange: boolean;
}

export const EXPORT_FORMATS: ExportFormatInfo[] = [
  {
    id: 'png',
    label: 'PNG Image',
    description: 'Lossless, pixel-perfect render at chosen DPI',
    extension: '.png',
    icon: '🖼️',
    mimeType: 'image/png',
    supportsQuality: false,
    supportsDpi: true,
    supportsPageRange: true,
  },
  {
    id: 'jpeg',
    label: 'JPEG Image',
    description: 'Compressed image, adjustable quality',
    extension: '.jpg',
    icon: '📸',
    mimeType: 'image/jpeg',
    supportsQuality: true,
    supportsDpi: true,
    supportsPageRange: true,
  },
  {
    id: 'svg',
    label: 'SVG (page image)',
    description: 'Each page as a picture inside an SVG file; text isn’t editable',
    extension: '.svg',
    icon: '✏️',
    mimeType: 'image/svg+xml',
    supportsQuality: false,
    supportsDpi: false,
    supportsPageRange: true,
  },
  {
    id: 'txt',
    label: 'Plain text',
    description: 'Text line by line, as shown in the editor',
    extension: '.txt',
    icon: '📃',
    mimeType: 'text/plain',
    supportsQuality: false,
    supportsDpi: false,
    supportsPageRange: true,
  },
];

export type ConvertFormatGroup = 'office' | 'web' | 'data';

export interface ConvertFormatInfo {
  id: ConvertTarget;
  label: string;
  description: string;
  extension: string;
  group: ConvertFormatGroup;
}

export const CONVERT_FORMATS: ConvertFormatInfo[] = [
  {
    id: 'docx',
    label: 'Word (DOCX)',
    description: 'Editable Word document from document structure',
    extension: '.docx',
    group: 'office',
  },
  {
    id: 'xlsx',
    label: 'Excel (XLSX)',
    description: 'Worksheets from detected tables',
    extension: '.xlsx',
    group: 'office',
  },
  {
    id: 'pptx',
    label: 'PowerPoint (PPTX)',
    description: 'Editable slides from pages',
    extension: '.pptx',
    group: 'office',
  },
  {
    id: 'odt',
    label: 'OpenDocument',
    description: 'Text document for LibreOffice and other office apps',
    extension: '.odt',
    group: 'office',
  },
  {
    id: 'rtf',
    label: 'Rich Text',
    description: 'RTF with basic formatting',
    extension: '.rtf',
    group: 'office',
  },
  {
    id: 'html',
    label: 'HTML',
    description: 'Web page with headings, lists and tables',
    extension: '.html',
    group: 'web',
  },
  {
    id: 'markdown',
    label: 'Markdown',
    description: 'Headings, lists and tables',
    extension: '.md',
    group: 'web',
  },
  {
    id: 'epub',
    label: 'EPUB',
    description: 'Ebook package from sections',
    extension: '.epub',
    group: 'web',
  },
  {
    id: 'txt',
    label: 'Plain text (paragraphs)',
    description: 'Text as paragraphs in reading order',
    extension: '.txt',
    group: 'web',
  },
  {
    id: 'json',
    label: 'JSON',
    description: 'Document structure: headings, paragraphs, tables',
    extension: '.json',
    group: 'data',
  },
  {
    id: 'xml',
    label: 'XML',
    description: 'Well-formed document model',
    extension: '.xml',
    group: 'data',
  },
  {
    id: 'svg',
    label: 'SVG (structure)',
    description: 'Editable text and shapes from the document structure',
    extension: '.svg',
    group: 'data',
  },
];

export const CONVERT_GROUP_LABELS: Record<ConvertFormatGroup, string> = {
  office: 'Office',
  web: 'Web & ebook',
  data: 'Data',
};

export interface ExportOptions {
  format: ExportFormat;
  pages: number[] | null;
  dpi: number;
  quality: number;
  title: string;
}

export interface ExportResult {
  blob: Blob;
  filename: string;
  mimeType: string;
}

export interface SizeEstimation {
  currentSizeBytes: number;
  minAchievableBytes: number;
  estimatedBytes: number;
  textContentBytes: number;
  imageContentBytes: number;
  metadataBytes: number;
  imageCount: number;
  pageCount: number;
  zone: 'green' | 'yellow' | 'red';
  message: string;
}

// ─── Image Export (PNG/JPEG) ────────────────────────────────────────────────────

export async function exportPageToImage(
  doc: PDFDocumentData,
  pageIndex: number,
  engine: typeof import('@/engine'),
  format: 'png' | 'jpeg' = 'png',
  dpi: number = 150,
  quality: number = 0.92,
): Promise<Blob> {
  const page = doc.pages[pageIndex];
  if (!page) throw new Error(`Page ${pageIndex} not found`);

  const scale = dpi / 72;
  const result = await engine.renderPage(doc, pageIndex, { scale });
  const canvas = result.canvas;

  return new Promise<Blob>((resolve, reject) => {
    const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Canvas toBlob failed'))),
      mimeType,
      format === 'jpeg' ? quality : undefined,
    );
  });
}

export async function exportToImages(
  doc: PDFDocumentData,
  engine: typeof import('@/engine'),
  options: ExportOptions,
  onProgress?: (current: number, total: number) => void,
): Promise<ExportResult> {
  const pages = options.pages ?? Array.from({ length: doc.pages.length }, (_, i) => i);
  const format = options.format as 'png' | 'jpeg';

  if (pages.length === 1) {
    const blob = await exportPageToImage(doc, pages[0], engine, format, options.dpi, options.quality);
    onProgress?.(1, 1);
    return {
      blob,
      filename: `${options.title}_page${pages[0] + 1}.${format === 'jpeg' ? 'jpg' : 'png'}`,
      mimeType: blob.type,
    };
  }

  const entries: ZipEntry[] = [];
  for (let i = 0; i < pages.length; i++) {
    const blob = await exportPageToImage(doc, pages[i], engine, format, options.dpi, options.quality);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    entries.push({
      name: `page_${String(pages[i] + 1).padStart(3, '0')}.${format === 'jpeg' ? 'jpg' : 'png'}`,
      data: bytes,
    });
    onProgress?.(i + 1, pages.length);
  }

  return {
    blob: buildZip(entries),
    filename: `${options.title}_images.zip`,
    mimeType: 'application/zip',
  };
}

// ─── SVG Export ─────────────────────────────────────────────────────────────────

export async function exportPageToSVG(
  doc: PDFDocumentData,
  pageIndex: number,
  engine: typeof import('@/engine'),
): Promise<string> {
  const page = doc.pages[pageIndex];
  if (!page) throw new Error(`Page ${pageIndex} not found`);

  const scale = 2;
  const mediaBox = page.mediaBox;
  const pageWidth = mediaBox.width;
  const pageHeight = mediaBox.height;

  const result = await engine.renderPage(doc, pageIndex, { scale });
  const canvas = result.canvas;
  const dataUrl = canvas.toDataURL('image/png');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     width="${pageWidth}" height="${pageHeight}" viewBox="0 0 ${pageWidth} ${pageHeight}">
  <title>Page ${pageIndex + 1}</title>
  <image width="${pageWidth}" height="${pageHeight}" xlink:href="${dataUrl}" />
</svg>`;
}

export async function exportToSVG(
  doc: PDFDocumentData,
  engine: typeof import('@/engine'),
  options: ExportOptions,
  onProgress?: (current: number, total: number) => void,
): Promise<ExportResult> {
  const pages = options.pages ?? Array.from({ length: doc.pages.length }, (_, i) => i);

  if (pages.length === 1) {
    const svg = await exportPageToSVG(doc, pages[0], engine);
    onProgress?.(1, 1);
    return {
      blob: new Blob([svg], { type: 'image/svg+xml' }),
      filename: `${options.title}_page${pages[0] + 1}.svg`,
      mimeType: 'image/svg+xml',
    };
  }

  const entries: ZipEntry[] = [];
  for (let i = 0; i < pages.length; i++) {
    const svg = await exportPageToSVG(doc, pages[i], engine);
    entries.push({
      name: `page_${String(pages[i] + 1).padStart(3, '0')}.svg`,
      data: new TextEncoder().encode(svg),
    });
    onProgress?.(i + 1, pages.length);
  }

  return {
    blob: buildZip(entries),
    filename: `${options.title}_svg.zip`,
    mimeType: 'application/zip',
  };
}

// ─── Plain Text ─────────────────────────────────────────────────────────────────

export async function exportToPlainText(
  doc: PDFDocumentData,
  engine: typeof import('@/engine'),
  options: ExportOptions,
  onProgress?: (current: number, total: number) => void,
): Promise<ExportResult> {
  const pages = options.pages ?? Array.from({ length: doc.pages.length }, (_, i) => i);
  const parts: string[] = [];

  for (let i = 0; i < pages.length; i++) {
    const text = engine.extractPagePlainText(doc, pages[i]);
    parts.push(text);
    onProgress?.(i + 1, pages.length);
  }

  return {
    blob: new Blob([parts.join('\n\n--- Page Break ---\n\n')], { type: 'text/plain' }),
    filename: `${options.title}.txt`,
    mimeType: 'text/plain',
  };
}

// ─── Master Export Function ─────────────────────────────────────────────────────

export async function exportDocument(
  doc: PDFDocumentData,
  engine: typeof import('@/engine'),
  options: ExportOptions,
  onProgress?: (current: number, total: number) => void,
): Promise<ExportResult> {
  switch (options.format) {
    case 'png':
    case 'jpeg':
      return exportToImages(doc, engine, options, onProgress);
    case 'svg':
      return exportToSVG(doc, engine, options, onProgress);
    case 'txt':
      return exportToPlainText(doc, engine, options, onProgress);
    default:
      throw new Error(`Unsupported export format: ${options.format}`);
  }
}

// ─── File Size Estimation ───────────────────────────────────────────────────────

export function estimateDocumentSize(doc: PDFDocumentData): SizeEstimation {
  const currentSizeBytes = doc.rawBytes?.length ?? 0;
  const pageCount = doc.pages.length;

  let imageCount = 0;
  let imageContentBytes = 0;

  for (const [, obj] of doc.objects) {
    if (obj && typeof obj === 'object' && 'rawBytes' in obj) {
      const stream = obj as {
        rawBytes?: Uint8Array;
        dict?: { getName?: (k: string) => string | undefined };
      };
      const bytes = stream.rawBytes?.length ?? 0;
      const subtype = stream.dict?.getName?.('Subtype');
      if (subtype === 'Image') {
        imageCount++;
        imageContentBytes += bytes;
      }
    }
  }

  const textContentBytes = Math.max(0, currentSizeBytes - imageContentBytes);
  const metadataBytes = Math.max(1024, pageCount * 256);

  let minAchievableBytes: number;
  if (imageCount === 0 || imageContentBytes === 0) {
    minAchievableBytes = Math.max(
      Math.round(currentSizeBytes * 0.95),
      metadataBytes,
      2048,
    );
  } else {
    const minImageBytes = Math.max(imageCount * 1500, Math.round(imageContentBytes * 0.08));
    const minTextBytes = Math.round(textContentBytes * 0.7);
    minAchievableBytes = Math.max(metadataBytes + minTextBytes + minImageBytes, 2048);
    minAchievableBytes = Math.max(minAchievableBytes, Math.round(currentSizeBytes * 0.15));
  }

  if (currentSizeBytes > 0) {
    minAchievableBytes = Math.min(minAchievableBytes, currentSizeBytes);
  }

  return {
    currentSizeBytes,
    minAchievableBytes,
    estimatedBytes: currentSizeBytes,
    textContentBytes,
    imageContentBytes,
    metadataBytes,
    imageCount,
    pageCount,
    zone: 'green',
    message: '',
  };
}

export function evaluateTargetSize(
  estimation: SizeEstimation,
  targetBytes: number,
): SizeEstimation {
  const { currentSizeBytes, minAchievableBytes, imageCount } = estimation;

  let zone: 'green' | 'yellow' | 'red';
  let message: string;

  if (targetBytes >= currentSizeBytes) {
    zone = 'green';
    message = 'Target is at or above the current size — file will be saved as-is (light optimize only).';
  } else if (targetBytes < minAchievableBytes) {
    zone = 'red';
    message =
      imageCount === 0
        ? `Not achievable. This PDF has no compressible images (current ${formatFileSize(currentSizeBytes)}). Minimum realistic size ≈ ${formatFileSize(minAchievableBytes)}.`
        : `Not achievable. Minimum realistic size with heavy image compression ≈ ${formatFileSize(minAchievableBytes)}.`;
  } else if (imageCount === 0) {
    zone = 'yellow';
    message = `Limited savings possible (text/fonts). Best case ≈ ${formatFileSize(minAchievableBytes)} — will not rasterize pages (that would make the file larger).`;
  } else if (targetBytes >= currentSizeBytes * 0.55) {
    zone = 'green';
    message = 'Achievable by recompressing embedded images.';
  } else {
    zone = 'yellow';
    message = `Achievable with heavy image quality reduction (${imageCount} image${imageCount > 1 ? 's' : ''}).`;
  }

  return {
    ...estimation,
    estimatedBytes: Math.max(targetBytes, minAchievableBytes),
    zone,
    message,
  };
}

// ─── Utility: Format File Size ──────────────────────────────────────────────────

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function parseFileSize(input: string): number | null {
  const match = input.trim().match(/^([\d.]+)\s*(b|kb|mb|gb)?$/i);
  if (!match) return null;
  const value = parseFloat(match[1]);
  if (isNaN(value) || value <= 0) return null;
  const unit = (match[2] || 'b').toLowerCase();
  switch (unit) {
    case 'b': return Math.round(value);
    case 'kb': return Math.round(value * 1024);
    case 'mb': return Math.round(value * 1024 * 1024);
    case 'gb': return Math.round(value * 1024 * 1024 * 1024);
    default: return Math.round(value);
  }
}

// ─── Minimal ZIP Builder (no dependencies) ──────────────────────────────────────

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

function buildZip(entries: ZipEntry[]): Blob {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const centralDir: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const data = entry.data;
    const crc = crc32(data);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lhView = new DataView(localHeader.buffer);
    lhView.setUint32(0, 0x04034b50, true);
    lhView.setUint16(4, 20, true);
    lhView.setUint16(6, 0, true);
    lhView.setUint16(8, 0, true);
    lhView.setUint16(10, 0, true);
    lhView.setUint16(12, 0, true);
    lhView.setUint32(14, crc, true);
    lhView.setUint32(18, data.length, true);
    lhView.setUint32(22, data.length, true);
    lhView.setUint16(26, nameBytes.length, true);
    lhView.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    const cdHeader = new Uint8Array(46 + nameBytes.length);
    const cdView = new DataView(cdHeader.buffer);
    cdView.setUint32(0, 0x02014b50, true);
    cdView.setUint16(4, 20, true);
    cdView.setUint16(6, 20, true);
    cdView.setUint16(8, 0, true);
    cdView.setUint16(10, 0, true);
    cdView.setUint16(12, 0, true);
    cdView.setUint16(14, 0, true);
    cdView.setUint32(16, crc, true);
    cdView.setUint32(20, data.length, true);
    cdView.setUint32(24, data.length, true);
    cdView.setUint16(28, nameBytes.length, true);
    cdView.setUint16(30, 0, true);
    cdView.setUint16(32, 0, true);
    cdView.setUint16(34, 0, true);
    cdView.setUint16(36, 0, true);
    cdView.setUint32(38, 0, true);
    cdView.setUint32(42, offset, true);
    cdHeader.set(nameBytes, 46);

    parts.push(localHeader);
    parts.push(data);
    centralDir.push(cdHeader);

    offset += localHeader.length + data.length;
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const cd of centralDir) {
    parts.push(cd);
    cdSize += cd.length;
  }

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, cdSize, true);
  eocdView.setUint32(16, cdOffset, true);
  eocdView.setUint16(20, 0, true);
  parts.push(eocd);

  return new Blob(parts as BlobPart[], { type: 'application/zip' });
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
