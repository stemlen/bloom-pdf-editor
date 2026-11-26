/**
 * Encrypted documents keep plaintext objects in memory and are encrypted when
 * written (doc.encryptionKey + trailer /Encrypt).
 *
 * Regressions covered:
 *  - opening a password-protected PDF, editing it and saving produced a file
 *    whose pages were blank in every reader (plaintext objects behind /Encrypt);
 *  - "Encrypt PDF" turned the live document into ciphertext, so other pages
 *    rendered blank (or crashed the tab) and later edits were saved unencrypted;
 *  - "Remove encryption" on an opened file decrypted it a second time.
 *
 * Output is checked with pdf.js, an independent reader.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  appendIncrementalUpdate,
  getPageContentBytes,
  parsePDF,
  PDFStream,
  saveOptimized,
  saveQuick,
  securityEngine,
} from '@/engine';
import type { PDFDocumentData } from '@/engine';
import { createRpcClient, exposeRpc, type RpcEndpoint } from '@/workers/rpc';
import { pdfHandlers } from '@/workers/pdf/handlers';
import { createRpcBackend } from '@/workers/pdf/client';
import type { PdfWorkerApi } from '@/workers/pdf/api';

const fixtures = join(__dirname, '..', 'fixtures');
const read = (rel: string) => new Uint8Array(readFileSync(join(fixtures, rel)));
const latin1 = (b: Uint8Array) => new TextDecoder('latin1').decode(b);

async function pdfjsText(bytes: Uint8Array, password?: string): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), password, verbosity: 0 }).promise;
  let text = '';
  for (let p = 1; p <= doc.numPages; p++) {
    const items = (await (await doc.getPage(p)).getTextContent()).items;
    text += items.map((i) => ('str' in i ? i.str : '')).join(' ') + '\n';
  }
  return text;
}

/** Replace page 1's content with `edit(content)`, stored unfiltered. Returns the stream key. */
function editPage1(doc: PDFDocumentData, edit: (content: string) => string): string {
  const page = doc.pages[0];
  const ref = page.contentRefs[0];
  const stream = doc.objects.get(ref.toKey()) as PDFStream;
  const next = new TextEncoder().encode(edit(latin1(getPageContentBytes(page, doc.objects))));
  stream.dict.delete('Filter');
  stream.dict.delete('DecodeParms');
  stream.rawBytes = next;
  stream.decodedBytes = next;
  return ref.toKey();
}

const protectedFiles: [string, string][] = [
  ['rc4-40.pdf', 'test123'],
  ['rc4-128.pdf', 'test123'],
  ['rc4-128-r4.pdf', 'test123'],
  ['aes-128.pdf', 'test123'],
  ['aes-128-nometa.pdf', 'test123'],
  ['aes-256.pdf', 'test123'],
  ['owner-only-rc4.pdf', ''],
  ['owner-only-aes128.pdf', ''],
];

describe('saving an opened password-protected PDF', () => {
  for (const [file, password] of protectedFiles) {
    it(`${file}: edits are kept and the file stays protected`, async () => {
      for (const write of ['optimized', 'quick'] as const) {
        const { doc } = await securityEngine.open(await parsePDF(read(`encryption/${file}`)), password);
        const key = editPage1(doc, (c) => c.replace('(Hello) Tj', '(Edited) Tj'));
        const out = write === 'optimized' ? await saveOptimized(doc) : await saveQuick(doc, new Set([key]));

        expect(latin1(out)).toContain('/Encrypt');
        if (password) await expect(pdfjsText(out)).rejects.toThrow(/password/i);
        expect(await pdfjsText(out, password)).toContain('Edited');

        const reopened = await securityEngine.open(await parsePDF(out), password);
        expect(latin1(getPageContentBytes(reopened.doc.pages[0], reopened.doc.objects))).toContain('(Edited) Tj');
      }
    });
  }

  it('the owner password still unlocks the saved file', async () => {
    const { doc } = await securityEngine.open(await parsePDF(read('encryption/aes-256.pdf')), 'test123');
    const out = await saveOptimized(doc);
    const opened = await securityEngine.open(await parsePDF(out), 'owner456');
    expect(opened.role).toBe('owner');
  });

  it('incremental updates refuse to append unencrypted objects', async () => {
    const { doc } = await securityEngine.open(await parsePDF(read('encryption/aes-128.pdf')), 'test123');
    const key = editPage1(doc, (c) => c);
    expect(() => appendIncrementalUpdate(doc, new Set([key]))).toThrow(/password/i);
  });
});

describe('Encrypt PDF (protect)', () => {
  for (const algorithm of ['AES-256', 'AES-128', 'RC4-128'] as const) {
    it(`${algorithm}: the live document stays readable and later edits are encrypted`, async () => {
      const doc = await parsePDF(read('editor/b-mixed-5pages.pdf'));
      const before = doc.pages.map((p) => latin1(getPageContentBytes(p, doc.objects)));
      await securityEngine.encrypt(doc, { userPassword: 'u1', ownerPassword: 'o1', algorithm });

      // Every page still decodes to the same content (it used to be ciphertext).
      expect(doc.pages.map((p) => latin1(getPageContentBytes(p, doc.objects)))).toEqual(before);

      editPage1(doc, (c) => c.replace(/\(([^)]*)\) Tj/, '(Added after protecting) Tj'));
      const out = await saveOptimized(doc);
      await expect(pdfjsText(out)).rejects.toThrow(/password/i);
      expect(await pdfjsText(out, 'u1')).toContain('Added after protecting');
      // The plaintext of the new content must not appear in the file.
      expect(latin1(out)).not.toContain('Added after protecting');
    });
  }

  it('Hindi text survives every cipher, read back by pdf.js', async () => {
    const original = read('fonts/j-unicode-hindi-emoji.pdf');
    const baseline = await pdfjsText(original);
    expect(baseline).toMatch(/[ऀ-ॿ]/);
    for (const algorithm of ['AES-256', 'AES-128', 'RC4-128'] as const) {
      const doc = await parsePDF(original);
      await securityEngine.encrypt(doc, { userPassword: 'हिंदी-पासवर्ड', ownerPassword: 'o1', algorithm });
      const out = await saveOptimized(doc);
      const pw = algorithm === 'AES-256' ? 'हिंदी-पासवर्ड' : 'o1';
      expect(await pdfjsText(out, pw)).toBe(baseline);
    }
  });
});

describe('Remove encryption', () => {
  it('on an opened file, decrypts once and keeps the content', async () => {
    for (const [file, password] of protectedFiles) {
      const { doc } = await securityEngine.open(await parsePDF(read(`encryption/${file}`)), password);
      await securityEngine.decrypt(doc, password);
      expect(securityEngine.isEncrypted(doc)).toBe(false);
      expect(doc.encryptionKey).toBeUndefined();
      const out = await saveOptimized(doc);
      expect(latin1(out)).not.toContain('/Encrypt');
      expect(await pdfjsText(out)).toContain('Hello');
    }
  });

  it('rejects a wrong password and leaves the protection in place', async () => {
    const { doc } = await securityEngine.open(await parsePDF(read('encryption/aes-128.pdf')), 'test123');
    await expect(securityEngine.decrypt(doc, 'wrong')).rejects.toThrow();
    expect(securityEngine.isEncrypted(doc)).toBe(true);
    expect(await pdfjsText(await saveOptimized(doc), 'test123')).toContain('Hello');
  });
});

describe('through the PDF worker', () => {
  it('the file key survives the worker boundary, so edits made on the main thread are saved encrypted', async () => {
    const { port1, port2 } = new MessageChannel();
    const stop = exposeRpc(pdfHandlers, port2 as unknown as RpcEndpoint);
    const handle = createRpcClient<PdfWorkerApi>(port1 as unknown as RpcEndpoint);
    const backend = createRpcBackend(() => ({ api: handle.api, close: () => handle.dispose() }));
    try {
      const loaded = await backend.load(read('encryption/rc4-128.pdf'), 'test123');
      expect(loaded.status).toBe('ready');
      const doc = loaded.doc;
      editPage1(doc, (c) => c.replace('(Hello) Tj', '(Edited) Tj'));
      const out = await backend.save(doc, 'optimized');
      await expect(pdfjsText(out)).rejects.toThrow(/password/i);
      expect(await pdfjsText(out, 'test123')).toContain('Edited');

      const plain = await parsePDF(read('editor/a-simple-1page.pdf'));
      await backend.encrypt(plain, { userPassword: 'u1', ownerPassword: 'o1', algorithm: 'AES-128' });
      expect(plain.encryptionKey).toBeInstanceOf(Uint8Array);
      expect(await pdfjsText(await backend.save(plain, 'optimized'), 'u1')).toContain('Bloom QA');
      await backend.decrypt(plain, 'u1');
      expect(plain.encryptionKey).toBeUndefined();
      expect(await pdfjsText(await backend.save(plain, 'optimized'))).toContain('Bloom QA');
    } finally {
      stop();
      handle.dispose();
      port1.close();
      port2.close();
    }
  });
});
