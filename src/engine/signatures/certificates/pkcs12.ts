/**
 * Phase 9 — PKCS#12 / PFX import (browser WebCrypto).
 *
 * Supports unencrypted bags and password-protected files that use PBES2
 * (PBKDF2 + AES), the default of OpenSSL 3, macOS and current Windows.
 * Legacy Triple DES / RC2 encryption is reported with a clear message.
 */

import { parseDERNode, decodeOID } from '../crypto/signature-verify';
import type { ASN1Node } from '../crypto/types';
import { decryptPkcs12, encodeNode, octets, Pkcs12PasswordError } from './pkcs12-decrypt';
import {
  importPrivateKey,
  parseCertificateDer,
  type ImportedCertificateBundle,
  type CertificateInfo,
  type ImportedKeyMaterial,
} from './certificate-parser';

const OID_CERT_BAG = '1.2.840.113549.1.12.10.1.3';
const OID_KEY_BAG = '1.2.840.113549.1.12.10.1.1';
const OID_PKCS8_SHROUDED = '1.2.840.113549.1.12.10.1.2';
const OID_DATA = '1.2.840.113549.1.7.1';
const OID_ENCRYPTED_DATA = '1.2.840.113549.1.7.6';
const OID_X509_CERT = '1.2.840.113549.1.9.22.1';

function nodeOIDLocal(node: ASN1Node | undefined): string | null {
  if (!node || node.tag !== 0x06) return null;
  try {
    return decodeOID(node.content);
  } catch {
    return null;
  }
}

function findOctetString(node: ASN1Node): Uint8Array | null {
  if (node.tag === 0x04) return node.content;
  if (node.children) {
    for (const c of node.children) {
      const found = findOctetString(c);
      if (found) return found;
    }
  }
  return null;
}

async function walkSafeBags(
  node: ASN1Node,
  certificates: CertificateInfo[],
  keys: ImportedKeyMaterial[],
  password = '',
): Promise<void> {
  const oid = nodeOIDLocal(node.children?.[0]);
  if (oid === OID_CERT_BAG) {
    // certBag [0] EXPLICIT → CertBag → x509Certificate OCTET STRING
    const bagValue = node.children?.find((c) => c.class === 'context');
    const inner = bagValue?.children?.[0] ?? bagValue;
    const certType = nodeOIDLocal(inner?.children?.[0]);
    if (certType === OID_X509_CERT || !certType) {
      const oct = findOctetString(inner ?? node);
      if (oct && oct.length > 20) {
        try {
          certificates.push(await parseCertificateDer(oct, 'p12'));
        } catch {
          // skip non-cert payloads
        }
      }
    }
  } else if (oid === OID_KEY_BAG) {
    // keyBag [0] EXPLICIT PrivateKeyInfo (PKCS#8)
    const bagValue = node.children?.find((c) => c.class === 'context');
    const pkcs8 = bagValue?.children?.[0];
    if (pkcs8) {
      try {
        keys.push(await importPrivateKey(encodeNode(pkcs8)));
      } catch {
        // unsupported key type
      }
    }
    return;
  } else if (oid === OID_PKCS8_SHROUDED) {
    // pkcs8ShroudedKeyBag [0] EXPLICIT EncryptedPrivateKeyInfo { algorithm, encryptedData }
    const info = node.children?.find((c) => c.class === 'context')?.children?.[0];
    const algorithm = info?.children?.[0];
    const encrypted = info?.children?.[1];
    if (algorithm && encrypted) {
      const pkcs8 = await decryptPkcs12(algorithm, octets(encrypted), password);
      keys.push(await importPrivateKey(pkcs8));
    }
    return;
  }

  if (node.children) {
    for (const c of node.children) {
      await walkSafeBags(c, certificates, keys, password);
    }
  }
}

/**
 * Try Node.js crypto to decrypt PKCS#12 (full support with password).
 */
async function importPkcs12ViaNode(
  p12: Uint8Array,
  password: string,
  label: string,
): Promise<ImportedCertificateBundle | null> {
  try {
    const crypto = await import('crypto');
    if (typeof (crypto as { createPrivateKey?: unknown }).createPrivateKey !== 'function') {
      return null;
    }
    // Node 22+ has X509Certificate; PKCS12 unpack via openssl isn't built-in.
    // Use experimental / passphrase with forge-less approach:
    // `crypto` doesn't unpack p12 natively until recently.
    // Fall through — return null to use ASN.1 path.
    void crypto;
    void p12;
    void password;
    void label;
    return null;
  } catch {
    return null;
  }
}

/**
 * Import PKCS#12 / PFX bytes.
 * @param password optional; required for encrypted bags
 */
export async function importPkcs12(
  p12Bytes: Uint8Array,
  password = '',
  label = 'P12 import',
): Promise<ImportedCertificateBundle> {
  const viaNode = await importPkcs12ViaNode(p12Bytes, password, label);
  if (viaNode) return viaNode;

  const root = parseDERNode(p12Bytes, 0);
  // PFX ::= SEQUENCE { version, authSafe ContentInfo, macData OPTIONAL }
  const authSafe = root.children?.[1];
  const contentType = nodeOIDLocal(authSafe?.children?.[0]);

  const certificates: CertificateInfo[] = [];
  const keys: ImportedKeyMaterial[] = [];

  if (contentType === OID_ENCRYPTED_DATA) {
    throw new Error(
      'This certificate file is encrypted for a specific recipient, which Bloom can’t open. ' +
        'Export it as a password-protected P12 or as PEM instead.',
    );
  }

  if (contentType === OID_DATA || !contentType) {
    // content [0] EXPLICIT OCTET STRING of authenticatedSafe
    const content = authSafe?.children?.find((c) => c.class === 'context');
    const oct = findOctetString(content ?? authSafe ?? root);
    if (oct) {
      try {
        const safe = parseDERNode(oct, 0);
        // authenticatedSafe ::= SEQUENCE OF ContentInfo
        // Tags are stored without the constructed bit: SEQUENCE is 0x10.
        const bags = safe.tag === 0x10 && safe.children ? safe.children : [safe];
        for (const bag of bags) {
          const bagType = nodeOIDLocal(bag.children?.[0]);
          if (bagType === OID_DATA || !bagType) {
            const bagOct = findOctetString(
              bag.children?.find((c) => c.class === 'context') ?? bag,
            );
            if (bagOct) {
              try {
                const safeContents = parseDERNode(bagOct, 0);
                await walkSafeBags(safeContents, certificates, keys, password);
              } catch (e) {
                if (e instanceof Pkcs12PasswordError) throw e;
                await walkSafeBags(bag, certificates, keys, password);
              }
            }
          } else if (bagType === OID_ENCRYPTED_DATA) {
            // [0] EXPLICIT EncryptedData { version, EncryptedContentInfo { type, algorithm, [0] IMPLICIT content } }
            const encryptedData = bag.children?.find((c) => c.class === 'context')?.children?.[0];
            const eci = encryptedData?.children?.[1];
            const algorithm = eci?.children?.[1];
            const content = eci?.children?.find((c) => c.class === 'context');
            if (algorithm && content) {
              const plain = await decryptPkcs12(algorithm, octets(content), password);
              await walkSafeBags(parseDERNode(plain, 0), certificates, keys, password);
            }
          } else {
            await walkSafeBags(bag, certificates, keys);
          }
        }
      } catch (e) {
        if (e instanceof Pkcs12PasswordError || (e instanceof Error && /encryption|password/i.test(e.message))) throw e;
        // Try walking entire tree for cert OCTET STRINGs that look like certs
        await walkSafeBags(root, certificates, keys);
      }
    }
  }

  // Also scan entire PFX for embedded X.509 SEQUENCEs (heuristic)
  if (certificates.length === 0) {
    await harvestCertificates(root, certificates);
  }

  if (certificates.length === 0 && keys.length === 0) {
    throw new Error(
      'No certificate or private key was found in this file. Check that it is a .p12 or .pfx certificate file.',
    );
  }

  return {
    certificates,
    leaf: certificates[0] ?? null,
    key: keys[0] ?? null,
    chain: certificates,
    source: 'p12',
    label: certificates[0]?.subject.commonName ?? label,
  };
}

async function harvestCertificates(
  node: ASN1Node,
  out: CertificateInfo[],
): Promise<void> {
  if (node.tag === 0x04 && node.content.length > 64 && node.content[0] === 0x30) {
    try {
      out.push(await parseCertificateDer(node.content, 'p12'));
    } catch {
      // not a cert
    }
  }
  if (node.children) {
    for (const c of node.children) await harvestCertificates(c, out);
  }
}

/** Detect format from filename / magic. */
export function detectCertificateFileFormat(
  fileName: string,
  bytes?: Uint8Array,
): 'pem' | 'der' | 'p12' {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.pem') || lower.endsWith('.crt') || lower.endsWith('.cer')) {
    return 'pem';
  }
  if (lower.endsWith('.p12') || lower.endsWith('.pfx')) return 'p12';
  if (bytes && bytes.length > 0) {
    // PEM starts with '-'
    if (bytes[0] === 0x2d) return 'pem';
    // DER/PKCS12 start with SEQUENCE 0x30
    if (bytes[0] === 0x30) {
      // PKCS12 usually has version INTEGER 3 early
      return lower.endsWith('.der') ? 'der' : 'p12';
    }
  }
  return 'der';
}
