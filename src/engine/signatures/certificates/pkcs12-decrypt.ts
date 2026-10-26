/**
 * PKCS#12 decryption for password-protected .p12/.pfx files (RFC 7292),
 * using WebCrypto: PBES2 with PBKDF2 and AES-CBC (RFC 8018), which is what
 * OpenSSL 3, macOS Keychain and current Windows exports use.
 */

import { decodeOID } from '../crypto/signature-verify';
import type { ASN1Node } from '../crypto/types';

const OID_PBES2 = '1.2.840.113549.1.5.13';
const OID_PBKDF2 = '1.2.840.113549.1.5.12';
const PRF_HASH: Record<string, string> = {
  '1.2.840.113549.2.7': 'SHA-1',
  '1.2.840.113549.2.9': 'SHA-256',
  '1.2.840.113549.2.10': 'SHA-384',
  '1.2.840.113549.2.11': 'SHA-512',
};
const AES_KEY_BYTES: Record<string, number> = {
  '2.16.840.1.101.3.4.1.2': 16,
  '2.16.840.1.101.3.4.1.22': 24,
  '2.16.840.1.101.3.4.1.42': 32,
};
/** pbeWithSHAAnd… (RFC 7292 Appendix C): 3DES / RC2 / RC4, not available in WebCrypto. */
const LEGACY_PBE_PREFIX = '1.2.840.113549.1.12.1.';

/** Thrown when the password is missing or wrong, so the UI can ask again. */
export class Pkcs12PasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Pkcs12PasswordError';
  }
}

function oidOf(node: ASN1Node | undefined): string | null {
  if (!node || node.tag !== 0x06 || node.class !== 'universal') return null;
  try {
    return decodeOID(node.content);
  } catch {
    return null;
  }
}

function intOf(node: ASN1Node | undefined): number {
  if (!node || node.tag !== 0x02) return 0;
  let n = 0;
  for (const b of node.content) n = n * 256 + b;
  return n;
}

/** Bytes of an OCTET STRING, joining the pieces of a constructed (BER) one. */
export function octets(node: ASN1Node): Uint8Array {
  if (!node.constructed || !node.children) return node.content;
  const parts = node.children.map(octets);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Re-encode a parsed node as DER (single-byte tags, as PKCS#12 uses). */
export function encodeNode(node: ASN1Node): Uint8Array {
  const cls = { universal: 0x00, application: 0x40, context: 0x80, private: 0xc0 }[node.class] ?? 0;
  const tagByte = cls | (node.constructed ? 0x20 : 0) | node.tag;
  const len = node.content.length;
  let header: number[];
  if (len < 0x80) header = [tagByte, len];
  else {
    const bytes: number[] = [];
    for (let n = len; n > 0; n = Math.floor(n / 256)) bytes.unshift(n & 0xff);
    header = [tagByte, 0x80 | bytes.length, ...bytes];
  }
  const out = new Uint8Array(header.length + len);
  out.set(header, 0);
  out.set(node.content, header.length);
  return out;
}

/**
 * Decrypt `data` encrypted with the AlgorithmIdentifier `algorithm`.
 * @throws Pkcs12PasswordError when the password is missing or wrong.
 */
export async function decryptPkcs12(
  algorithm: ASN1Node,
  data: Uint8Array,
  password: string,
): Promise<Uint8Array> {
  const oid = oidOf(algorithm.children?.[0]);
  if (oid?.startsWith(LEGACY_PBE_PREFIX)) {
    throw new Error(
      'This certificate file uses legacy encryption (Triple DES or RC2) that browsers can’t decrypt. ' +
        'Re-export it with AES encryption, or as a PEM file, and import that instead.',
    );
  }
  if (oid !== OID_PBES2) throw new Error('This certificate file uses an encryption method Bloom doesn’t support.');

  const params = algorithm.children?.[1];
  const kdf = params?.children?.[0];
  const scheme = params?.children?.[1];
  if (oidOf(kdf?.children?.[0]) !== OID_PBKDF2) {
    throw new Error('This certificate file uses a key derivation method Bloom doesn’t support.');
  }
  const kdfParams = kdf!.children![1]!.children ?? [];
  const salt = kdfParams[0]!.content;
  const iterations = intOf(kdfParams[1]);
  const prfNode = kdfParams.find((n) => n.tag === 0x10); // SEQUENCE
  const hash = PRF_HASH[oidOf(prfNode?.children?.[0]) ?? '1.2.840.113549.2.7'];
  const keyBytes = AES_KEY_BYTES[oidOf(scheme?.children?.[0]) ?? ''];
  const iv = scheme?.children?.[1]?.content;
  if (!hash || !keyBytes || !iv || !iterations) {
    throw new Error('This certificate file uses an encryption method Bloom doesn’t support.');
  }
  if (!password) throw new Pkcs12PasswordError('This certificate file is password-protected. Enter its password.');

  const subtle = globalThis.crypto.subtle;
  const baseKey = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash },
    baseKey,
    { name: 'AES-CBC', length: keyBytes * 8 },
    false,
    ['decrypt'],
  );
  try {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-CBC', iv: iv as BufferSource }, key, data as BufferSource));
  } catch {
    throw new Pkcs12PasswordError('Wrong password for this certificate file.');
  }
}
