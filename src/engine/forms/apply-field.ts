/**
 * Apply and flatten AcroForm field values on document pages.
 */

import { getPageContentBytes, resolveRef } from '../parser/parser';
import { updatePageContent, concatBytes, isolateGraphicsState } from '../editor/stream-compiler';
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFDocumentData,
} from '../types';
import type { AcroFormWidget } from './types';
import { DEFAULT_FLATTEN_OPTIONS } from './types';
import { flattenWidgets } from './flatten-field';
import { getNextObjNum } from '../writer/serializer';
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
    if (widget.fieldType === 'Ch') {
      // /I (selected option indices) wins over /V in some viewers; keep it in step.
      const index = widget.options.indexOf(value);
      if (index >= 0) field.set('I', new PDFArray([new PDFNumber(index)]));
      else field.delete('I');
    }
    const rasterized = regenerateTextAppearance(doc, widget, value);
    if (rasterized) {
      // The new appearance draws text Helvetica can't encode. Viewers that
      // honour NeedAppearances would rebuild it from /DA and show mojibake.
      let acro = doc.catalog.get('AcroForm');
      if (acro instanceof PDFRef) acro = resolveRef(acro, doc.objects);
      if (acro instanceof PDFDict) acro.delete('NeedAppearances');
    }
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

const fmtNum = (n: number) => (Math.abs(n) < 1e-9 ? '0' : Number(n.toFixed(4)).toString());

/** Annotation flags Hidden (2) or NoView (6): the widget never shows. */
function isHiddenWidget(dict: PDFDict): boolean {
  const f = dict.get('F');
  return f instanceof PDFNumber && (f.value & ((1 << 1) | (1 << 5))) !== 0;
}

/**
 * The widget's normal appearance stream for its current /AS state, as an
 * indirect reference (a direct stream is moved into its own object).
 */
function normalAppearanceRef(dict: PDFDict, objects: Map<string, PDFObject>): PDFRef | null {
  const ap = resolveRef(dict.get('AP') as PDFObject, objects);
  if (!(ap instanceof PDFDict)) return null;
  let n: PDFObject | undefined = ap.get('N');
  const resolvedN = resolveRef(n as PDFObject, objects);
  if (resolvedN instanceof PDFDict) {
    // On/off states: pick the one /AS names.
    const as = dict.get('AS');
    if (!(as instanceof PDFName)) return null;
    n = resolvedN.get(as.name);
  }
  if (n instanceof PDFRef) return objects.get(n.toKey()) instanceof PDFStream ? n : null;
  if (n instanceof PDFStream) {
    const ref = new PDFRef(getNextObjNum({ objects } as PDFDocumentData), 0);
    objects.set(ref.toKey(), n);
    return ref;
  }
  return null;
}

/**
 * Matrix that maps a form XObject's (Matrix-transformed) BBox onto the widget
 * rectangle — ISO 32000-2 §12.5.5, Algorithm "appearance streams".
 */
function appearanceToRectMatrix(dict: PDFDict, rect: { x: number; y: number; width: number; height: number }): number[] {
  const nums = (key: string, n: number): number[] | null => {
    const v = dict.get(key);
    if (!(v instanceof PDFArray) || v.length < n) return null;
    const out = v.items.slice(0, n).map((x) => (x instanceof PDFNumber ? x.value : NaN));
    return out.some((x) => !Number.isFinite(x)) ? null : out;
  };
  const [bx0, by0, bx1, by1] = nums('BBox', 4) ?? [0, 0, rect.width, rect.height];
  const [a, b, c, d, e, f] = nums('Matrix', 6) ?? [1, 0, 0, 1, 0, 0];
  const pts = [[bx0, by0], [bx1, by0], [bx0, by1], [bx1, by1]].map(([x, y]) => [a * x + c * y + e, b * x + d * y + f]);
  const minX = Math.min(...pts.map((p) => p[0]));
  const minY = Math.min(...pts.map((p) => p[1]));
  const w = Math.max(...pts.map((p) => p[0])) - minX;
  const h = Math.max(...pts.map((p) => p[1])) - minY;
  const sx = w > 0 ? rect.width / w : 1;
  const sy = h > 0 ? rect.height / h : 1;
  return [sx, 0, 0, sy, rect.x - minX * sx, rect.y - minY * sy];
}

/** The page's own /Resources dictionary (copied down from an inherited one). */
function pageResources(page: PDFDocumentData['pages'][0], objects: Map<string, PDFObject>): PDFDict {
  let res = resolveRef(page.dict.get('Resources') as PDFObject, objects);
  if (!(res instanceof PDFDict)) {
    res = new PDFDict();
    if (page.resources instanceof PDFDict) {
      for (const [k, v] of page.resources.entries()) (res as PDFDict).set(k, v);
    }
    page.dict.set('Resources', res);
  }
  page.resources = res as PDFDict;
  return res as PDFDict;
}

function resourceSubDict(res: PDFDict, key: string, objects: Map<string, PDFObject>): PDFDict {
  let sub = resolveRef(res.get(key) as PDFObject, objects);
  if (!(sub instanceof PDFDict)) {
    sub = new PDFDict();
    res.set(key, sub);
  }
  return sub as PDFDict;
}

function addPageXObject(page: PDFDocumentData['pages'][0], objects: Map<string, PDFObject>, ref: PDFRef): string {
  const xobjects = resourceSubDict(pageResources(page, objects), 'XObject', objects);
  let i = 1;
  while (xobjects.has(`FlatAP${i}`)) i++;
  xobjects.set(`FlatAP${i}`, ref);
  return `FlatAP${i}`;
}

function ensurePageFont(page: PDFDocumentData['pages'][0], objects: Map<string, PDFObject>, name: string): void {
  const fonts = resourceSubDict(pageResources(page, objects), 'Font', objects);
  if (fonts.has(name)) return;
  const font = new PDFDict();
  font.set('Type', new PDFName('Font'));
  font.set('Subtype', new PDFName('Type1'));
  font.set('BaseFont', new PDFName('Helvetica'));
  font.set('Encoding', new PDFName('WinAnsiEncoding'));
  fonts.set(name, font);
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
  // Bake each widget's own normal appearance (what every viewer shows) into
  // the page. Only widgets without one get a synthesized appearance.
  const parts: string[] = [];
  const synthesized: AcroFormWidget[] = [];
  const removedRefs: PDFRef[] = [];
  for (const widget of widgets) {
    removedRefs.push(widget.ref);
    if (isHiddenWidget(widget.dict)) continue;
    const ap = normalAppearanceRef(widget.dict, doc.objects);
    if (!ap) {
      synthesized.push(widget);
      continue;
    }
    const stream = doc.objects.get(ap.toKey()) as PDFStream;
    stream.dict.set('Type', new PDFName('XObject'));
    stream.dict.set('Subtype', new PDFName('Form'));
    const name = addPageXObject(page, doc.objects, ap);
    const m = appearanceToRectMatrix(stream.dict, widget.rect);
    parts.push(`q ${m.map(fmtNum).join(' ')} cm /${name} Do Q`);
  }
  if (synthesized.length > 0) {
    ensurePageFont(page, doc.objects, DEFAULT_FLATTEN_OPTIONS.fontResourceName);
    parts.push(flattenWidgets(synthesized).content);
  }
  const existing = getPageContentBytes(page, doc.objects);
  const merged = concatBytes(isolateGraphicsState(existing), stringToBytes(`\n${parts.join('\n')}\n`));
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
