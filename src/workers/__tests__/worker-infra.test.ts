/**
 * Worker infrastructure: RPC protocol, document codec, and backend parity.
 *
 * The "worker" side is the real pdfHandlers served over a MessageChannel, so messages go
 * through real structured clone and transfer semantics, exactly as with a Web Worker.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parsePDF } from '@/engine/parser/parser';
import { PDFDict, PDFNumber, PDFStream, PDFRef } from '@/engine/types';
import { serializeDocument } from '@/engine/writer/serializer';
import { saveQuick } from '@/engine/writer/save-pipeline';
import { securityEngine } from '@/engine/security';
import { createRpcClient, exposeRpc, withTransfer, RpcTransportError, type RpcEndpoint } from '../rpc';
import { decodeDocument, encodeDocument } from '../pdf/docCodec';
import { pdfHandlers } from '../pdf/handlers';
import type { PdfWorkerApi } from '../pdf/api';
import { adoptDocument, createMainThreadBackend, createRpcBackend, type PdfBackend } from '../pdf/client';

const fixtures = join(__dirname, '..', '..', 'engine', '__tests__', 'fixtures');
const read = (rel: string) => new Uint8Array(readFileSync(join(fixtures, rel)));
const plainFixtures = ['editor/a-simple-1page.pdf', 'editor/b-mixed-5pages.pdf', 'forms/e-form-fields.pdf', 'tables/invoice-table.pdf', 'fonts/j-unicode-hindi-emoji.pdf'];

function channel() {
  const { port1, port2 } = new MessageChannel();
  return { client: port1 as unknown as RpcEndpoint, server: port2 as unknown as RpcEndpoint, close: () => { port1.close(); port2.close(); } };
}

function inProcessBackend(): { backend: PdfBackend; close(): void } {
  const ch = channel();
  const stop = exposeRpc(pdfHandlers, ch.server);
  const handle = createRpcClient<PdfWorkerApi>(ch.client);
  const backend = createRpcBackend(() => ({ api: handle.api, close: () => handle.dispose() }));
  return { backend, close: () => { stop(); ch.close(); } };
}

describe('rpc', () => {
  const api = {
    add: async (a: number, b: number) => a + b,
    fail: async () => { const e = new Error('nope') as Error & { code: string }; e.name = 'CustomError'; e.code = 'E42'; throw e; },
    move: async (b: Uint8Array) => withTransfer(b, [b.buffer as ArrayBuffer]),
  };

  it('round-trips calls, errors (name/message/props) and unknown methods', async () => {
    const ch = channel();
    const stop = exposeRpc(api, ch.server);
    const { api: remote, dispose } = createRpcClient<typeof api>(ch.client);
    expect(await remote.add(2, 3)).toBe(5);
    await expect(remote.fail()).rejects.toMatchObject({ name: 'CustomError', message: 'nope', code: 'E42' });
    await expect((remote as unknown as Record<string, () => Promise<void>>).missing()).rejects.toThrow(/Unknown RPC method/);
    dispose();
    stop();
    ch.close();
  });

  it('transfers buffers instead of copying when asked', async () => {
    const ch = channel();
    const stop = exposeRpc(api, ch.server);
    const { api: remote, dispose } = createRpcClient<typeof api>(ch.client);
    const input = new Uint8Array([1, 2, 3, 4]);
    const out = await remote.move(withTransfer(input, [input.buffer as ArrayBuffer]));
    expect(Array.from(out)).toEqual([1, 2, 3, 4]);
    expect(input.byteLength).toBe(0);
    dispose();
    stop();
    ch.close();
  });

  it('rejects in-flight and later calls with a transport error after fail()', async () => {
    const ch = channel(); // nobody serves the other end
    const handle = createRpcClient<typeof api>(ch.client);
    const inFlight = handle.api.add(1, 1);
    handle.fail('boom');
    await expect(inFlight).rejects.toBeInstanceOf(RpcTransportError);
    await expect(handle.api.add(1, 1)).rejects.toBeInstanceOf(RpcTransportError);
    ch.close();
  });
});

describe('document codec', () => {
  for (const rel of plainFixtures) {
    it(`${rel}: survives structured clone and re-serializes identically`, async () => {
      const doc = await parsePDF(read(rel));
      const { doc: wire } = encodeDocument(doc);
      const back = decodeDocument(structuredClone(wire));

      expect(back.pages.length).toBe(doc.pages.length);
      expect(back.objects.size).toBe(doc.objects.size);
      expect(Buffer.from(await serializeDocument(back))).toEqual(Buffer.from(await serializeDocument(doc)));
      expect(Buffer.from(await saveQuick(back))).toEqual(Buffer.from(await saveQuick(doc)));
    });
  }

  it('preserves shared identity between objects, pages and catalog', async () => {
    const doc = await parsePDF(read('editor/b-mixed-5pages.pdf'));
    const back = decodeDocument(structuredClone(encodeDocument(doc).doc));
    for (const page of back.pages) {
      expect(back.objects.get(page.ref.toKey())).toBe(page.dict);
    }
    const rootRef = back.xref.trailerDict.getRef('Root');
    expect(rootRef && back.objects.get(rootRef.toKey())).toBe(back.catalog);
    expect(back.pages[0].ref).toBeInstanceOf(PDFRef);
    expect(back.pages[0].dict).toBeInstanceOf(PDFDict);
    const stream = [...back.objects.values()].find((o) => o instanceof PDFStream) as PDFStream;
    expect(stream.rawBytes).toBeInstanceOf(Uint8Array);
  });

  it('does not alias the source document (editing the copy leaves the original alone)', async () => {
    const doc = await parsePDF(read('editor/a-simple-1page.pdf'));
    const before = Buffer.from(await serializeDocument(doc));
    const back = decodeDocument(structuredClone(encodeDocument(doc).doc));
    back.pages[0].dict.set('Rotate', back.pages[0].dict.get('MediaBox')!);
    expect(Buffer.from(await serializeDocument(doc))).toEqual(before);
  });

  it('adoptDocument replaces contents in place and keeps the objects Map identity', async () => {
    const target = await parsePDF(read('editor/a-simple-1page.pdf'));
    const source = await parsePDF(read('editor/b-mixed-5pages.pdf'));
    const map = target.objects;
    adoptDocument(target, source);
    expect(target.objects).toBe(map);
    expect(target.pages.length).toBe(5);
    expect(Buffer.from(await serializeDocument(target))).toEqual(Buffer.from(await serializeDocument(source)));
  });
});

describe('worker backend parity with the main thread', () => {
  const main = createMainThreadBackend();

  it('load: same pages and same re-saved bytes', async () => {
    const { backend, close } = inProcessBackend();
    for (const rel of plainFixtures) {
      const a = await backend.load(read(rel));
      const b = await main.load(read(rel));
      expect(a.status).toBe('ready');
      expect(b.status).toBe('ready');
      expect(a.doc.pages.length).toBe(b.doc.pages.length);
      expect(Buffer.from(await serializeDocument(a.doc))).toEqual(Buffer.from(await serializeDocument(b.doc)));
    }
    close();
  });

  it('save quick and optimized: byte-identical to the main thread', async () => {
    const { backend, close } = inProcessBackend();
    for (const rel of plainFixtures) {
      const doc = await parsePDF(read(rel));
      for (const mode of ['quick', 'optimized'] as const) {
        const viaWorker = await backend.save(doc, mode);
        const viaMain = await main.save(doc, mode);
        expect(Buffer.from(viaWorker)).toEqual(Buffer.from(viaMain));
      }
    }
    close();
  });

  it('save quick with modified keys: byte-identical to the main thread', async () => {
    const { backend, close } = inProcessBackend();
    const doc = await parsePDF(read('editor/b-mixed-5pages.pdf'));
    doc.pages[1].dict.set('Rotate', new PDFNumber(90));
    const keys = new Set([doc.pages[1].ref.toKey()]);
    const viaWorker = await backend.save(doc, 'quick', keys);
    const viaMain = await main.save(doc, 'quick', keys);
    expect(Buffer.from(viaWorker)).toEqual(Buffer.from(viaMain));
    close();
  });

  it('save leaves the source document usable (nothing is transferred away)', async () => {
    const { backend, close } = inProcessBackend();
    const doc = await parsePDF(read('editor/a-simple-1page.pdf'));
    const rawLen = doc.rawBytes.byteLength;
    await backend.save(doc, 'optimized');
    expect(doc.rawBytes.byteLength).toBe(rawLen);
    const again = await backend.save(doc, 'quick');
    expect(again.byteLength).toBeGreaterThan(0);
    close();
  });

  it('extractPages: one PDF per group, same as the main thread', async () => {
    const { backend, close } = inProcessBackend();
    const doc = await parsePDF(read('editor/b-mixed-5pages.pdf'));
    const groups = [[0], [2], [1, 3]];
    const viaWorker = await backend.extractPages(doc, groups);
    const viaMain = await main.extractPages(doc, groups);
    expect(viaWorker.length).toBe(3);
    viaWorker.forEach((bytes, i) => expect(Buffer.from(bytes)).toEqual(Buffer.from(viaMain[i])));
    expect((await parsePDF(viaWorker[2])).pages.length).toBe(2);
    close();
  });

  const encDir = 'encryption/';
  it('load: encrypted file needs a password, then opens; wrong password rejects', async () => {
    const { backend, close } = inProcessBackend();
    const first = await backend.load(read(`${encDir}aes-256.pdf`));
    expect(first.status).toBe('password-required');
    expect(securityEngine.isEncrypted(first.doc)).toBe(true);

    await expect(backend.open(first.doc, 'wrong')).rejects.toThrow(/password/i);

    const opened = await backend.open(first.doc, 'test123');
    expect(opened.doc.pages.length).toBe(1);
    expect(opened.permissions).toBeTruthy();

    const direct = await backend.load(read(`${encDir}aes-256.pdf`), 'owner456');
    expect(direct.status).toBe('ready');
    close();
  });

  it('load: owner-only file opens with the empty password and keeps its restrictions', async () => {
    const { backend, close } = inProcessBackend();
    const res = await backend.load(read(`${encDir}owner-only-aes128.pdf`));
    expect(res.status).toBe('ready');
    if (res.status === 'ready') expect(res.permissions?.modify).toBe(false);
    close();
  });

  it('load: unencrypted file reports no permissions', async () => {
    const { backend, close } = inProcessBackend();
    const res = await backend.load(read('editor/a-simple-1page.pdf'));
    expect(res.status === 'ready' && res.permissions).toBeNull();
    close();
  });

  it('encrypt then decrypt in place reproduces a document that opens and round-trips', async () => {
    const { backend, close } = inProcessBackend();
    const doc = await parsePDF(read('editor/b-mixed-5pages.pdf'));
    const pristine = Buffer.from(await serializeDocument(doc));

    for (const algorithm of ['AES-256', 'AES-128', 'RC4-128'] as const) {
      const working = await parsePDF(read('editor/b-mixed-5pages.pdf'));
      await backend.encrypt(working, { userPassword: 'u1', ownerPassword: 'o1', algorithm });
      expect(securityEngine.isEncrypted(working)).toBe(true);
      await expect(backend.encrypt(working, {})).rejects.toThrow(/already encrypted/i);

      const bytes = await backend.save(working, 'optimized');
      const reopened = await backend.load(bytes, 'u1');
      expect(reopened.status).toBe('ready');
      expect(reopened.doc.pages.length).toBe(5);

      await backend.decrypt(working, 'u1');
      expect(securityEngine.isEncrypted(working)).toBe(false);
      const plainAgain = await backend.load(await backend.save(working, 'optimized'));
      expect(plainAgain.status).toBe('ready');
      expect(plainAgain.doc.pages.length).toBe(5);
    }
    expect(Buffer.from(await serializeDocument(doc))).toEqual(pristine);
    close();
  });

  it('engine errors propagate and do not trigger the fallback', async () => {
    const { backend, close } = inProcessBackend();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(backend.load(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    close();
  });

  it('falls back to the main thread when the transport fails, with identical results', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dead = createRpcClient<PdfWorkerApi>(channel().client);
    dead.fail('worker crashed');
    const backend = createRpcBackend(() => ({ api: dead.api, close: () => {} }));
    const doc = await parsePDF(read('editor/a-simple-1page.pdf'));
    const bytes = await backend.save(doc, 'optimized');
    expect(Buffer.from(bytes)).toEqual(Buffer.from(await main.save(doc, 'optimized')));
    const loaded = await backend.load(read('editor/b-mixed-5pages.pdf'));
    expect(loaded.doc.pages.length).toBe(5);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
