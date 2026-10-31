/**
 * Wire protocol of the PDF worker. Types only (no runtime imports), so the main thread can
 * import it without pulling engine code into its bundle.
 *
 * Every method is stateless: documents travel as EncodedDocument (see docCodec.ts) and results
 * come back the same way, so a worker crash or restart never loses editor state.
 */

import type { EncryptOptions, PdfPermissions } from '@/engine/security/types';
import type { EncodedDocument } from './docCodec';

export type { EncodedDocument } from './docCodec';
export type PdfSaveMode = 'quick' | 'optimized';

export type LoadResponse =
  | {
      status: 'ready';
      doc: EncodedDocument;
      /** Set only when the file was encrypted and has been opened. */
      permissions: PdfPermissions | null;
    }
  | {
      /** Encrypted and the supplied password did not open it; `doc` is the unopened parse. */
      status: 'password-required';
      doc: EncodedDocument;
    };

export interface OpenResponse {
  doc: EncodedDocument;
  permissions: PdfPermissions;
}

export interface PdfWorkerApi {
  /** Round-trip used to confirm the worker booted and its engine bundle loaded. */
  ping(): Promise<{ ok: true }>;
  /** Structural parse only. Encrypted files come back unopened. */
  parse(req: { bytes: Uint8Array }): Promise<EncodedDocument>;
  /** Parse; if encrypted, try `password` (default empty) to open it. */
  load(req: { bytes: Uint8Array; password?: string }): Promise<LoadResponse>;
  /** Authenticate and decrypt an already-parsed encrypted document. Throws on a wrong password. */
  open(req: { doc: EncodedDocument; password: string }): Promise<OpenResponse>;
  /** Serialize to PDF bytes. `modifiedKeys` only affects 'quick' (incremental) saves. */
  save(req: { doc: EncodedDocument; mode: PdfSaveMode; modifiedKeys?: string[] }): Promise<Uint8Array>;
  /** One output PDF per entry in `groups`; each group lists 0-based page indices to extract. */
  extractPages(req: { doc: EncodedDocument; groups: number[][] }): Promise<Uint8Array[]>;
  /** Encrypt; returns the encrypted document. Throws if already encrypted. */
  encrypt(req: { doc: EncodedDocument; options: EncryptOptions }): Promise<EncodedDocument>;
  /** Remove encryption using `password`; returns the decrypted document. */
  decrypt(req: { doc: EncodedDocument; password: string }): Promise<EncodedDocument>;
}
