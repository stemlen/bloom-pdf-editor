/**
 * Annotation Engine
 *
 * Creates and manages PDF annotation objects. Unlike canvas overlays,
 * these are real PDF annotations stored in the document structure.
 *
 * Supports:
 *   - Text markup: Highlight, Underline, StrikeOut, Squiggly
 *   - FreeText: Arbitrary text at any position
 *   - Ink: Freehand drawing (e.g., signatures)
 *   - Stamp: Predefined or custom stamps
 *   - Redaction: Marks areas for content removal
 *   - Link: Hyperlinks to URLs or page destinations
 *
 * Each annotation creates:
 *   1. An annotation dictionary in the page's /Annots array
 *   2. An appearance stream (/AP) so the annotation renders correctly
 *      in any viewer without rebuilding appearances
 */

import {
  PDFArray,
  PDFBoolean,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFRectangle,
} from '../types';
import { flateEncode } from '../parser/filters';

// ─── Annotation types ───────────────────────────────────────────────────────

export interface AnnotationBase {
  /** Bounding rectangle in PDF coordinates [x1, y1, x2, y2] */
  rect: PDFRectangle;
  /** Annotation color as RGB (0-1) */
  color: [number, number, number];
  /** Opacity (0-1) */
  opacity: number;
  /** Author/title */
  author?: string;
  /** Contents/description */
  contents?: string;
  /** Modification date */
  modDate?: string;
}

export interface HighlightAnnotation extends AnnotationBase {
  type: 'Highlight' | 'Underline' | 'StrikeOut' | 'Squiggly';
  /** QuadPoints: array of [x1,y1,...,x4,y4] defining the text region */
  quadPoints: number[];
}

export interface FreeTextAnnotation extends AnnotationBase {
  type: 'FreeText';
  /** The text to display */
  text: string;
  /** Font size in points */
  fontSize: number;
  /** Font name (CSS family name) */
  fontName: string;
  /** Text color */
  textColor: [number, number, number];
  /** Border width (0 for none) */
  borderWidth: number;
}

export interface InkAnnotation extends AnnotationBase {
  type: 'Ink';
  /** Array of ink paths. Each path is [x1,y1, x2,y2, ...] */
  inkPaths: number[][];
  /** Stroke width */
  lineWidth: number;
}

export interface LineAnnotation extends AnnotationBase {
  type: 'Line';
  /** Start and end in PDF user space */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  lineWidth: number;
  /** Line ending styles: None | OpenArrow | ClosedArrow */
  startStyle?: 'None' | 'OpenArrow' | 'ClosedArrow';
  endStyle?: 'None' | 'OpenArrow' | 'ClosedArrow';
}

export interface SquareAnnotation extends AnnotationBase {
  type: 'Square';
  lineWidth: number;
  /** Optional fill color (null = stroke only) */
  fillColor?: [number, number, number] | null;
}

export interface CircleAnnotation extends AnnotationBase {
  type: 'Circle';
  lineWidth: number;
  fillColor?: [number, number, number] | null;
}

export interface StampAnnotation extends AnnotationBase {
  type: 'Stamp';
  /** Stamp name: Approved, NotApproved, Draft, etc. */
  stampName: string;
}

export interface RedactAnnotation extends AnnotationBase {
  type: 'Redact';
  /** QuadPoints defining the text region to redact */
  quadPoints: number[];
  /** Overlay text (shown after redaction is applied) */
  overlayText?: string;
}

export interface LinkAnnotation extends AnnotationBase {
  type: 'Link';
  /** URL to link to */
  url?: string;
  /** Destination page index (for internal links) */
  destPage?: number;
}

export type Annotation =
  | HighlightAnnotation
  | FreeTextAnnotation
  | InkAnnotation
  | LineAnnotation
  | SquareAnnotation
  | CircleAnnotation
  | StampAnnotation
  | RedactAnnotation
  | LinkAnnotation;

// ─── Annotation creation ────────────────────────────────────────────────────

/**
 * Create a PDF annotation dictionary from our annotation specification.
 * Returns the dictionary ready to be added to a page's /Annots array.
 */
export function createAnnotationDict(
  annotation: Annotation,
  nextObjNum: number,
): { dict: PDFDict; appearanceStream: PDFStream | null } {
  const dict = new PDFDict();

  // Common entries
  dict.set('Type', new PDFName('Annot'));
  dict.set('Rect', rectToArray(annotation.rect));
  dict.set('C', new PDFArray([
    new PDFNumber(annotation.color[0]),
    new PDFNumber(annotation.color[1]),
    new PDFNumber(annotation.color[2]),
  ]));

  if (annotation.opacity < 1) {
    dict.set('CA', new PDFNumber(annotation.opacity));
  }

  if (annotation.author) {
    dict.set('T', new PDFString(annotation.author));
  }
  if (annotation.contents) {
    dict.set('Contents', new PDFString(annotation.contents));
  }
  if (annotation.modDate) {
    dict.set('M', new PDFString(annotation.modDate));
  }

  // Flag: Print (bit 3)
  dict.set('F', new PDFNumber(4));

  let appearanceStream: PDFStream | null = null;

  switch (annotation.type) {
    case 'Highlight':
    case 'Underline':
    case 'StrikeOut':
    case 'Squiggly':
      dict.set('Subtype', new PDFName(annotation.type));
      dict.set('QuadPoints', new PDFArray(
        annotation.quadPoints.map((n) => new PDFNumber(n)),
      ));
      appearanceStream = buildHighlightAppearance(annotation);
      break;

    case 'FreeText':
      dict.set('Subtype', new PDFName('FreeText'));
      dict.set('DA', new PDFString(
        `/${annotation.fontName} ${annotation.fontSize} Tf ` +
        `${annotation.textColor[0]} ${annotation.textColor[1]} ${annotation.textColor[2]} rg`,
      ));
      dict.set('Contents', new PDFString(annotation.text));
      if (annotation.borderWidth > 0) {
        dict.set('BS', buildBorderStyle(annotation.borderWidth));
      }
      appearanceStream = buildFreeTextAppearance(annotation);
      break;

    case 'Ink':
      dict.set('Subtype', new PDFName('Ink'));
      const inkLists = new PDFArray(
        annotation.inkPaths.map((path) =>
          new PDFArray(path.map((n) => new PDFNumber(n))),
        ),
      );
      dict.set('InkList', inkLists);
      dict.set('BS', buildBorderStyle(annotation.lineWidth));
      appearanceStream = buildInkAppearance(annotation);
      break;

    case 'Line': {
      dict.set('Subtype', new PDFName('Line'));
      dict.set('L', new PDFArray([
        new PDFNumber(annotation.x1),
        new PDFNumber(annotation.y1),
        new PDFNumber(annotation.x2),
        new PDFNumber(annotation.y2),
      ]));
      dict.set('BS', buildBorderStyle(annotation.lineWidth));
      const startLE = annotation.startStyle ?? 'None';
      const endLE = annotation.endStyle ?? 'None';
      dict.set('LE', new PDFArray([
        new PDFName(startLE),
        new PDFName(endLE),
      ]));
      appearanceStream = buildLineAppearance(annotation);
      break;
    }

    case 'Square':
      dict.set('Subtype', new PDFName('Square'));
      dict.set('BS', buildBorderStyle(annotation.lineWidth));
      if (annotation.fillColor) {
        dict.set('IC', new PDFArray([
          new PDFNumber(annotation.fillColor[0]),
          new PDFNumber(annotation.fillColor[1]),
          new PDFNumber(annotation.fillColor[2]),
        ]));
      }
      appearanceStream = buildSquareAppearance(annotation);
      break;

    case 'Circle':
      dict.set('Subtype', new PDFName('Circle'));
      dict.set('BS', buildBorderStyle(annotation.lineWidth));
      if (annotation.fillColor) {
        dict.set('IC', new PDFArray([
          new PDFNumber(annotation.fillColor[0]),
          new PDFNumber(annotation.fillColor[1]),
          new PDFNumber(annotation.fillColor[2]),
        ]));
      }
      appearanceStream = buildCircleAppearance(annotation);
      break;

    case 'Stamp':
      dict.set('Subtype', new PDFName('Stamp'));
      dict.set('Name', new PDFName(annotation.stampName));
      appearanceStream = buildStampAppearance(annotation);
      break;

    case 'Redact':
      dict.set('Subtype', new PDFName('Redact'));
      dict.set('QuadPoints', new PDFArray(
        annotation.quadPoints.map((n) => new PDFNumber(n)),
      ));
      if (annotation.overlayText) {
        dict.set('OverlayText', new PDFString(annotation.overlayText));
      }
      // Interior color (fill after redaction)
      dict.set('IC', new PDFArray([
        new PDFNumber(0), new PDFNumber(0), new PDFNumber(0),
      ]));
      break;

    case 'Link':
      dict.set('Subtype', new PDFName('Link'));
      dict.set('Border', new PDFArray([
        new PDFNumber(0), new PDFNumber(0), new PDFNumber(0),
      ]));
      if (annotation.url) {
        const action = new PDFDict();
        action.set('S', new PDFName('URI'));
        action.set('URI', new PDFString(annotation.url));
        dict.set('A', action);
      }
      break;
  }

  // Set appearance stream
  if (appearanceStream) {
    const apDict = new PDFDict();
    apDict.set('N', appearanceStream as unknown as PDFObject);
    dict.set('AP', apDict);
  }

  return { dict, appearanceStream };
}

// ─── Appearance stream builders ─────────────────────────────────────────────

function buildHighlightAppearance(annot: HighlightAnnotation): PDFStream {
  const { rect, color, opacity, quadPoints } = annot;
  const lines: string[] = [];

  lines.push(`${color[0]} ${color[1]} ${color[2]} rg`);

  switch (annot.type) {
    case 'Highlight': {
      // Fill each text quad separately (not the union Rect) so highlights
      // stay tight to the glyphs instead of painting a giant opaque bar.
      for (let i = 0; i + 7 < quadPoints.length; i += 8) {
        const tlx = quadPoints[i] - rect.x;
        const tly = quadPoints[i + 1] - rect.y;
        const trx = quadPoints[i + 2] - rect.x;
        const try_ = quadPoints[i + 3] - rect.y;
        const blx = quadPoints[i + 4] - rect.x;
        const bly = quadPoints[i + 5] - rect.y;
        const brx = quadPoints[i + 6] - rect.x;
        const bry = quadPoints[i + 7] - rect.y;
        lines.push(`${tlx} ${tly} m`);
        lines.push(`${trx} ${try_} l`);
        lines.push(`${brx} ${bry} l`);
        lines.push(`${blx} ${bly} l`);
        lines.push('h f');
      }
      break;
    }

    case 'Underline':
      lines.push(`${color[0]} ${color[1]} ${color[2]} RG`);
      lines.push('1 w');
      for (let i = 0; i + 7 < quadPoints.length; i += 8) {
        const blx = quadPoints[i + 4] - rect.x;
        const bly = quadPoints[i + 5] - rect.y;
        const brx = quadPoints[i + 6] - rect.x;
        const bry = quadPoints[i + 7] - rect.y;
        lines.push(`${blx} ${bly} m ${brx} ${bry} l S`);
      }
      break;

    case 'StrikeOut':
      lines.push(`${color[0]} ${color[1]} ${color[2]} RG`);
      lines.push('1 w');
      for (let i = 0; i + 7 < quadPoints.length; i += 8) {
        const midY =
          ((quadPoints[i + 1] + quadPoints[i + 5]) / 2) - rect.y;
        const left = Math.min(quadPoints[i], quadPoints[i + 4]) - rect.x;
        const right = Math.max(quadPoints[i + 2], quadPoints[i + 6]) - rect.x;
        lines.push(`${left} ${midY} m ${right} ${midY} l S`);
      }
      break;

    case 'Squiggly': {
      lines.push(`${color[0]} ${color[1]} ${color[2]} RG`);
      lines.push('0.8 w');
      for (let i = 0; i + 7 < quadPoints.length; i += 8) {
        const left = Math.min(quadPoints[i], quadPoints[i + 4]) - rect.x;
        const right = Math.max(quadPoints[i + 2], quadPoints[i + 6]) - rect.x;
        const base = Math.min(quadPoints[i + 5], quadPoints[i + 7]) - rect.y;
        let path = `${left} ${base + 2} m`;
        const step = 4;
        for (let x = left + step; x <= right; x += step) {
          const y = ((x - left) / step) % 2 === 0 ? base + 2 : base;
          path += ` ${x} ${y} l`;
        }
        lines.push(path);
        lines.push('S');
      }
      break;
    }

    default:
      break;
  }

  return buildAppearanceStream(lines.join('\n'), rect, opacity);
}

function buildFreeTextAppearance(annot: FreeTextAnnotation): PDFStream {
  const { rect, text, fontSize, textColor, color, borderWidth } = annot;
  const w = rect.width;
  const h = rect.height;

  const lines: string[] = [];

  // Background fill
  lines.push(`${color[0]} ${color[1]} ${color[2]} rg`);
  lines.push(`0 0 ${w} ${h} re f`);

  // Border
  if (borderWidth > 0) {
    lines.push(`0 0 0 RG ${borderWidth} w`);
    lines.push(`0 0 ${w} ${h} re S`);
  }

  // Text
  lines.push('BT');
  lines.push(`${textColor[0]} ${textColor[1]} ${textColor[2]} rg`);
  lines.push(`/Helv ${fontSize} Tf`);
  lines.push(`${borderWidth + 2} ${h - fontSize - borderWidth - 2} Td`);
  lines.push(`(${escapeStringForPDF(text)}) Tj`);
  lines.push('ET');

  const content = lines.join('\n');
  const stream = buildAppearanceStream(content, rect, 1);

  // Add Resources with Helvetica font
  const fontDict = new PDFDict();
  const helvetica = new PDFDict();
  helvetica.set('Type', new PDFName('Font'));
  helvetica.set('Subtype', new PDFName('Type1'));
  helvetica.set('BaseFont', new PDFName('Helvetica'));
  fontDict.set('Helv', helvetica);

  const resources = new PDFDict();
  resources.set('Font', fontDict);
  stream.dict.set('Resources', resources);

  return stream;
}

function buildInkAppearance(annot: InkAnnotation): PDFStream {
  const { rect, color, inkPaths, lineWidth } = annot;
  const lines: string[] = [];

  lines.push(`${color[0]} ${color[1]} ${color[2]} RG`);
  lines.push(`${lineWidth} w`);
  lines.push('1 J'); // Round line cap

  for (const path of inkPaths) {
    if (path.length < 4) continue;

    // Offset coordinates relative to appearance stream BBox
    const x0 = path[0] - rect.x;
    const y0 = path[1] - rect.y;
    lines.push(`${x0} ${y0} m`);

    for (let i = 2; i < path.length; i += 2) {
      const x = path[i] - rect.x;
      const y = path[i + 1] - rect.y;
      lines.push(`${x} ${y} l`);
    }
    lines.push('S');
  }

  return buildAppearanceStream(lines.join('\n'), rect, annot.opacity);
}

function arrowHeadPath(
  tipX: number, tipY: number,
  fromX: number, fromY: number,
  size: number,
): string {
  const angle = Math.atan2(tipY - fromY, tipX - fromX);
  const a1 = angle + Math.PI * 0.85;
  const a2 = angle - Math.PI * 0.85;
  const x1 = tipX + Math.cos(a1) * size;
  const y1 = tipY + Math.sin(a1) * size;
  const x2 = tipX + Math.cos(a2) * size;
  const y2 = tipY + Math.sin(a2) * size;
  return `${x1} ${y1} m ${tipX} ${tipY} l ${x2} ${y2} l`;
}

function buildLineAppearance(annot: LineAnnotation): PDFStream {
  const { rect, color, lineWidth, x1, y1, x2, y2 } = annot;
  const lines: string[] = [];
  const ax = x1 - rect.x;
  const ay = y1 - rect.y;
  const bx = x2 - rect.x;
  const by = y2 - rect.y;

  lines.push(`${color[0]} ${color[1]} ${color[2]} RG`);
  lines.push(`${lineWidth} w`);
  lines.push('1 J');
  lines.push(`${ax} ${ay} m ${bx} ${by} l S`);

  const headSize = Math.max(lineWidth * 4, 8);
  const endStyle = annot.endStyle ?? 'None';
  const startStyle = annot.startStyle ?? 'None';
  if (endStyle === 'OpenArrow' || endStyle === 'ClosedArrow') {
    lines.push(arrowHeadPath(bx, by, ax, ay, headSize));
    if (endStyle === 'ClosedArrow') {
      lines.push(`${color[0]} ${color[1]} ${color[2]} rg`);
      lines.push('b');
    } else {
      lines.push('S');
    }
  }
  if (startStyle === 'OpenArrow' || startStyle === 'ClosedArrow') {
    lines.push(arrowHeadPath(ax, ay, bx, by, headSize));
    if (startStyle === 'ClosedArrow') {
      lines.push(`${color[0]} ${color[1]} ${color[2]} rg`);
      lines.push('b');
    } else {
      lines.push('S');
    }
  }

  return buildAppearanceStream(lines.join('\n'), rect, annot.opacity);
}

function buildSquareAppearance(annot: SquareAnnotation): PDFStream {
  const { rect, color, lineWidth, fillColor } = annot;
  const pad = lineWidth;
  const lines: string[] = [];
  lines.push(`${color[0]} ${color[1]} ${color[2]} RG`);
  lines.push(`${lineWidth} w`);
  const w = Math.max(0, rect.width - pad * 2);
  const h = Math.max(0, rect.height - pad * 2);
  lines.push(`${pad} ${pad} ${w} ${h} re`);
  if (fillColor) {
    lines.push(`${fillColor[0]} ${fillColor[1]} ${fillColor[2]} rg`);
    lines.push('B');
  } else {
    lines.push('S');
  }
  return buildAppearanceStream(lines.join('\n'), rect, annot.opacity);
}

function buildCircleAppearance(annot: CircleAnnotation): PDFStream {
  const { rect, color, lineWidth, fillColor } = annot;
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  const rx = Math.max(0, (rect.width - lineWidth) / 2);
  const ry = Math.max(0, (rect.height - lineWidth) / 2);
  // Bézier circle approximation
  const k = 0.5522847498;
  const ox = rx * k;
  const oy = ry * k;
  const lines: string[] = [];
  lines.push(`${color[0]} ${color[1]} ${color[2]} RG`);
  lines.push(`${lineWidth} w`);
  lines.push(`${cx + rx} ${cy} m`);
  lines.push(`${cx + rx} ${cy + oy} ${cx + ox} ${cy + ry} ${cx} ${cy + ry} c`);
  lines.push(`${cx - ox} ${cy + ry} ${cx - rx} ${cy + oy} ${cx - rx} ${cy} c`);
  lines.push(`${cx - rx} ${cy - oy} ${cx - ox} ${cy - ry} ${cx} ${cy - ry} c`);
  lines.push(`${cx + ox} ${cy - ry} ${cx + rx} ${cy - oy} ${cx + rx} ${cy} c`);
  if (fillColor) {
    lines.push(`${fillColor[0]} ${fillColor[1]} ${fillColor[2]} rg`);
    lines.push('B');
  } else {
    lines.push('S');
  }
  return buildAppearanceStream(lines.join('\n'), rect, annot.opacity);
}

function buildStampAppearance(annot: StampAnnotation): PDFStream {
  const { rect, color, stampName } = annot;
  const w = rect.width;
  const h = rect.height;

  const lines: string[] = [];

  // Draw stamp border
  lines.push(`${color[0]} ${color[1]} ${color[2]} RG`);
  lines.push('2 w');
  lines.push(`4 4 ${w - 8} ${h - 8} re S`);

  // Draw stamp text
  lines.push('BT');
  lines.push(`${color[0]} ${color[1]} ${color[2]} rg`);
  const fontSize = Math.min(w / (stampName.length * 0.7), h * 0.5, 24);
  lines.push(`/Helv ${fontSize} Tf`);
  const textX = (w - stampName.length * fontSize * 0.6) / 2;
  const textY = (h - fontSize) / 2;
  lines.push(`${Math.max(4, textX)} ${Math.max(4, textY)} Td`);
  lines.push(`(${escapeStringForPDF(stampName)}) Tj`);
  lines.push('ET');

  const stream = buildAppearanceStream(lines.join('\n'), rect, annot.opacity);

  // Add font resources
  const fontDict = new PDFDict();
  const helvetica = new PDFDict();
  helvetica.set('Type', new PDFName('Font'));
  helvetica.set('Subtype', new PDFName('Type1'));
  helvetica.set('BaseFont', new PDFName('Helvetica'));
  fontDict.set('Helv', helvetica);
  const resources = new PDFDict();
  resources.set('Font', fontDict);
  stream.dict.set('Resources', resources);

  return stream;
}

// ─── Appearance stream helper ───────────────────────────────────────────────

function buildAppearanceStream(
  content: string,
  rect: PDFRectangle,
  _opacity: number,
): PDFStream {
  // Opacity is stored on the annotation dict as /CA and applied by the
  // renderer (and by Acrobat). Baking it into the appearance stream as well
  // would double-dim translucent highlights.
  const bytes = new Uint8Array(content.length);
  for (let i = 0; i < content.length; i++) {
    bytes[i] = content.charCodeAt(i) & 0xff;
  }

  const dict = new PDFDict();
  dict.set('Type', new PDFName('XObject'));
  dict.set('Subtype', new PDFName('Form'));
  dict.set('BBox', new PDFArray([
    new PDFNumber(0),
    new PDFNumber(0),
    new PDFNumber(rect.width),
    new PDFNumber(rect.height),
  ]));
  // Do NOT set an identity Matrix — viewers (and our renderer) map BBox → Rect.
  // An identity Matrix previously caused highlights to render at the page origin.
  dict.set('Length', new PDFNumber(bytes.length));

  return new PDFStream(dict, bytes, bytes);
}

// ─── Annotation management ──────────────────────────────────────────────────

/**
 * Add an annotation to a page's /Annots array.
 */
export function addAnnotationToPage(
  pageDict: PDFDict,
  annotDict: PDFDict,
  annotRef: PDFRef,
  objects: Map<string, PDFObject>,
): void {
  const annots = pageDict.get('Annots');

  if (!annots) {
    // Create new Annots array
    pageDict.set('Annots', new PDFArray([annotRef]));
  } else if (annots instanceof PDFArray) {
    annots.push(annotRef);
  } else if (annots instanceof PDFRef) {
    // Resolve and add
    const resolved = objects.get(annots.toKey());
    if (resolved instanceof PDFArray) {
      resolved.push(annotRef);
    }
  }

  // Store the annotation object
  objects.set(annotRef.toKey(), annotDict);

  // Streams must be indirect objects (ISO 32000-2 §7.3.8). An inline /AP /N
  // stream is lost when the file is reopened, which made Bloom's own strokes
  // and highlights disappear; store it as its own object.
  const ap = annotDict.get('AP');
  if (ap instanceof PDFDict) {
    for (const key of ['N', 'R', 'D']) {
      const stream = ap.get(key);
      if (!(stream instanceof PDFStream)) continue;
      let max = 0;
      for (const k of objects.keys()) max = Math.max(max, parseInt(k.split('_')[0], 10) || 0);
      const ref = new PDFRef(max + 1, 0);
      objects.set(ref.toKey(), stream);
      ap.set(key, ref);
    }
  }
}

/**
 * Remove an annotation from a page by its reference.
 */
export function removeAnnotationFromPage(
  pageDict: PDFDict,
  annotRef: PDFRef,
  objects: Map<string, PDFObject>,
): void {
  const annots = pageDict.get('Annots');
  if (!annots) return;

  if (annots instanceof PDFArray) {
    const newItems = annots.items.filter((item) => {
      if (item instanceof PDFRef) return !item.equals(annotRef);
      return true;
    });
    pageDict.set('Annots', new PDFArray(newItems));
  }

  objects.delete(annotRef.toKey());
}

/** Point-in-axis-aligned rect test (PDF user space). */
function pointInRect(
  x: number, y: number,
  rx: number, ry: number, rw: number, rh: number,
  pad = 0,
): boolean {
  return x >= rx - pad && x <= rx + rw + pad && y >= ry - pad && y <= ry + rh + pad;
}

/** Distance from point to segment. */
function distToSegment(
  px: number, py: number,
  x1: number, y1: number, x2: number, y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-8) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/**
 * Erase Highlight / Ink annotations whose geometry is near (pdfX, pdfY).
 * Returns how many annotations were removed.
 */
export function eraseAnnotationsAtPoint(
  pageDict: PDFDict,
  objects: Map<string, PDFObject>,
  pdfX: number,
  pdfY: number,
  radius: number,
): number {
  const annots = pageDict.get('Annots');
  let arr: PDFArray | null = null;
  if (annots instanceof PDFArray) arr = annots;
  else if (annots instanceof PDFRef) {
    const resolved = objects.get(annots.toKey());
    if (resolved instanceof PDFArray) arr = resolved;
  }
  if (!arr) return 0;

  const toRemove: PDFRef[] = [];

  for (const item of arr.items) {
    if (!(item instanceof PDFRef)) continue;
    const dict = objects.get(item.toKey());
    if (!(dict instanceof PDFDict)) continue;

    const subtype = dict.get('Subtype');
    const name = subtype instanceof PDFName ? subtype.name : '';
    const markupTypes = new Set([
      'Highlight', 'Ink', 'Underline', 'StrikeOut', 'Squiggly',
      'Line', 'Square', 'Circle', 'PolyLine', 'Polygon',
    ]);
    if (!markupTypes.has(name)) {
      continue;
    }

    const rectObj = dict.get('Rect');
    if (!(rectObj instanceof PDFArray) || rectObj.items.length < 4) continue;
    const x0 = (rectObj.items[0] as PDFNumber).value;
    const y0 = (rectObj.items[1] as PDFNumber).value;
    const x1 = (rectObj.items[2] as PDFNumber).value;
    const y1 = (rectObj.items[3] as PDFNumber).value;
    const rx = Math.min(x0, x1);
    const ry = Math.min(y0, y1);
    const rw = Math.abs(x1 - x0);
    const rh = Math.abs(y1 - y0);

    let hit = false;

    if (name === 'Ink') {
      const inkList = dict.get('InkList');
      if (inkList instanceof PDFArray) {
        for (const pathObj of inkList.items) {
          if (!(pathObj instanceof PDFArray)) continue;
          const pts: number[] = [];
          for (const n of pathObj.items) {
            if (n instanceof PDFNumber) pts.push(n.value);
          }
          for (let i = 0; i + 3 < pts.length; i += 2) {
            if (distToSegment(pdfX, pdfY, pts[i], pts[i + 1], pts[i + 2], pts[i + 3]) <= radius) {
              hit = true;
              break;
            }
          }
          if (hit) break;
        }
      }
      if (!hit) hit = pointInRect(pdfX, pdfY, rx, ry, rw, rh, radius);
    } else if (name === 'Line') {
      const L = dict.get('L');
      if (L instanceof PDFArray && L.items.length >= 4) {
        const lx1 = (L.items[0] as PDFNumber).value;
        const ly1 = (L.items[1] as PDFNumber).value;
        const lx2 = (L.items[2] as PDFNumber).value;
        const ly2 = (L.items[3] as PDFNumber).value;
        hit = distToSegment(pdfX, pdfY, lx1, ly1, lx2, ly2) <= radius;
      } else {
        hit = pointInRect(pdfX, pdfY, rx, ry, rw, rh, radius);
      }
    } else if (name === 'Square' || name === 'Circle') {
      // Hit near border or inside
      hit = pointInRect(pdfX, pdfY, rx, ry, rw, rh, radius);
    } else {
      // Highlight / markup: prefer QuadPoints, fall back to Rect
      const qp = dict.get('QuadPoints');
      if (qp instanceof PDFArray && qp.items.length >= 8) {
        for (let i = 0; i + 7 < qp.items.length; i += 8) {
          const xs = [
            (qp.items[i] as PDFNumber).value,
            (qp.items[i + 2] as PDFNumber).value,
            (qp.items[i + 4] as PDFNumber).value,
            (qp.items[i + 6] as PDFNumber).value,
          ];
          const ys = [
            (qp.items[i + 1] as PDFNumber).value,
            (qp.items[i + 3] as PDFNumber).value,
            (qp.items[i + 5] as PDFNumber).value,
            (qp.items[i + 7] as PDFNumber).value,
          ];
          const qMinX = Math.min(...xs);
          const qMaxX = Math.max(...xs);
          const qMinY = Math.min(...ys);
          const qMaxY = Math.max(...ys);
          if (pointInRect(pdfX, pdfY, qMinX, qMinY, qMaxX - qMinX, qMaxY - qMinY, radius * 0.5)) {
            hit = true;
            break;
          }
        }
      } else {
        hit = pointInRect(pdfX, pdfY, rx, ry, rw, rh, radius);
      }
    }

    if (hit) toRemove.push(item);
  }

  for (const ref of toRemove) {
    removeAnnotationFromPage(pageDict, ref, objects);
  }
  return toRemove.length;
}

/**
 * Remove all Highlight / Ink / markup annotations from a page.
 * Used by the toolbar Clear action.
 */
export function clearMarkupAnnotationsOnPage(
  pageDict: PDFDict,
  objects: Map<string, PDFObject>,
): number {
  const annots = pageDict.get('Annots');
  let arr: PDFArray | null = null;
  if (annots instanceof PDFArray) arr = annots;
  else if (annots instanceof PDFRef) {
    const resolved = objects.get(annots.toKey());
    if (resolved instanceof PDFArray) arr = resolved;
  }
  if (!arr) return 0;

  const markup = new Set([
    'Highlight', 'Ink', 'Underline', 'StrikeOut', 'Squiggly',
    'Line', 'Square', 'Circle', 'PolyLine', 'Polygon',
  ]);
  const toRemove: PDFRef[] = [];
  for (const item of arr.items) {
    if (!(item instanceof PDFRef)) continue;
    const dict = objects.get(item.toKey());
    if (!(dict instanceof PDFDict)) continue;
    const subtype = dict.get('Subtype');
    const name = subtype instanceof PDFName ? subtype.name : '';
    if (markup.has(name)) toRemove.push(item);
  }
  for (const ref of toRemove) {
    removeAnnotationFromPage(pageDict, ref, objects);
  }
  return toRemove.length;
}

// ─── Utility helpers ────────────────────────────────────────────────────────

function rectToArray(rect: PDFRectangle): PDFArray {
  return new PDFArray([
    new PDFNumber(rect.x),
    new PDFNumber(rect.y),
    new PDFNumber(rect.x + rect.width),
    new PDFNumber(rect.y + rect.height),
  ]);
}

function buildBorderStyle(width: number): PDFDict {
  const bs = new PDFDict();
  bs.set('W', new PDFNumber(width));
  bs.set('S', new PDFName('S')); // Solid
  return bs;
}

function escapeStringForPDF(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

/**
 * Get the current date as a PDF date string.
 */
export function pdfDateString(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `D:${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
