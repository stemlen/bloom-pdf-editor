/**
 * Digital signing — create signature fields and cryptographically sign (Phase 7).
 * Delegates CMS + ByteRange pipeline to signing-pipeline / cms-builder / hash-engine.
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
import { getNextObjNum } from '../../writer/serializer';
import { addAnnotationToPage } from '../../editor/annotation-engine';
import { buildDetachedCMS } from './cms-builder';
import {
  signDocumentCryptographic,
  type CryptoSignOptions,
  type SignPipelineResult,
} from './signing-pipeline';
import type { HashAlgorithm } from './hash-engine';

export { buildDetachedCMS } from './cms-builder';
export {
  signDocumentCryptographic,
  createSignatureDictionary,
  computeByteRangeFromContentsSpan,
  findContentsHexSpan,
  fillContentsHex,
  patchByteRangeInPlace,
  DEFAULT_CONTENTS_SIZE,
} from './signing-pipeline';
export type { CryptoSignOptions, SignPipelineResult } from './signing-pipeline';

/** Create an empty signature field widget on a page. */
export function createSignatureField(
  doc: PDFDocumentData,
  pageIndex: number,
  rect: PDFRectangle,
  fieldName = 'Signature1',
): PDFRef {
  const page = doc.pages[pageIndex];
  const objNum = getNextObjNum(doc);
  const ref = new PDFRef(objNum, 0);

  const dict = new PDFDict();
  dict.set('Type', new PDFName('Annot'));
  dict.set('Subtype', new PDFName('Widget'));
  dict.set('FT', new PDFName('Sig'));
  dict.set('T', new PDFString(fieldName));
  dict.set('Rect', new PDFArray([
    new PDFNumber(rect.x),
    new PDFNumber(rect.y),
    new PDFNumber(rect.x + rect.width),
    new PDFNumber(rect.y + rect.height),
  ]));
  dict.set('F', new PDFNumber(4));
  dict.set('P', page.ref);

  addAnnotationToPage(page.dict, dict, ref, doc.objects);

  // Ensure AcroForm
  const catalog = doc.catalog;
  const acro = catalog.get('AcroForm');
  if (!acro) {
    const acroDict = new PDFDict();
    acroDict.set('Fields', new PDFArray([ref]));
    acroDict.set('SigFlags', new PDFNumber(3));
    const acroRef = new PDFRef(getNextObjNum(doc), 0);
    doc.objects.set(acroRef.toKey(), acroDict);
    catalog.set('AcroForm', acroRef);
  } else if (acro instanceof PDFDict) {
    const fields = acro.get('Fields');
    if (fields instanceof PDFArray) fields.push(ref);
  } else if (acro instanceof PDFRef) {
    const acroDict = doc.objects.get(acro.toKey());
    if (acroDict instanceof PDFDict) {
      const fields = acroDict.get('Fields');
      if (fields instanceof PDFArray) fields.push(ref);
      else acroDict.set('Fields', new PDFArray([ref]));
    }
  }

  return ref;
}

export interface SignOptions extends CryptoSignOptions {
  /** @deprecated use appearanceText via CryptoSignOptions */
  appearanceText?: string;
}

/**
 * Sign a signature field using Web Crypto (RSA or ECDSA).
 * Produces a valid /ByteRange + CMS /Contents via the Phase 7 pipeline.
 */
export async function signDocument(
  doc: PDFDocumentData,
  fieldRef: PDFRef,
  privateKey: CryptoKey,
  certDer?: Uint8Array,
  options: SignOptions = {},
): Promise<PDFDocumentData> {
  const result = await signDocumentCryptographic(doc, fieldRef, privateKey, {
    ...options,
    certificateDer: certDer ?? options.certificateDer,
  });
  doc.rawBytes = result.bytes;
  return doc;
}

/** Expose pipeline result for advanced callers. */
export async function signDocumentWithResult(
  doc: PDFDocumentData,
  fieldRef: PDFRef,
  privateKey: CryptoKey,
  options: SignOptions = {},
): Promise<SignPipelineResult> {
  return signDocumentCryptographic(doc, fieldRef, privateKey, options);
}

export type { HashAlgorithm };
