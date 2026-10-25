/**
 * Parse PDF /Encrypt dictionary (Standard Security Handler).
 */

import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFObject,
  PDFRef,
  PDFString,
} from '../../types';
import type {
  CryptFilter,
  CryptFilterMethod,
  EncryptDictionary,
  EncryptionRevision,
  EncryptionVersion,
  FileIdPair,
} from '../types';

function asBytes(obj: PDFObject | undefined): Uint8Array {
  if (!obj) return new Uint8Array(0);
  if (obj instanceof PDFString) return obj.toBytes();
  if (obj instanceof PDFHexString) return obj.toBytes();
  return new Uint8Array(0);
}

function resolveDict(
  obj: PDFObject | undefined,
  resolve?: (o: PDFObject) => PDFObject,
): PDFDict | null {
  if (!obj) return null;
  const r = resolve ? resolve(obj) : obj;
  return r instanceof PDFDict ? r : null;
}

function parseCryptFilter(name: string, dict: PDFDict): CryptFilter {
  const methodName = dict.getName('CFM') ?? 'None';
  const method = methodName as CryptFilterMethod;
  return {
    name,
    method: ['None', 'V2', 'AESV2', 'AESV3', 'Identity'].includes(methodName)
      ? method
      : 'None',
    length: dict.getNumber('Length'),
    authEvent: dict.getName('AuthEvent'),
  };
}

/**
 * Parse an Encrypt dictionary into a typed structure.
 */
export function parseEncryptDict(
  dict: PDFDict,
  resolve?: (obj: PDFObject) => PDFObject,
  ref?: PDFRef,
): EncryptDictionary {
  const filter = dict.getName('Filter') ?? 'Standard';
  const version = (dict.getNumber('V') ?? 1) as EncryptionVersion;
  const revision = (dict.getNumber('R') ?? 2) as EncryptionRevision;
  let length = dict.getNumber('Length') ?? 40;
  if (revision >= 5) length = 256;
  else if (version >= 2 && !dict.has('Length')) length = 128;

  const cryptFilters = new Map<string, CryptFilter>();
  const cfDict = resolveDict(dict.get('CF'), resolve);
  if (cfDict) {
    for (const [key, value] of cfDict.entries()) {
      const d = resolveDict(value, resolve);
      if (d) cryptFilters.set(key, parseCryptFilter(key, d));
    }
  }

  // Default StdCF if missing for V4+
  if (version >= 4 && !cryptFilters.has('StdCF')) {
    const method: CryptFilterMethod =
      revision >= 5 ? 'AESV3' : version >= 4 ? 'AESV2' : 'V2';
    cryptFilters.set('StdCF', { name: 'StdCF', method, length: length / 8 });
  }

  // Crypt filters only exist from V4. Below that, every string and stream is
  // encrypted with the file key, which we model as the standard filter.
  const stmF = version >= 4 ? dict.getName('StmF') ?? 'StdCF' : 'StdCF';
  const strF = version >= 4 ? dict.getName('StrF') ?? 'StdCF' : 'StdCF';
  const eff = dict.getName('EFF') ?? stmF;

  return {
    filter,
    subFilter: dict.getName('SubFilter'),
    version,
    revision,
    length,
    O: asBytes(dict.get('O')),
    U: asBytes(dict.get('U')),
    OE: dict.has('OE') ? asBytes(dict.get('OE')) : undefined,
    UE: dict.has('UE') ? asBytes(dict.get('UE')) : undefined,
    Perms: dict.has('Perms') ? asBytes(dict.get('Perms')) : undefined,
    P: dict.getNumber('P') ?? -1,
    encryptMetadata: dict.getBool('EncryptMetadata') ?? true,
    stmF,
    strF,
    eff,
    cryptFilters,
    dict,
    ref,
  };
}

/**
 * Extract /ID from trailer.
 */
export function parseFileId(trailer: PDFDict): FileIdPair {
  const idArr = trailer.getArray('ID');
  if (!idArr || idArr.length < 1) {
    const empty = new Uint8Array(16);
    return { permanent: empty, changing: empty };
  }
  const permanent = asBytes(idArr.get(0));
  const changing = idArr.length > 1 ? asBytes(idArr.get(1)) : permanent;
  return {
    permanent: permanent.length >= 16 ? permanent.subarray(0, 16) : pad16(permanent),
    changing: changing.length >= 16 ? changing.subarray(0, 16) : pad16(changing),
  };
}

function pad16(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(16);
  out.set(b.subarray(0, Math.min(16, b.length)));
  return out;
}

/**
 * Read Encrypt dict from a document trailer (resolving indirect refs).
 */
export function getEncryptDictFromTrailer(
  trailer: PDFDict,
  objects: Map<string, PDFObject>,
): EncryptDictionary | null {
  const encryptObj = trailer.get('Encrypt');
  if (!encryptObj) return null;

  const resolve = (obj: PDFObject): PDFObject => {
    if (obj instanceof PDFRef) {
      return objects.get(obj.toKey()) ?? obj;
    }
    return obj;
  };

  let ref: PDFRef | undefined;
  let dict: PDFDict | null = null;

  if (encryptObj instanceof PDFRef) {
    ref = encryptObj;
    const resolved = objects.get(encryptObj.toKey());
    if (resolved instanceof PDFDict) dict = resolved;
  } else if (encryptObj instanceof PDFDict) {
    dict = encryptObj;
  }

  if (!dict) return null;
  return parseEncryptDict(dict, resolve, ref);
}

export function isEncryptedTrailer(trailer: PDFDict): boolean {
  return trailer.has('Encrypt');
}

/** Build a PDF HexString from bytes. */
export function bytesToPdfHex(bytes: Uint8Array): PDFHexString {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return new PDFHexString(hex);
}

/** Ensure trailer has an /ID array; create one if missing. */
export function ensureFileId(trailer: PDFDict): FileIdPair {
  if (!trailer.has('ID')) {
    const id = cryptoRandomId();
    trailer.set('ID', new PDFArray([bytesToPdfHex(id), bytesToPdfHex(id)]));
    return { permanent: id, changing: id };
  }
  return parseFileId(trailer);
}

function cryptoRandomId(): Uint8Array {
  const id = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(id);
  } else {
    for (let i = 0; i < 16; i++) id[i] = Math.floor(Math.random() * 256);
  }
  return id;
}
