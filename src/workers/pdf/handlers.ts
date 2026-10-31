/**
 * PdfWorkerApi on top of core.ts. Runs inside the worker, and in plain Node for tests.
 * Replies move their buffers (the worker is stateless and never reuses them).
 */

import { withTransfer } from '../rpc';
import type { PdfWorkerApi } from './api';
import {
  decryptDocument,
  encryptDocument,
  extractPageGroups,
  loadDocument,
  parseDocument,
  openDocument,
  saveDocumentBytes,
} from './core';
import { decodeDocument, encodeDocument, type EncodedDocument } from './docCodec';
import type { PDFDocumentData } from '@/engine/types';

function encodeForReply(doc: PDFDocumentData): { doc: EncodedDocument; buffers: ArrayBuffer[] } {
  return encodeDocument(doc);
}

function transferableBuffers(chunks: Uint8Array[]): ArrayBuffer[] {
  const set = new Set<ArrayBuffer>();
  for (const c of chunks) if (c.buffer instanceof ArrayBuffer) set.add(c.buffer);
  return Array.from(set);
}

export const pdfHandlers: PdfWorkerApi = {
  ping: async () => ({ ok: true }),

  async parse({ bytes }) {
    const { doc, buffers } = encodeForReply(await parseDocument(bytes));
    return withTransfer(doc, buffers);
  },

  async load({ bytes, password }) {
    const result = await loadDocument(bytes, password);
    const { doc, buffers } = encodeForReply(result.doc);
    return withTransfer(
      result.status === 'ready'
        ? { status: 'ready' as const, doc, permissions: result.permissions }
        : { status: 'password-required' as const, doc },
      buffers,
    );
  },

  async open({ doc, password }) {
    const opened = await openDocument(decodeDocument(doc), password);
    const { doc: encoded, buffers } = encodeForReply(opened.doc);
    return withTransfer({ doc: encoded, permissions: opened.permissions }, buffers);
  },

  async save({ doc, mode, modifiedKeys }) {
    const bytes = await saveDocumentBytes(decodeDocument(doc), mode, modifiedKeys);
    return withTransfer(bytes, transferableBuffers([bytes]));
  },

  async extractPages({ doc, groups }) {
    const out = await extractPageGroups(decodeDocument(doc), groups);
    return withTransfer(out, transferableBuffers(out));
  },

  async encrypt({ doc, options }) {
    const decoded = decodeDocument(doc);
    await encryptDocument(decoded, options);
    const { doc: encoded, buffers } = encodeForReply(decoded);
    return withTransfer(encoded, buffers);
  },

  async decrypt({ doc, password }) {
    const decrypted = await decryptDocument(decodeDocument(doc), password);
    const { doc: encoded, buffers } = encodeForReply(decrypted);
    return withTransfer(encoded, buffers);
  },
};
