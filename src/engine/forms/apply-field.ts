/**
 * Apply and flatten AcroForm field values on document pages.
 */

import { getPageContentBytes, resolveRef } from '../parser/parser';
import { updatePageContent, concatBytes } from '../editor/stream-compiler';
import {
  PDFArray,
  PDFBoolean,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFString,
  type PDFDocumentData,
} from '../types';
import type { AcroFormWidget } from './types';
import { flattenWidgets } from './flatten-field';
import { onStateName } from './detect-fields';
import { regenerateTextAppearance } from './text-appearance';

function stringToBytes(str: string): Uint8Array {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
  return bytes;
}

/**
 * The terminal field dictionary that owns a widget's /V. When the widget and
 * field are split (a /Kids widget without /T, as pdf-lib and Acrobat write
 * them), the value belongs on the /Parent field, not on the widget.
 */
export function fieldDictForWidget(widget: AcroFormWidget, objects: Map<string, PDFObject>): PDFDict {
  const dict = widget.dict;
  if (dict.has('T')) return dict;
  const parent = resolveRef(dict.get('Parent') as PDFObject, objects);
  return parent instanceof PDFDict ? parent : dict;
}

/**
 * Encode a PDF text string: printable ASCII stays a literal string; anything
 * else (newlines, curly quotes, accents, non-Latin scripts) becomes UTF-16BE
 * with a byte-order mark, which every conforming reader decodes.
 */
export function encodeTextString(value: string): PDFString | PDFHexString {
  if (/^[\x20-\x7e]*$/.test(value) && !/[()\\]/.test(value)) return new PDFString(value);
  let hex = 'FEFF';
  for (let i = 0; i < value.length; i++) hex += value.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return new PDFHexString(hex);
}

/** Widget dictionaries that belong to the same terminal field (radio group siblings). */
function siblingWidgets(field: PDFDict, objects: Map<string, PDFObject>): PDFDict[] {
  const kids = resolveRef(field.get('Kids') as PDFObject, objects);
  if (!(kids instanceof PDFArray)) return [field];
  const out: PDFDict[] = [];
  for (const kid of kids.items) {
    const dict = resolveRef(kid, objects);
    if (dict instanceof PDFDict) out.push(dict);
  }
  return out;
}

/**
 * Make sure /AcroForm /DR defines the fonts that /DA strings name by
 * convention (Helv, ZaDb), so viewers that rebuild appearances don't warn
 * about unknown fonts.
 */
function ensureDefaultResources(doc: PDFDocumentData): void {
  let acro = doc.catalog.get('AcroForm');
  if (acro instanceof PDFRef) acro = resolveRef(acro, doc.objects);
  if (!(acro instanceof PDFDict)) return;
  let dr = resolveRef(acro.get('DR') as PDFObject, doc.objects);
  if (!(dr instanceof PDFDict)) {
    dr = new PDFDict();
    acro.set('DR', dr);
  }
  let fonts = resolveRef((dr as PDFDict).get('Font') as PDFObject, doc.objects);
  if (!(fonts instanceof PDFDict)) {
    fonts = new PDFDict();
    (dr as PDFDict).set('Font', fonts);
  }
  const add = (key: string, base: string, encoding?: string) => {
    if ((fonts as PDFDict).has(key)) return;
    const font = new PDFDict();
    font.set('Type', new PDFName('Font'));
    font.set('Subtype', new PDFName('Type1'));
    font.set('BaseFont', new PDFName(base));
    if (encoding) font.set('Encoding', new PDFName(encoding));
    (fonts as PDFDict).set(key, font);
  };
  add('Helv', 'Helvetica', 'WinAnsiEncoding');
  add('ZaDb', 'ZapfDingbats');
}

/** Set a field's /V value in the object graph. */
export function setFormFieldValue(
  doc: PDFDocumentData,
  widget: AcroFormWidget,
  value: string | boolean,
): void {
  const dict = widget.dict;
  const field = fieldDictForWidget(widget, doc.objects);
  if (widget.readOnly) return;
  ensureDefaultResources(doc);
  if (typeof value === 'boolean') {
    const onName = onStateName(dict, doc.objects) ?? widget.onState ?? 'Yes';
    const ff = field.get('Ff') instanceof PDFNumber ? (field.get('Ff') as PDFNumber).value : widget.buttonFlags;
    const isRadio = (ff & (1 << 15)) !== 0;
    field.set('V', new PDFName(value ? onName : 'Off'));
    if (field !== dict || isRadio) {
      // Radio buttons (and check boxes with several widgets) share one value:
      // only widgets whose on-state matches it are shown as on.
      for (const sibling of siblingWidgets(field, doc.objects)) {
        const siblingOn = onStateName(sibling, doc.objects);
        sibling.set('AS', new PDFName(value && siblingOn === onName ? onName : 'Off'));
      }
    }
    dict.set('AS', new PDFName(value ? onName : 'Off'));
  } else {
    field.set('V', encodeTextString(value));
    regenerateTextAppearance(doc, widget, value);
    // The widget's stored appearance still shows the old text; ask viewers to rebuild it.
    let acro = doc.catalog.get('AcroForm');
    if (acro instanceof PDFRef) acro = resolveRef(acro, doc.objects);
    if (acro instanceof PDFDict) acro.set('NeedAppearances', new PDFBoolean(true));
  }
  if (field !== dict) dict.delete('V');
  widget.value = value;
}

/** Remove widget annotation refs from a page /Annots array. */
export function removeWidgetAnnots(
  pageDict: PDFDict,
  removedRefs: PDFRef[],
  objects: Map<string, PDFObject>,
): void {
  const annotsRef = pageDict.get('Annots');
  if (!annotsRef) return;

  const annots = annotsRef instanceof PDFRef ? resolveRef(annotsRef, objects) : annotsRef;
  if (!(annots instanceof PDFArray)) return;

  const removeKeys = new Set(removedRefs.map(r => r.toKey()));
  const kept: PDFObject[] = [];
  for (let i = 0; i < annots.length; i++) {
    const ref = annots.get(i);
    if (ref instanceof PDFRef && removeKeys.has(ref.toKey())) continue;
    kept.push(ref!);
  }

  if (kept.length === 0) {
    pageDict.delete('Annots');
  } else {
    pageDict.set('Annots', new PDFArray(kept));
  }
}

/**
 * Flatten widgets on a page: bake appearances into content stream,
 * remove widget annotations.
 */
export async function flattenFormFieldsOnPage(
  doc: PDFDocumentData,
  pageIndex: number,
  widgets: AcroFormWidget[],
): Promise<void> {
  if (widgets.length === 0) return;

  const page = doc.pages[pageIndex];
  const { content, removedRefs } = flattenWidgets(widgets);
  const existing = getPageContentBytes(page, doc.objects);
  const merged = concatBytes(existing, stringToBytes(`\n${content}`));
  await updatePageContent(page.contentRefs, merged, doc.objects);
  removeWidgetAnnots(page.dict, removedRefs, doc.objects);
  removeFieldsForWidgets(doc, removedRefs);
}

/**
 * Drop flattened widgets from the AcroForm field tree, and any field left with
 * no widgets, so the form no longer lists them.
 */
function removeFieldsForWidgets(doc: PDFDocumentData, removedRefs: PDFRef[]): void {
  let acro = doc.catalog.get('AcroForm');
  if (acro instanceof PDFRef) acro = resolveRef(acro, doc.objects);
  if (!(acro instanceof PDFDict)) return;
  const removed = new Set(removedRefs.map((r) => r.toKey()));

  const prune = (arr: PDFArray): PDFObject[] => {
    const kept: PDFObject[] = [];
    for (const item of arr.items) {
      if (item instanceof PDFRef && removed.has(item.toKey())) continue;
      const dict = resolveRef(item, doc.objects);
      const kids = dict instanceof PDFDict ? resolveRef(dict.get('Kids') as PDFObject, doc.objects) : null;
      if (dict instanceof PDFDict && kids instanceof PDFArray && kids.length > 0) {
        const left = prune(kids);
        if (left.length === 0) continue;
        dict.set('Kids', new PDFArray(left));
      }
      kept.push(item);
    }
    return kept;
  };

  const fields = resolveRef(acro.get('Fields') as PDFObject, doc.objects);
  if (fields instanceof PDFArray) acro.set('Fields', new PDFArray(prune(fields)));
}
