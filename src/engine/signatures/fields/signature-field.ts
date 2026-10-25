/**
 * PDF Signature Field model — AcroForm /FT Sig widgets.
 * Phase 4: parse, lookup, create, place into existing fields.
 */

import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
  type PDFDocumentData,
  type PDFRectangle,
} from '../../types';
import { resolveRef } from '../../parser/parser';
import {
  detectFormFieldsOnPage,
  listAllFormWidgets,
  hitTestFormField,
  parseAcroFormCatalog,
} from '../../forms/detect-fields';
import type { AcroFormWidget } from '../../forms/types';
import { createSignatureField } from '../crypto/sign';
import {
  applySignatureFieldAppearance,
  type SignatureFieldAppearanceOptions,
} from './appearance-stream';

/** Logical signature field on a PDF page. */
export interface SignatureField {
  /** Object key (ref.toKey()). */
  id: string;
  ref: PDFRef;
  pageIndex: number;
  rect: PDFRectangle;
  fieldName: string;
  /** True when /V points at a Sig dictionary. */
  signed: boolean;
  /** Reference to signature value dictionary, if any. */
  valueRef: PDFRef | null;
  readOnly: boolean;
  required: boolean;
  /** Whether /AP /N is present. */
  hasAppearance: boolean;
  /** Underlying AcroForm widget. */
  widget: AcroFormWidget;
}

export interface CreateSignatureFieldOptions {
  fieldName?: string;
  /** Width/height in PDF units when creating from a click point. */
  width?: number;
  height?: number;
  /** Attach an empty placeholder /AP (Phase 5). */
  withPlaceholderAppearance?: boolean;
}

/** Resolve page index for a widget using /P or Annots membership. */
export function pageIndexForWidget(
  doc: PDFDocumentData,
  widget: AcroFormWidget,
): number {
  if (widget.pageRef) {
    const idx = doc.pages.findIndex((p) => p.ref.toKey() === widget.pageRef!.toKey());
    if (idx >= 0) return idx;
  }
  for (let i = 0; i < doc.pages.length; i++) {
    const fields = detectFormFieldsOnPage(doc, i);
    if (fields.some((f) => f.ref.toKey() === widget.ref.toKey())) return i;
  }
  return 0;
}

function widgetHasAppearance(
  dict: PDFDict,
  objects: Map<string, import('../../types').PDFObject>,
): boolean {
  const ap = dict.get('AP');
  if (!ap) return false;
  const apDict = ap instanceof PDFRef ? resolveRef(ap, objects) : ap;
  if (!(apDict instanceof PDFDict)) return false;
  return apDict.has('N');
}

function widgetValueRef(
  dict: PDFDict,
  objects: Map<string, import('../../types').PDFObject>,
): PDFRef | null {
  const v = dict.get('V');
  if (v instanceof PDFRef) {
    const target = resolveRef(v, objects);
    if (target instanceof PDFDict) {
      const type = target.get('Type');
      if (type instanceof PDFName && type.name === 'Sig') return v;
      if (target.has('Contents') || target.has('ByteRange') || target.has('Filter')) return v;
    }
    return v;
  }
  return null;
}

/** Convert an AcroForm Sig widget into a SignatureField. */
export function widgetToSignatureField(
  doc: PDFDocumentData,
  widget: AcroFormWidget,
  pageIndex?: number,
): SignatureField | null {
  if (widget.fieldType !== 'Sig') return null;
  const valueRef = widgetValueRef(widget.dict, doc.objects);
  return {
    id: widget.ref.toKey(),
    ref: widget.ref,
    pageIndex: pageIndex ?? pageIndexForWidget(doc, widget),
    rect: widget.rect,
    fieldName: widget.fieldName || 'Signature',
    signed: valueRef != null,
    valueRef,
    readOnly: widget.readOnly,
    required: widget.required,
    hasAppearance: widgetHasAppearance(widget.dict, doc.objects),
    widget,
  };
}

/** List all signature fields in the document. */
export function listSignatureFields(doc: PDFDocumentData): SignatureField[] {
  const widgets = listAllFormWidgets(doc).filter((w) => w.fieldType === 'Sig');
  const out: SignatureField[] = [];
  for (const w of widgets) {
    const field = widgetToSignatureField(doc, w);
    if (field) out.push(field);
  }
  return out;
}

/** Signature fields on a specific page. */
export function detectSignatureFieldsOnPage(
  doc: PDFDocumentData,
  pageIndex: number,
): SignatureField[] {
  return detectFormFieldsOnPage(doc, pageIndex)
    .filter((w) => w.fieldType === 'Sig')
    .map((w) => widgetToSignatureField(doc, w, pageIndex))
    .filter((f): f is SignatureField => f != null);
}

/** Hit-test signature fields (Sig only). */
export function hitTestSignatureField(
  fields: SignatureField[],
  pdfX: number,
  pdfY: number,
): SignatureField | null {
  for (let i = fields.length - 1; i >= 0; i--) {
    const f = fields[i];
    const r = f.rect;
    if (
      pdfX >= r.x &&
      pdfX <= r.x + r.width &&
      pdfY >= r.y &&
      pdfY <= r.y + r.height
    ) {
      return f;
    }
  }
  return null;
}

/** Look up a signature field by full or partial name. */
export function lookupSignatureFieldByName(
  doc: PDFDocumentData,
  name: string,
): SignatureField | null {
  const needle = name.trim().toLowerCase();
  if (!needle) return null;
  const all = listSignatureFields(doc);
  return (
    all.find((f) => f.fieldName.toLowerCase() === needle) ??
    all.find((f) => f.fieldName.toLowerCase().endsWith(`.${needle}`)) ??
    all.find((f) => f.fieldName.toLowerCase().includes(needle)) ??
    null
  );
}

/** Look up by object reference. */
export function lookupSignatureFieldByRef(
  doc: PDFDocumentData,
  ref: PDFRef,
): SignatureField | null {
  const key = ref.toKey();
  return listSignatureFields(doc).find((f) => f.id === key) ?? null;
}

/**
 * Create a new signature field centered at (x, y) on a page.
 * Registers with /AcroForm and optionally attaches a placeholder /AP.
 */
export function createSignatureFieldAtPoint(
  doc: PDFDocumentData,
  pageIndex: number,
  x: number,
  y: number,
  options: CreateSignatureFieldOptions = {},
): SignatureField {
  const width = options.width ?? 160;
  const height = options.height ?? 60;
  const rect: PDFRectangle = {
    x: x - width / 2,
    y: y - height / 2,
    width,
    height,
  };

  const existing = listSignatureFields(doc);
  const fieldName = options.fieldName ?? `Signature${existing.length + 1}`;

  const ref = createSignatureField(doc, pageIndex, rect, fieldName);

  if (options.withPlaceholderAppearance !== false) {
    applySignatureFieldAppearance(doc, ref, {
      width,
      height,
      typedName: fieldName,
      showPlaceholder: true,
    });
  }

  const fields = detectSignatureFieldsOnPage(doc, pageIndex);
  const created = fields.find((f) => f.ref.toKey() === ref.toKey());
  if (created) return created;

  const dict = doc.objects.get(ref.toKey());
  const widget: AcroFormWidget = {
    ref,
    dict: dict instanceof PDFDict ? dict : new PDFDict(),
    rect,
    pageRef: doc.pages[pageIndex]?.ref ?? null,
    fieldName,
    fieldType: 'Sig',
    value: null,
    defaultAppearance: '',
    borderWidth: 1,
    backgroundColor: [0.95, 0.95, 0.97],
    borderColor: [0.2, 0.2, 0.3],
    readOnly: false,
    required: false,
    buttonFlags: 0,
    choiceFlags: 0,
    exportValue: null,
    appearanceState: null,
    onState: null,
    options: [],
    multiline: false,
  };
  return widgetToSignatureField(doc, widget, pageIndex)!;
}

/**
 * Place a visual signature appearance into an existing signature field.
 * Writes /AP /N (Phase 5). Does not perform cryptographic signing.
 */
export function placeSignatureInField(
  doc: PDFDocumentData,
  fieldRef: PDFRef,
  options: SignatureFieldAppearanceOptions,
): SignatureField {
  applySignatureFieldAppearance(doc, fieldRef, options);
  const field = lookupSignatureFieldByRef(doc, fieldRef);
  if (!field) {
    throw new Error('Signature field not found after placing appearance');
  }
  return field;
}

/**
 * Hit-test any AcroForm widget, then narrow to Sig if present.
 */
export function hitTestAnyFormOrSignatureField(
  doc: PDFDocumentData,
  pageIndex: number,
  pdfX: number,
  pdfY: number,
): { kind: 'sig'; field: SignatureField } | { kind: 'form'; widget: AcroFormWidget } | null {
  const widgets = detectFormFieldsOnPage(doc, pageIndex);
  const hit = hitTestFormField(widgets, pdfX, pdfY);
  if (!hit) return null;
  if (hit.fieldType === 'Sig') {
    const field = widgetToSignatureField(doc, hit, pageIndex);
    if (field) return { kind: 'sig', field };
  }
  return { kind: 'form', widget: hit };
}

/** Ensure document has AcroForm catalog (for parsers that expect it). */
export function ensureAcroFormCatalog(doc: PDFDocumentData): PDFDict {
  const existing = parseAcroFormCatalog(doc);
  if (existing) return existing.dict;

  const acroDict = new PDFDict();
  acroDict.set('Fields', new PDFArray([]));
  acroDict.set('SigFlags', new PDFNumber(3));
  const fontDict = new PDFDict();
  const helv = new PDFDict();
  helv.set('Type', new PDFName('Font'));
  helv.set('Subtype', new PDFName('Type1'));
  helv.set('BaseFont', new PDFName('Helvetica'));
  fontDict.set('Helv', helv);
  const dr = new PDFDict();
  dr.set('Font', fontDict);
  acroDict.set('DR', dr);
  acroDict.set('DA', new PDFString('/Helv 0 Tf 0 g'));

  doc.catalog.set('AcroForm', acroDict);
  return acroDict;
}
