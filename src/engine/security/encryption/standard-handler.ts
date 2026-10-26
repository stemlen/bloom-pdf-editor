/**
 * ISO 32000 Standard Security Handler algorithms (R2–R6).
 */

import { md5 } from '../crypto/md5';
import { rc4 } from '../crypto/rc4';
import {
  aesDecryptRaw,
  aesEncryptRaw,
  aesEcbEncryptBlock,
  sha256,
  sha384,
  sha512,
} from '../crypto/aes';
import {
  bytesEqual,
  concatBytes,
  int32LE,
  randomBytes,
  stringToPdfBytes,
  utf8Encode,
} from '../crypto/bytes';
import type {
  EncryptionAlgorithm,
  EncryptDictionary,
  FileIdPair,
  PdfPermissions,
} from '../types';
import { serializePermissions } from '../permissions/permission-bits';

/** PDF password padding string (ISO 32000 Algorithm 2). */
export const PASSWORD_PADDING = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41,
  0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80,
  0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

/** Truncate/pad password to 32 bytes (R2–R4). */
export function padPassword(password: string): Uint8Array {
  const raw = stringToPdfBytes(password).subarray(0, 32);
  if (raw.length === 32) return raw;
  const out = new Uint8Array(32);
  out.set(raw);
  out.set(PASSWORD_PADDING.subarray(0, 32 - raw.length), raw.length);
  return out;
}

/** UTF-8 password bytes for R5/R6 (max 127 bytes). */
export function utf8Password(password: string): Uint8Array {
  const bytes = utf8Encode(password);
  return bytes.length > 127 ? bytes.subarray(0, 127) : bytes;
}

export function detectAlgorithm(enc: EncryptDictionary): EncryptionAlgorithm {
  if (enc.revision >= 5) return 'AES-256';
  if (enc.version >= 4) {
    const cf =
      enc.cryptFilters.get(enc.stmF) ??
      enc.cryptFilters.get('StdCF') ??
      enc.cryptFilters.get('DefaultCryptFilter');
    if (cf?.method === 'AESV2') return 'AES-128';
    if (cf?.method === 'AESV3') return 'AES-256';
    if (cf?.method === 'V2' || enc.length <= 40) {
      return enc.length <= 40 ? 'RC4-40' : 'RC4-128';
    }
    return enc.length <= 40 ? 'RC4-40' : 'RC4-128';
  }
  if (enc.length <= 40) return 'RC4-40';
  return 'RC4-128';
}

function keyByteLength(enc: EncryptDictionary): number {
  if (enc.revision >= 5) return 32;
  return Math.max(5, Math.floor(enc.length / 8));
}

/**
 * Algorithm 2 — Compute encryption key (R2–R4).
 */
export function computeFileKeyR2R4(
  password: string,
  enc: EncryptDictionary,
  fileId: FileIdPair,
): Uint8Array {
  const keyLen = keyByteLength(enc);

  // A single MD5 over: padded password || O (32 bytes) || P (int32 LE) || ID[0]
  // [|| FFFFFFFF when R4 and metadata is not encrypted].
  const parts: Uint8Array[] = [
    padPassword(password),
    enc.O.subarray(0, 32),
    int32LE(enc.P),
    fileId.permanent,
  ];
  if (enc.revision >= 4 && !enc.encryptMetadata) {
    parts.push(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
  }
  let hash = md5(concatBytes(...parts));

  if (enc.revision >= 3) {
    for (let i = 0; i < 50; i++) {
      hash = md5(hash.subarray(0, keyLen));
    }
  }

  return hash.subarray(0, keyLen);
}

/**
 * Algorithm 3 — Compute /O entry (R2–R4).
 */
export function computeOValue(
  ownerPassword: string,
  userPassword: string,
  revision: number,
  keyLen: number,
): Uint8Array {
  let hash = md5(padPassword(ownerPassword || userPassword));
  if (revision >= 3) {
    for (let i = 0; i < 50; i++) hash = md5(hash);
  }
  const ownerKey = hash.subarray(0, keyLen);
  const userPad = padPassword(userPassword);

  if (revision === 2) {
    return rc4(ownerKey, userPad);
  }

  // R3+: 20 iterations with XOR'd keys
  let data = userPad;
  for (let i = 0; i < 20; i++) {
    const iterKey = new Uint8Array(ownerKey.length);
    for (let j = 0; j < ownerKey.length; j++) iterKey[j] = ownerKey[j] ^ i;
    data = rc4(iterKey, data);
  }
  return data;
}

/**
 * Algorithm 4 / 5 — Compute /U entry (R2–R4).
 */
export function computeUValue(
  fileKey: Uint8Array,
  enc: EncryptDictionary,
  fileId: FileIdPair,
): Uint8Array {
  if (enc.revision === 2) {
    return rc4(fileKey, PASSWORD_PADDING);
  }

  // R3+: MD5(padding || ID) then RC4 with 20 iterations
  const hash = md5(concatBytes(PASSWORD_PADDING, fileId.permanent));
  let data = hash; // 16 bytes
  for (let i = 0; i < 20; i++) {
    const iterKey = new Uint8Array(fileKey.length);
    for (let j = 0; j < fileKey.length; j++) iterKey[j] = fileKey[j] ^ i;
    data = rc4(iterKey, data);
  }
  // U is 32 bytes: 16 result + 16 arbitrary (zeros)
  const out = new Uint8Array(32);
  out.set(data.subarray(0, 16));
  return out;
}

/**
 * Algorithm 6 — Authenticate user password (R2–R4).
 */
export function authenticateUserR2R4(
  password: string,
  enc: EncryptDictionary,
  fileId: FileIdPair,
): Uint8Array | null {
  const fileKey = computeFileKeyR2R4(password, enc, fileId);
  const u = computeUValue(fileKey, enc, fileId);
  const compareLen = enc.revision === 2 ? 32 : 16;
  if (bytesEqual(u, enc.U, compareLen)) return fileKey;
  return null;
}

/**
 * Algorithm 7 — Authenticate owner password (R2–R4).
 * Returns the user password decryption → then user auth for file key.
 */
export function authenticateOwnerR2R4(
  password: string,
  enc: EncryptDictionary,
  fileId: FileIdPair,
): Uint8Array | null {
  const keyLen = keyByteLength(enc);
  let hash = md5(padPassword(password));
  if (enc.revision >= 3) {
    for (let i = 0; i < 50; i++) hash = md5(hash);
  }
  const ownerKey = hash.subarray(0, keyLen);

  let userPad: Uint8Array;
  if (enc.revision === 2) {
    userPad = rc4(ownerKey, enc.O);
  } else {
    let data = enc.O.subarray(0, 32);
    for (let i = 19; i >= 0; i--) {
      const iterKey = new Uint8Array(ownerKey.length);
      for (let j = 0; j < ownerKey.length; j++) iterKey[j] = ownerKey[j] ^ i;
      data = rc4(iterKey, data);
    }
    userPad = data;
  }

  // userPad is the padded user password — try as empty first via file key path
  // Convert padded bytes back: try authenticate with recovered password bytes
  // Spec: use Algorithm 6 with the user password obtained
  const recovered = pdfPadToPassword(userPad);
  return authenticateUserR2R4(recovered, enc, fileId);
}

function pdfPadToPassword(padded: Uint8Array): string {
  // Find where padding starts by matching PASSWORD_PADDING
  let len = 32;
  for (let i = 0; i < 32; i++) {
    if (padded[i] === PASSWORD_PADDING[0] && bytesEqual(padded.subarray(i), PASSWORD_PADDING.subarray(0, 32 - i))) {
      len = i;
      break;
    }
  }
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(padded[i]);
  return s;
}

/**
 * ISO 32000-2 Algorithm 2.B — hash for R6.
 */
export async function hashRevision6(
  password: Uint8Array,
  salt: Uint8Array,
  userKey?: Uint8Array,
): Promise<Uint8Array> {
  let k = await sha256(concatBytes(password, salt, userKey ?? new Uint8Array(0)));
  let e: Uint8Array = new Uint8Array(0);
  let round = 0;

  // Run at least 64 rounds, then stop once the last byte of the latest E is
  // <= round - 32 (it is E's last byte, not K's). This always ends by round 288.
  while (round < 64 || e[e.length - 1] > round - 32) {
    const k1Parts: Uint8Array[] = [];
    const block = concatBytes(password, k, userKey ?? new Uint8Array(0));
    // Repeat to 64 repetitions
    for (let i = 0; i < 64; i++) k1Parts.push(block);
    const k1 = concatBytes(...k1Parts);

    const aesKey = k.subarray(0, 16);
    const iv = k.subarray(16, 32);
    e = await aesEncryptRaw(aesKey, iv, k1, false);

    // Choose next hash based on first 16 bytes of E as big-endian mod 3
    let remainder = 0;
    for (let i = 0; i < 16; i++) {
      remainder = (remainder * 256 + e[i]) % 3;
    }
    if (remainder === 0) k = await sha256(e);
    else if (remainder === 1) k = await sha384(e);
    else k = await sha512(e);

    round++;
  }

  return k.subarray(0, 32);
}

/**
 * Authenticate user password R5/R6.
 */
export async function authenticateUserR5R6(
  password: string,
  enc: EncryptDictionary,
): Promise<Uint8Array | null> {
  if (!enc.UE || !enc.U) return null;
  const pw = utf8Password(password);
  const u = enc.U;
  const validationSalt = u.subarray(32, 40);
  const keySalt = u.subarray(40, 48);

  let hash: Uint8Array;
  if (enc.revision >= 6) {
    hash = await hashRevision6(pw, validationSalt);
  } else {
    hash = await sha256(concatBytes(pw, validationSalt));
  }

  if (!bytesEqual(hash, u.subarray(0, 32))) return null;

  // Decrypt UE to get file encryption key
  let intermediate: Uint8Array;
  if (enc.revision >= 6) {
    intermediate = await hashRevision6(pw, keySalt);
  } else {
    intermediate = await sha256(concatBytes(pw, keySalt));
  }

  const zeroIv = new Uint8Array(16);
  return aesDecryptRaw(intermediate, zeroIv, enc.UE, false);
}

/**
 * Authenticate owner password R5/R6.
 */
export async function authenticateOwnerR5R6(
  password: string,
  enc: EncryptDictionary,
): Promise<Uint8Array | null> {
  if (!enc.OE || !enc.O || !enc.U) return null;
  const pw = utf8Password(password);
  const o = enc.O;
  const validationSalt = o.subarray(32, 40);
  const keySalt = o.subarray(40, 48);
  const uTrunc = enc.U.subarray(0, 48);

  let hash: Uint8Array;
  if (enc.revision >= 6) {
    hash = await hashRevision6(pw, validationSalt, uTrunc);
  } else {
    hash = await sha256(concatBytes(pw, validationSalt, uTrunc));
  }

  if (!bytesEqual(hash, o.subarray(0, 32))) return null;

  let intermediate: Uint8Array;
  if (enc.revision >= 6) {
    intermediate = await hashRevision6(pw, keySalt, uTrunc);
  } else {
    intermediate = await sha256(concatBytes(pw, keySalt, uTrunc));
  }

  const zeroIv = new Uint8Array(16);
  return aesDecryptRaw(intermediate, zeroIv, enc.OE, false);
}

/**
 * Create R2–R4 encryption material.
 */
export function createEncryptionR2R4(
  userPassword: string,
  ownerPassword: string,
  permissions: PdfPermissions,
  algorithm: EncryptionAlgorithm,
  fileId: FileIdPair,
  encryptMetadata = true,
): { O: Uint8Array; U: Uint8Array; P: number; fileKey: Uint8Array; length: number; revision: 2 | 3 | 4; version: 1 | 2 | 4 } {
  const isAes = algorithm === 'AES-128';
  const length = algorithm === 'RC4-40' ? 40 : 128;
  const keyLen = length / 8;
  const revision: 2 | 3 | 4 = algorithm === 'RC4-40' ? 2 : isAes ? 4 : 3;
  const version: 1 | 2 | 4 = algorithm === 'RC4-40' ? 1 : isAes ? 4 : 2;
  const P = serializePermissions(permissions, revision);

  const O = computeOValue(ownerPassword || userPassword, userPassword, revision, keyLen);

  // Temporary enc dict for file key computation
  const tempEnc: EncryptDictionary = {
    filter: 'Standard',
    version,
    revision,
    length,
    O,
    U: new Uint8Array(32),
    P,
    encryptMetadata,
    stmF: isAes ? 'StdCF' : 'Identity',
    strF: isAes ? 'StdCF' : 'Identity',
    eff: isAes ? 'StdCF' : 'Identity',
    cryptFilters: new Map(),
    dict: null as unknown as EncryptDictionary['dict'],
  };

  const fileKey = computeFileKeyR2R4(userPassword, tempEnc, fileId);
  const U = computeUValue(fileKey, tempEnc, fileId);

  return { O, U, P, fileKey, length, revision, version };
}

/**
 * Create R6 (AES-256) encryption material.
 */
export async function createEncryptionR6(
  userPassword: string,
  ownerPassword: string,
  permissions: PdfPermissions,
  encryptMetadata = true,
): Promise<{
  O: Uint8Array;
  U: Uint8Array;
  OE: Uint8Array;
  UE: Uint8Array;
  Perms: Uint8Array;
  P: number;
  fileKey: Uint8Array;
}> {
  const fileKey = randomBytes(32);
  const P = serializePermissions(permissions, 6);
  const uPw = utf8Password(userPassword);
  const oPw = utf8Password(ownerPassword || userPassword);

  const uValidationSalt = randomBytes(8);
  const uKeySalt = randomBytes(8);
  const oValidationSalt = randomBytes(8);
  const oKeySalt = randomBytes(8);

  const uHash = await hashRevision6(uPw, uValidationSalt);
  const U = new Uint8Array(48);
  U.set(uHash);
  U.set(uValidationSalt, 32);
  U.set(uKeySalt, 40);

  const uKeyHash = await hashRevision6(uPw, uKeySalt);
  const zeroIv = new Uint8Array(16);
  const UE = await aesEncryptRaw(uKeyHash, zeroIv, fileKey, false);

  const oHash = await hashRevision6(oPw, oValidationSalt, U);
  const O = new Uint8Array(48);
  O.set(oHash);
  O.set(oValidationSalt, 32);
  O.set(oKeySalt, 40);

  const oKeyHash = await hashRevision6(oPw, oKeySalt, U);
  const OE = await aesEncryptRaw(oKeyHash, zeroIv, fileKey, false);

  // Perms: 16 bytes plaintext then AES-ECB encrypted with file key
  // bytes 0-3: P little-endian
  // bytes 4-7: 0xffffffff (EncryptMetadata true) or 0x00000000? 
  // Spec: EncryptMetadata false → T = 0xFFFFFFFF for bytes? Actually:
  // Perms[0..3] = P
  // Perms[4..7] = 0xFFFFFFFF
  // Perms[8] = 'T' or 'F' for EncryptMetadata
  // Perms[9..11] = 'adb'
  // Perms[12..15] = random
  const permsPlain = new Uint8Array(16);
  permsPlain.set(int32LE(P), 0);
  permsPlain[4] = 0xff;
  permsPlain[5] = 0xff;
  permsPlain[6] = 0xff;
  permsPlain[7] = 0xff;
  permsPlain[8] = encryptMetadata ? 0x54 : 0x46; // 'T' or 'F'
  permsPlain[9] = 0x61; // a
  permsPlain[10] = 0x64; // d
  permsPlain[11] = 0x62; // b
  permsPlain.set(randomBytes(4), 12);

  const Perms = await aesEcbEncryptBlock(fileKey, permsPlain);

  return { O, U, OE, UE, Perms, P, fileKey };
}
