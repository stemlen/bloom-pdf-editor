/**
 * AcroForm field detection — parse catalog /AcroForm and match widgets to pages.
 * ISO 32000-2 §12.7.
 */

import {
  PDFArray,
  PDFBoolean,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFString,
  PDFHexString,
  type PDFDocumentData,
  type PDFPageInfo,
  type PDFRectangle,
} from '../types';
import { resolveRef } from '../parser/parser';
import type {
  AcroFormCatalog,
  AcroFormField,
  AcroFormFieldType,
  AcroFormWidget,
} from './types';
import { parseWidgetRect } from './flatten-field';

/** PDF text strings are UTF-16BE (BOM FE FF), UTF-8 (BOM EF BB BF) or PDFDocEncoding. */
function decodeTextString(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let s = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return s;
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder().decode(bytes.subarray(3));
  }
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function strVal(obj: PDFObject | undefined): string {
  if (obj instanceof PDFName) return obj.name;
  // pdf-lib and many other writers store field names/values as hex or UTF-16 strings.
  if (obj instanceof PDFString) return decodeTextString(obj.toBytes());
  if (obj instanceof PDFHexString) return decodeTextString(obj.toBytes());
  if (obj instanceof PDFNumber) return String(obj.value);
  return '';
}

function intVal(obj: PDFObject | undefined, fallback = 0): number {
  return obj instanceof PDFNumber ? obj.value : fallback;
}

function fieldTypeFromFT(ft: PDFObject | undefined): AcroFormFieldType {
  const name = ft instanceof PDFName ? ft.name : '';
  if (name === 'Tx' || name === 'Btn' || name === 'Ch' || name === 'Sig') return name;
  return 'Tx';
}

function parseRgbFromEntry(obj: PDFObject | undefined): [number, number, number] | null {
  if (!(obj instanceof PDFArray) || obj.length < 3) return null;
  const n = obj.asNumbers();
  return [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0];
}

function buildWidget(
  dict: PDFDict,
  ref: PDFRef,
  fieldName: string,
  fieldType: AcroFormFieldType,
  pageRef: PDFRef | null,
  objects: Map<string, PDFObject>,
  parent?: PDFDict,
): AcroFormWidget {
  // Ff and Opt are inheritable; split widgets usually carry them on the parent field.
  const ff = intVal(dict.get('Ff') ?? parent?.get('Ff'));
  const optObj = resolveRef((dict.get('Opt') ?? parent?.get('Opt')) as PDFObject, objects);
  const options = optObj instanceof PDFArray
    ? optObj.items.map((item) => {
      const entry = resolveRef(item, objects);
      // Each entry is a text string or an [export, display] pair.
      return entry instanceof PDFArray ? strVal(entry.get(1) ?? entry.get(0)) : strVal(entry);
    })
    : [];
  const rect = parseWidgetRect(dict);
  const v = dict.get('V');
  let value: string | boolean | string[] | null = null;
  if (v instanceof PDFString || v instanceof PDFHexString || v instanceof PDFName) value = strVal(v);
  else if (v instanceof PDFArray) value = v.items.map(i => strVal(i));
  else if (v instanceof PDFRef) {
    // Signature fields store /V → Sig dictionary ref
    value = fieldType === 'Sig' ? `[Sig:${v.toKey()}]` : null;
  }

  // A check box or radio widget is on when its /AS isn't /Off.
  const asState = dict.get('AS');
  if (fieldType === 'Btn' && asState instanceof PDFName) value = asState.name !== 'Off';

  const mk = dict.get('MK');
  const mkDict = mk instanceof PDFRef ? resolveRef(mk, objects) : mk;
  let bg: [number, number, number] | null = null;
  if (mkDict instanceof PDFDict) {
    bg = parseRgbFromEntry(mkDict.get('BG'));
  }

  return {
    ref,
    dict,
    rect,
    pageRef,
    fieldName,
    fieldType,
    value,
    defaultAppearance: strVal(dict.get('DA')),
    borderWidth: widgetBorderWidth(dict, objects),
    backgroundColor: bg,
    borderColor: [0, 0, 0],
    readOnly: (ff & 1) !== 0,
    required: (ff & 2) !== 0,
    buttonFlags: fieldType === 'Btn' ? ff : 0,
    choiceFlags: fieldType === 'Ch' ? ff : 0,
    exportValue: fieldType === 'Btn' ? onStateName(dict, objects) : null,
    appearanceState: dict.get('AS') instanceof PDFName ? (dict.get('AS') as PDFName).name : null,
    onState: fieldType === 'Btn' ? onStateName(dict, objects) : null,
    options: fieldType === 'Ch' ? options : [],
    multiline: fieldType === 'Tx' && (ff & (1 << 12)) !== 0,
  };
}

/** The "on" state of a check box or radio widget: the /AP /N key that isn't /Off. */
export function onStateName(dict: PDFDict, objects: Map<string, PDFObject>): string | null {
  const ap = resolveRef(dict.get('AP') as PDFObject, objects);
  if (!(ap instanceof PDFDict)) return null;
  for (const variant of ['N', 'D']) {
    const states = resolveRef(ap.get(variant) as PDFObject, objects);
    if (!(states instanceof PDFDict)) continue;
    for (const key of states.keys()) if (key !== 'Off') return key;
  }
  return null;
}

function widgetBorderWidth(dict: PDFDict, objects: Map<string, import('../types').PDFObject>): number {
  const border = dict.get('Border');
  if (border instanceof PDFArray) {
    const w = border.get(2);
    return intVal(w);
  }
  const bs = dict.get('BS');
  if (bs) {
    const bsDict = resolveRef(bs, objects);
    if (bsDict instanceof PDFDict) return intVal(bsDict.get('W'), 1);
  }
  return 1;
}

function resolvePageRef(dict: PDFDict, objects: Map<string, PDFObject>): PDFRef | null {
  const p = dict.get('P');
  if (p instanceof PDFRef) return p;
  return null;
}

function walkField(
  fieldRef: PDFRef,
  objects: Map<string, PDFObject>,
  parentName: string,
): AcroFormField | null {
  const obj = resolveRef(fieldRef, objects);
  if (!(obj instanceof PDFDict)) return null;

  const partial = strVal(obj.get('T'));
  const fullName = parentName ? `${parentName}.${partial}` : partial;
  const ft = fieldTypeFromFT(obj.get('FT'));
  const subtype = obj.get('Subtype');
  const isWidget = subtype instanceof PDFName && subtype.name === 'Widget';

  const widgets: AcroFormWidget[] = [];
  const kids: AcroFormField[] = [];

  if (isWidget) {
    widgets.push(buildWidget(obj, fieldRef, fullName || partial, ft, resolvePageRef(obj, objects), objects));
  }

  const kidsArr = obj.get('Kids');
  if (kidsArr instanceof PDFArray) {
    for (let i = 0; i < kidsArr.length; i++) {
      const kidRef = kidsArr.get(i);
      if (!(kidRef instanceof PDFRef)) continue;
      const kidObj = resolveRef(kidRef, objects);
      if (!(kidObj instanceof PDFDict)) continue;

      const kidSubtype = kidObj.get('Subtype');
      if (kidSubtype instanceof PDFName && kidSubtype.name === 'Widget') {
        const kidFt = fieldTypeFromFT(kidObj.get('FT') ?? obj.get('FT'));
        const widget = buildWidget(
          kidObj, kidRef, fullName || partial, kidFt,
          resolvePageRef(kidObj, objects), objects, obj,
        );
        // Split field/widget pairs keep /V on the parent field.
        if (widget.value === null) {
          const parentV = obj.get('V');
          if (parentV instanceof PDFString || parentV instanceof PDFHexString || parentV instanceof PDFName) {
            widget.value = strVal(parentV);
          }
        }
        widgets.push(widget);
      } else {
        const child = walkField(kidRef, objects, fullName);
        if (child) kids.push(child);
        widgets.push(...child?.widgets ?? []);
      }
    }
  }

  const v = obj.get('V');
  let value: string | boolean | string[] | null = null;
  if (v instanceof PDFString || v instanceof PDFHexString || v instanceof PDFName) value = strVal(v);
  else if (v instanceof PDFArray) value = v.items.map(i => strVal(i));
  else if (v instanceof PDFRef && ft === 'Sig') {
    value = `[Sig:${v.toKey()}]`;
  }

  return {
    ref: fieldRef,
    dict: obj,
    partialName: partial,
    fullName,
    fieldType: ft,
    value,
    defaultValue: obj.get('DV') ? strVal(obj.get('DV')) : null,
    widgets,
    kids,
    flags: intVal(obj.get('Ff')),
    options: obj.get('Opt') instanceof PDFArray
      ? (obj.get('Opt') as PDFArray).items.map(i => strVal(i))
      : [],
  };
}

/** Parse document-level AcroForm catalog. */
export function parseAcroFormCatalog(doc: PDFDocumentData): AcroFormCatalog | null {
  const acroRef = doc.catalog.get('AcroForm');
  if (!acroRef) return null;

  const acro = resolveRef(acroRef, doc.objects);
  if (!(acro instanceof PDFDict)) return null;

  const fields: AcroFormField[] = [];
  const fieldsArr = acro.get('Fields');
  if (fieldsArr instanceof PDFArray) {
    for (let i = 0; i < fieldsArr.length; i++) {
      const ref = fieldsArr.get(i);
      if (ref instanceof PDFRef) {
        const field = walkField(ref, doc.objects, '');
        if (field) fields.push(field);
      }
    }
  }

  const co = acro.get('CO');
  const calculationOrder: PDFRef[] = [];
  if (co instanceof PDFArray) {
    for (let i = 0; i < co.length; i++) {
      const r = co.get(i);
      if (r instanceof PDFRef) calculationOrder.push(r);
    }
  }

  const dr = acro.get('DR');
  const defaultResources = dr instanceof PDFRef
    ? resolveRef(dr, doc.objects) as PDFDict
    : dr instanceof PDFDict ? dr : null;

  return {
    dict: acro,
    fields,
    needAppearances: acro.get('NeedAppearances') instanceof PDFBoolean
      ? (acro.get('NeedAppearances') as PDFBoolean).value
      : false,
    calculationOrder,
    defaultResources: defaultResources instanceof PDFDict ? defaultResources : null,
  };
}

function collectAllWidgets(fields: AcroFormField[]): AcroFormWidget[] {
  const out: AcroFormWidget[] = [];
  for (let i = 0; i < fields.length; i++) {
    out.push(...fields[i].widgets);
    out.push(...collectAllWidgets(fields[i].kids));
  }
  return out;
}

/** Detect form field widgets on a specific page (0-based index). */
export function detectFormFieldsOnPage(
  doc: PDFDocumentData,
  pageIndex: number,
): AcroFormWidget[] {
  if (pageIndex < 0 || pageIndex >= doc.pages.length) return [];

  const catalog = parseAcroFormCatalog(doc);
  if (!catalog) return [];

  const page = doc.pages[pageIndex];
  const pageKey = page.ref.toKey();
  const allWidgets = collectAllWidgets(catalog.fields);

  return allWidgets.filter(w => {
    if (w.pageRef) return w.pageRef.toKey() === pageKey;
    return widgetOnPageViaAnnots(w, page, doc);
  });
}

function widgetOnPageViaAnnots(
  widget: AcroFormWidget,
  page: PDFPageInfo,
  doc: PDFDocumentData,
): boolean {
  const annots = page.dict.get('Annots');
  if (!annots) return false;

  const arr = annots instanceof PDFRef ? resolveRef(annots, doc.objects) : annots;
  if (!(arr instanceof PDFArray)) return false;

  const widgetKey = widget.ref.toKey();
  for (let i = 0; i < arr.length; i++) {
    const ref = arr.get(i);
    if (ref instanceof PDFRef && ref.toKey() === widgetKey) return true;
  }
  return false;
}

/** Flatten field tree to widget list with bounds. */
export function listAllFormWidgets(doc: PDFDocumentData): AcroFormWidget[] {
  const catalog = parseAcroFormCatalog(doc);
  if (!catalog) return [];
  return collectAllWidgets(catalog.fields);
}

/** Hit-test a form widget by PDF page coordinates. */
export function hitTestFormField(
  fields: AcroFormWidget[],
  pdfX: number,
  pdfY: number,
): AcroFormWidget | null {
  for (let i = fields.length - 1; i >= 0; i--) {
    const f = fields[i];
    const r = f.rect;
    if (!r) continue;
    if (pdfX >= r.x && pdfX <= r.x + r.width && pdfY >= r.y && pdfY <= r.y + r.height) {
      return f;
    }
  }
  return null;
}
