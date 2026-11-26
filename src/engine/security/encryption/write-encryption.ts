/**
 * Encryption at write time.
 *
 * An opened (or newly protected) document keeps plaintext objects in memory so
 * it can be rendered and edited, and carries its file key in
 * `doc.encryptionKey`. The writer calls `encryptForWrite` to get a copy whose
 * strings and streams are encrypted with that key; the live document is never
 * modified.
 */

import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFNumber,
  PDFStream,
  PDFString,
  type PDFDocumentData,
  type PDFObject,
} from '../../types';
import type { EncryptDictionary, EncryptionAlgorithm } from '../types';
import { bytesToPdfHex, getEncryptDictFromTrailer } from './encrypt-dict';
import { computeObjectKey, encryptBytes, shouldEncryptStream, shouldEncryptString } from './object-cipher';
import { detectAlgorithm } from './standard-handler';

/** True when writing `doc` must encrypt its objects (it has a key and a trailer /Encrypt). */
export function needsWriteEncryption(doc: PDFDocumentData): boolean {
  return !!doc.encryptionKey && doc.xref.trailerDict.has('Encrypt');
}

interface ObjectCipher {
  key: Uint8Array;
  algorithm: EncryptionAlgorithm;
  strings: boolean;
}

async function encryptValue(obj: PDFObject, c: ObjectCipher): Promise<PDFObject> {
  if (obj instanceof PDFString || obj instanceof PDFHexString) {
    if (!c.strings) return obj;
    return bytesToPdfHex(await encryptBytes(obj.toBytes(), c.key, c.algorithm));
  }
  if (obj instanceof PDFDict) {
    const out = new PDFDict();
    for (const [k, v] of obj.entries()) out.set(k, await encryptValue(v, c));
    return out;
  }
  if (obj instanceof PDFArray) {
    const items: PDFObject[] = [];
    for (const v of obj.items) items.push(await encryptValue(v, c));
    return new PDFArray(items);
  }
  return obj;
}

async function encryptIndirect(
  obj: PDFObject,
  objNum: number,
  genNum: number,
  enc: EncryptDictionary,
  fileKey: Uint8Array,
  algorithm: EncryptionAlgorithm,
): Promise<PDFObject> {
  const c: ObjectCipher = {
    key: computeObjectKey(fileKey, objNum, genNum, algorithm),
    algorithm,
    strings: shouldEncryptString(enc),
  };
  if (obj instanceof PDFStream) {
    const dict = (await encryptValue(obj.dict, c)) as PDFDict;
    const type = obj.dict.getName('Type');
    const subtype = obj.dict.getName('Subtype');
    if (!shouldEncryptStream(enc, { type, subtype })) {
      return new PDFStream(dict, obj.rawBytes, obj.decodedBytes);
    }
    const cipher = await encryptBytes(obj.rawBytes, c.key, algorithm);
    dict.set('Length', new PDFNumber(cipher.length));
    return new PDFStream(dict, cipher);
  }
  return encryptValue(obj, c);
}

/**
 * Returns `doc` itself when no write-time encryption is needed, otherwise a
 * shallow copy whose `objects` map holds encrypted copies of every object
 * except the /Encrypt dictionary.
 */
export async function encryptForWrite(doc: PDFDocumentData): Promise<PDFDocumentData> {
  if (!needsWriteEncryption(doc)) return doc;
  const enc = getEncryptDictFromTrailer(doc.xref.trailerDict, doc.objects);
  if (!enc) throw new Error('Cannot save: the encryption dictionary is missing');
  const algorithm = detectAlgorithm(enc);
  const fileKey = doc.encryptionKey!;
  const encryptKey = enc.ref?.toKey();

  const objects = new Map<string, PDFObject>();
  for (const [key, obj] of doc.objects) {
    if (key === encryptKey) {
      objects.set(key, obj);
      continue;
    }
    const [on, gn] = key.split('_').map((n) => parseInt(n, 10));
    objects.set(key, await encryptIndirect(obj, on, gn, enc, fileKey, algorithm));
  }
  return { ...doc, objects, encryptionKey: undefined };
}
