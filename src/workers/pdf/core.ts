/**
 * Engine-facing operations on live documents. The worker handlers wrap these with the document
 * codec; the main-thread fallback backend calls them directly. One implementation, two homes,
 * so both paths behave identically.
 */

import { parsePDF } from '@/engine/parser/parser';
import { securityEngine } from '@/engine/security';
import type { EncryptOptions, PdfPermissions } from '@/engine/security/types';
import { saveQuick, saveOptimized } from '@/engine/writer/save-pipeline';
import { extractPages } from '@/engine/writer/page-operations';
import type { PDFDocumentData } from '@/engine/types';
import type { PdfSaveMode } from './api';

export type LoadResult =
  | { status: 'ready'; doc: PDFDocumentData; permissions: PdfPermissions | null }
  | { status: 'password-required'; doc: PDFDocumentData };

export function parseDocument(bytes: Uint8Array): Promise<PDFDocumentData> {
  return parsePDF(bytes);
}

export async function loadDocument(bytes: Uint8Array, password = ''): Promise<LoadResult> {
  const parsed = await parsePDF(bytes);
  if (!securityEngine.isEncrypted(parsed)) {
    return { status: 'ready', doc: parsed, permissions: null };
  }
  try {
    const opened = await securityEngine.open(parsed, password);
    return { status: 'ready', doc: opened.doc, permissions: opened.permissions };
  } catch {
    // Any failure to open with this password means the caller must ask for one.
    return { status: 'password-required', doc: parsed };
  }
}

export async function openDocument(
  doc: PDFDocumentData,
  password: string,
): Promise<{ doc: PDFDocumentData; permissions: PdfPermissions }> {
  const opened = await securityEngine.open(doc, password);
  return { doc: opened.doc, permissions: opened.permissions };
}

export async function saveDocumentBytes(
  doc: PDFDocumentData,
  mode: PdfSaveMode,
  modifiedKeys?: Iterable<string>,
): Promise<Uint8Array> {
  return mode === 'quick'
    ? saveQuick(doc, modifiedKeys ? new Set(modifiedKeys) : undefined)
    : saveOptimized(doc);
}

export async function extractPageGroups(doc: PDFDocumentData, groups: number[][]): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for (const group of groups) out.push(await saveQuick(extractPages(doc, group)));
  return out;
}

/** Encrypts in place, like `securityEngine.encrypt`. */
export async function encryptDocument(doc: PDFDocumentData, options: EncryptOptions): Promise<PDFDocumentData> {
  return securityEngine.encrypt(doc, options);
}

/** Decrypts in place, like `securityEngine.decrypt`. */
export async function decryptDocument(doc: PDFDocumentData, password: string): Promise<PDFDocumentData> {
  return securityEngine.decrypt(doc, password);
}
