/**
 * Main-thread entry point for heavy PDF work. Callers use a PdfBackend and never see where it
 * runs: normally a dedicated Web Worker, or the main thread when Workers are unavailable or the
 * worker fails at the transport level (script failed to load, crashed, couldn't clone a message).
 * Every operation is stateless, so retrying on the main thread after a transport failure is safe.
 * Errors thrown by the engine itself are rethrown as-is and never trigger the fallback.
 */

import type { EncryptOptions, PdfPermissions } from '@/engine/security/types';
import type { PDFDocumentData } from '@/engine/types';
import { createRpcClient, RpcTransportError, type RpcClient } from '../rpc';
import type { PdfSaveMode, PdfWorkerApi } from './api';
import type { LoadResult } from './core';
import { decodeDocument, encodeDocument } from './docCodec';

export type { LoadResult } from './core';
export type { PdfSaveMode } from './api';

export interface PdfBackend {
  readonly kind: 'worker' | 'main-thread';
  /** Structural parse only; encrypted files come back unopened (what `parsePDF` returns). */
  parse(bytes: Uint8Array): Promise<PDFDocumentData>;
  /** Parse bytes; for encrypted files try `password` (default empty). */
  load(bytes: Uint8Array, password?: string): Promise<LoadResult>;
  /** Decrypt a parsed encrypted document with `password`. Rejects on a wrong password. */
  open(doc: PDFDocumentData, password: string): Promise<{ doc: PDFDocumentData; permissions: PdfPermissions }>;
  save(doc: PDFDocumentData, mode: PdfSaveMode, modifiedKeys?: Iterable<string>): Promise<Uint8Array>;
  /** One PDF per group of 0-based page indices. */
  extractPages(doc: PDFDocumentData, groups: number[][]): Promise<Uint8Array[]>;
  /** Encrypt `doc` in place. */
  encrypt(doc: PDFDocumentData, options: EncryptOptions): Promise<void>;
  /** Remove encryption from `doc` in place. */
  decrypt(doc: PDFDocumentData, password: string): Promise<void>;
}

/** Replace the contents of `target` with `source`, keeping `target`'s identity and `objects` Map. */
export function adoptDocument(target: PDFDocumentData, source: PDFDocumentData): void {
  if (target === source) return;
  target.objects.clear();
  for (const [k, v] of source.objects) target.objects.set(k, v);
  target.version = source.version;
  target.xref = source.xref;
  target.catalog = source.catalog;
  target.pages = source.pages;
  target.info = source.info;
  target.rawBytes = source.rawBytes;
}

function encodeForWorker(doc: PDFDocumentData) {
  try {
    return encodeDocument(doc).doc;
  } catch (err) {
    throw new RpcTransportError(err instanceof Error ? err.message : 'could not encode document');
  }
}

class MainThreadBackend implements PdfBackend {
  readonly kind = 'main-thread' as const;
  private core = () => import('./core');

  async parse(bytes: Uint8Array) {
    return (await this.core()).parseDocument(bytes);
  }
  async load(bytes: Uint8Array, password?: string) {
    return (await this.core()).loadDocument(bytes, password);
  }
  async open(doc: PDFDocumentData, password: string) {
    return (await this.core()).openDocument(doc, password);
  }
  async save(doc: PDFDocumentData, mode: PdfSaveMode, modifiedKeys?: Iterable<string>) {
    return (await this.core()).saveDocumentBytes(doc, mode, modifiedKeys);
  }
  async extractPages(doc: PDFDocumentData, groups: number[][]) {
    return (await this.core()).extractPageGroups(doc, groups);
  }
  async encrypt(doc: PDFDocumentData, options: EncryptOptions) {
    await (await this.core()).encryptDocument(doc, options);
  }
  async decrypt(doc: PDFDocumentData, password: string) {
    await (await this.core()).decryptDocument(doc, password);
  }
}

export interface PdfConnection {
  api: RpcClient<PdfWorkerApi>;
  close(): void;
}

/** Starts a connection; `onFatal` must be called if the transport dies later (crash, load failure). */
export type PdfConnect = (onFatal: (reason: string) => void) => PdfConnection;

/** Backend that talks to a PdfWorkerApi over RPC and falls back to the main thread on transport failure. */
class RpcBackend implements PdfBackend {
  readonly kind = 'worker' as const;
  private readonly fallback = new MainThreadBackend();
  private connection: PdfConnection | null = null;
  private broken = false;

  constructor(private readonly start: PdfConnect) {}

  private connect(): RpcClient<PdfWorkerApi> {
    if (this.connection) return this.connection.api;
    const connection = this.start((reason) => {
      console.warn(`[Bloom] PDF worker unavailable (${reason}); using the main thread.`);
      this.broken = true;
    });
    this.connection = connection;
    return connection.api;
  }

  private async run<T>(
    viaWorker: (api: RpcClient<PdfWorkerApi>) => Promise<T>,
    viaMainThread: () => Promise<T>,
  ): Promise<T> {
    if (!this.broken) {
      try {
        return await viaWorker(this.connect());
      } catch (err) {
        if (!(err instanceof RpcTransportError)) throw err;
        console.warn('[Bloom] PDF worker call failed; retrying on the main thread.', err);
        this.broken = true;
        this.terminate();
      }
    }
    return viaMainThread();
  }

  parse(bytes: Uint8Array): Promise<PDFDocumentData> {
    return this.run(
      async (api) => decodeDocument(await api.parse({ bytes })),
      () => this.fallback.parse(bytes),
    );
  }

  load(bytes: Uint8Array, password?: string): Promise<LoadResult> {
    return this.run(
      async (api) => {
        const res = await api.load({ bytes, password });
        const doc = decodeDocument(res.doc);
        return res.status === 'ready'
          ? { status: 'ready', doc, permissions: res.permissions }
          : { status: 'password-required', doc };
      },
      () => this.fallback.load(bytes, password),
    );
  }

  open(doc: PDFDocumentData, password: string) {
    return this.run(
      async (api) => {
        const res = await api.open({ doc: encodeForWorker(doc), password });
        return { doc: decodeDocument(res.doc), permissions: res.permissions };
      },
      () => this.fallback.open(doc, password),
    );
  }

  save(doc: PDFDocumentData, mode: PdfSaveMode, modifiedKeys?: Iterable<string>) {
    return this.run(
      (api) =>
        api.save({
          doc: encodeForWorker(doc),
          mode,
          modifiedKeys: modifiedKeys ? Array.from(modifiedKeys) : undefined,
        }),
      () => this.fallback.save(doc, mode, modifiedKeys),
    );
  }

  extractPages(doc: PDFDocumentData, groups: number[][]) {
    return this.run(
      (api) => api.extractPages({ doc: encodeForWorker(doc), groups }),
      () => this.fallback.extractPages(doc, groups),
    );
  }

  encrypt(doc: PDFDocumentData, options: EncryptOptions) {
    return this.run(
      async (api) => {
        const res = await api.encrypt({ doc: encodeForWorker(doc), options });
        adoptDocument(doc, decodeDocument(res));
      },
      () => this.fallback.encrypt(doc, options),
    );
  }

  decrypt(doc: PDFDocumentData, password: string) {
    return this.run(
      async (api) => {
        const res = await api.decrypt({ doc: encodeForWorker(doc), password });
        adoptDocument(doc, decodeDocument(res));
      },
      () => this.fallback.decrypt(doc, password),
    );
  }

  terminate(): void {
    this.connection?.close();
    this.connection = null;
  }
}

function startWorker(onFatal: (reason: string) => void): PdfConnection {
  let worker: Worker;
  try {
    worker = new Worker(new URL('./pdf.worker.ts', import.meta.url), {
      type: 'module',
      name: 'bloom-pdf-worker',
    });
  } catch (err) {
    throw new RpcTransportError(err instanceof Error ? err.message : 'could not start worker');
  }
  const handle = createRpcClient<PdfWorkerApi>(worker);
  const fail = (reason: string) => {
    onFatal(reason);
    handle.fail(reason);
    worker.terminate();
  };
  worker.addEventListener('error', (e) => fail((e as ErrorEvent).message || 'worker error'));
  worker.addEventListener('messageerror', () => fail('message could not be deserialized'));
  return {
    api: handle.api,
    close() {
      handle.dispose();
      worker.terminate();
    },
  };
}

const WORKER_OPT_OUT_KEY = 'bloom:pdf-worker';

function workersAllowed(): boolean {
  if (typeof Worker === 'undefined') return false;
  try {
    return globalThis.localStorage?.getItem(WORKER_OPT_OUT_KEY) !== 'off';
  } catch {
    return true;
  }
}

let shared: PdfBackend | null = null;

/** The process-wide backend. Set localStorage `bloom:pdf-worker` to `off` to force the main thread. */
export function getPdfBackend(): PdfBackend {
  if (!shared) shared = workersAllowed() ? new RpcBackend(startWorker) : new MainThreadBackend();
  return shared;
}

/** Test seam: an RPC-backed backend over any connection (e.g. an in-process MessageChannel). */
export function createRpcBackend(start: PdfConnect): PdfBackend {
  return new RpcBackend(start);
}

/** Test seam: build a backend without touching the shared instance. */
export function createMainThreadBackend(): PdfBackend {
  return new MainThreadBackend();
}
