/**
 * Phase 13 — Long-Term Validation (LTV) engine.
 * Embeds certificate chains (+ optional OCSP/CRL) into DSS for offline validation.
 */

import type { PDFDocumentData } from '../../types';
import { listSignatureFields } from '../fields/signature-field';
import { extractPdfSignatureDict } from '../validation/validation-engine';
import { parseCMSSignedData, parseDERNode } from '../crypto/signature-verify';
import {
  embedDssIncremental,
  readDssSummary,
  type DssBuildResult,
} from './dss-builder';
import type { ASN1Node } from '../crypto/types';

export interface LtvEnableOptions {
  /** Extra certificates beyond those embedded in CMS. */
  extraCertificates?: Uint8Array[];
  /** OCSP responses (DER). Placeholder until live fetch is wired. */
  ocspResponses?: Uint8Array[];
  /** CRLs (DER). */
  crls?: Uint8Array[];
}

export interface LtvStatus {
  enabled: boolean;
  certCount: number;
  ocspCount: number;
  crlCount: number;
  offlineReady: boolean;
  summary: string;
}

function wrapCertNode(node: ASN1Node): Uint8Array {
  const inner = node.content;
  const len = inner.length;
  if (len < 0x80) {
    const r = new Uint8Array(2 + len);
    r[0] = 0x30;
    r[1] = len;
    r.set(inner, 2);
    return r;
  }
  if (len < 0x100) {
    const r = new Uint8Array(3 + len);
    r[0] = 0x30;
    r[1] = 0x81;
    r[2] = len;
    r.set(inner, 3);
    return r;
  }
  const r = new Uint8Array(4 + len);
  r[0] = 0x30;
  r[1] = 0x82;
  r[2] = (len >> 8) & 0xff;
  r[3] = len & 0xff;
  r.set(inner, 4);
  return r;
}

/** Collect certificates already present in signature CMS blobs. */
export function collectEmbeddedCertificates(doc: PDFDocumentData): Uint8Array[] {
  const out: Uint8Array[] = [];
  const seen = new Set<string>();

  for (const field of listSignatureFields(doc)) {
    if (!field.signed) continue;
    const dict = extractPdfSignatureDict(doc, field);
    if (!dict) continue;
    try {
      const cms = parseCMSSignedData(dict.contents);
      for (const certNode of cms.certificates) {
        const der = wrapCertNode(certNode);
        const key = Array.from(der.slice(0, 32)).join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(der);
      }
    } catch {
      // skip corrupt CMS
    }
  }

  return out;
}

/**
 * Enable LTV by embedding DSS with certs (+ optional OCSP/CRL).
 * Uses incremental update so prior signatures remain valid.
 */
export function enableLongTermValidation(
  doc: PDFDocumentData,
  options: LtvEnableOptions = {},
): DssBuildResult {
  const fromCms = collectEmbeddedCertificates(doc);
  const certificates = [...fromCms, ...(options.extraCertificates ?? [])];

  if (certificates.length === 0 && !options.ocspResponses?.length && !options.crls?.length) {
    throw new Error('No certificates or revocation data to embed for LTV');
  }

  return embedDssIncremental(doc, {
    certificates,
    ocspResponses: options.ocspResponses,
    crls: options.crls,
  });
}

/** Summarize LTV / DSS state for UI. */
export function getLtvStatus(doc: PDFDocumentData): LtvStatus {
  const summary = readDssSummary(doc);
  if (!summary || !summary.present) {
    return {
      enabled: false,
      certCount: 0,
      ocspCount: 0,
      crlCount: 0,
      offlineReady: false,
      summary: 'Long-term validation is off. Turn it on so the signature can be checked offline later.',
    };
  }

  const offlineReady = summary.certCount > 0;
  return {
    enabled: true,
    certCount: summary.certCount,
    ocspCount: summary.ocspCount,
    crlCount: summary.crlCount,
    offlineReady,
    summary: offlineReady
      ? `Long-term validation is on: ${summary.certCount} ${summary.certCount === 1 ? 'certificate' : 'certificates'}` +
        (summary.ocspCount ? `, ${summary.ocspCount} ${summary.ocspCount === 1 ? 'status response' : 'status responses'}` : '') +
        (summary.crlCount ? `, ${summary.crlCount} ${summary.crlCount === 1 ? 'revocation list' : 'revocation lists'}` : '') +
        ' embedded.'
      : 'Long-term validation data is present but empty.',
  };
}

/** Placeholder OCSP fetch — returns null (network optional later). */
export async function fetchOcspPlaceholder(
  _certificateDer: Uint8Array,
): Promise<Uint8Array | null> {
  return null;
}

void parseDERNode;
