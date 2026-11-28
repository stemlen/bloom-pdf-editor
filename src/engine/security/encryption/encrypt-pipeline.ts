/**
 * Build the /Encrypt dictionary and file key for a document (Phase 4).
 */

import {
  PDFBoolean,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRef,
  type PDFDocumentData,
} from '../../types';
import { getNextObjNum } from '../../writer/serializer';
import type {
  EncryptDictionary,
  EncryptOptions,
  EncryptionAlgorithm,
  EncryptionContext,
  PdfPermissions,
} from '../types';
import { mergePermissions } from '../permissions/permission-bits';
import {
  createEncryptionR2R4,
  createEncryptionR6,
  detectAlgorithm,
} from './standard-handler';
import {
  bytesToPdfHex,
  ensureFileId,
  parseEncryptDict,
} from './encrypt-dict';
import { stringToPdfBytes } from '../crypto/bytes';

/**
 * Protect a document: build the /Encrypt dictionary, attach it to the trailer
 * and store the file key on the document. Strings and streams are encrypted
 * when the document is written (see write-encryption.ts).
 */
export async function encryptDocumentObjects(
  doc: PDFDocumentData,
  options: EncryptOptions = {},
): Promise<EncryptionContext> {
  const algorithm: EncryptionAlgorithm = options.algorithm ?? 'AES-256';
  const userPassword = options.userPassword ?? '';
  const ownerPassword = options.ownerPassword ?? userPassword;
  const permissions: PdfPermissions = mergePermissions(options.permissions);
  const encryptMetadata = options.encryptMetadata ?? true;

  const fileId = ensureFileId(doc.xref.trailerDict);

  let fileKey: Uint8Array;
  let encryptDict: PDFDict;
  let parsed: EncryptDictionary;

  if (algorithm === 'AES-256') {
    const mat = await createEncryptionR6(userPassword, ownerPassword, permissions, encryptMetadata);
    fileKey = mat.fileKey;
    encryptDict = buildEncryptDictR6(mat, encryptMetadata);
    parsed = parseEncryptDict(encryptDict);
  } else {
    const mat = createEncryptionR2R4(
      userPassword,
      ownerPassword,
      permissions,
      algorithm,
      fileId,
      encryptMetadata,
    );
    fileKey = mat.fileKey;
    encryptDict = buildEncryptDictR2R4(mat, algorithm, encryptMetadata);
    parsed = parseEncryptDict(encryptDict);
  }

  // Assign Encrypt as a new indirect object
  const objNum = getNextObjNum(doc);
  const encryptRef = new PDFRef(objNum, 0);
  doc.objects.set(encryptRef.toKey(), encryptDict);
  doc.xref.trailerDict.set('Encrypt', encryptRef);
  parsed.ref = encryptRef;
  parsed.dict = encryptDict;

  const ctx: EncryptionContext = {
    encrypt: parsed,
    fileId,
    fileKey,
    isOwner: true,
    algorithm: detectAlgorithm(parsed),
  };

  // Objects stay plaintext in memory (so the document can still be rendered and
  // edited); the writer encrypts them with this key on save.
  doc.encryptionKey = fileKey;

  // Bump version for AES
  if (algorithm === 'AES-256' && parseFloat(doc.version) < 1.7) {
    doc.version = '1.7';
  } else if (algorithm === 'AES-128' && parseFloat(doc.version) < 1.6) {
    doc.version = '1.6';
  }

  return ctx;
}

function buildEncryptDictR6(
  mat: Awaited<ReturnType<typeof createEncryptionR6>>,
  encryptMetadata: boolean,
): PDFDict {
  const cf = new PDFDict();
  const stdCF = new PDFDict();
  stdCF.set('CFM', new PDFName('AESV3'));
  stdCF.set('Length', new PDFNumber(32));
  stdCF.set('AuthEvent', new PDFName('DocOpen'));
  cf.set('StdCF', stdCF);

  const d = new PDFDict();
  d.set('Filter', new PDFName('Standard'));
  d.set('V', new PDFNumber(5));
  d.set('R', new PDFNumber(6));
  d.set('Length', new PDFNumber(256));
  d.set('O', bytesToPdfHex(mat.O));
  d.set('U', bytesToPdfHex(mat.U));
  d.set('OE', bytesToPdfHex(mat.OE));
  d.set('UE', bytesToPdfHex(mat.UE));
  d.set('Perms', bytesToPdfHex(mat.Perms));
  d.set('P', new PDFNumber(mat.P));
  d.set('EncryptMetadata', new PDFBoolean(encryptMetadata));
  d.set('CF', cf);
  d.set('StmF', new PDFName('StdCF'));
  d.set('StrF', new PDFName('StdCF'));
  return d;
}

function buildEncryptDictR2R4(
  mat: ReturnType<typeof createEncryptionR2R4>,
  algorithm: EncryptionAlgorithm,
  encryptMetadata: boolean,
): PDFDict {
  const d = new PDFDict();
  d.set('Filter', new PDFName('Standard'));
  d.set('V', new PDFNumber(mat.version));
  d.set('R', new PDFNumber(mat.revision));
  d.set('Length', new PDFNumber(mat.length));
  d.set('O', bytesToPdfHex(mat.O));
  d.set('U', bytesToPdfHex(mat.U));
  d.set('P', new PDFNumber(mat.P));

  if (algorithm === 'AES-128') {
    d.set('EncryptMetadata', new PDFBoolean(encryptMetadata));
    const cf = new PDFDict();
    const stdCF = new PDFDict();
    stdCF.set('CFM', new PDFName('AESV2'));
    stdCF.set('Length', new PDFNumber(16));
    stdCF.set('AuthEvent', new PDFName('DocOpen'));
    cf.set('StdCF', stdCF);
    d.set('CF', cf);
    d.set('StmF', new PDFName('StdCF'));
    d.set('StrF', new PDFName('StdCF'));
  }

  return d;
}

/** Serialize EncryptDictionary back to PDFDict (permission updates etc.). */
export function serializeEncryptDict(enc: EncryptDictionary): PDFDict {
  return enc.dict;
}

export { stringToPdfBytes };
