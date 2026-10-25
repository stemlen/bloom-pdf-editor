/**
 * Bloom PDF Security Engine — shared types and interfaces (Phase 1).
 *
 * Document-level PDF security only. Digital signatures are out of scope.
 */

import type { PDFDict, PDFDocumentData, PDFObject, PDFRef } from '../types';

// ─── Encryption algorithms ──────────────────────────────────────────────────

export type EncryptionAlgorithm =
  | 'RC4-40'
  | 'RC4-128'
  | 'AES-128'
  | 'AES-256';

/** Standard Security Handler revision (R). */
export type EncryptionRevision = 2 | 3 | 4 | 5 | 6;

/** Encrypt dictionary /V value. */
export type EncryptionVersion = 1 | 2 | 4 | 5;

export type CryptFilterMethod = 'None' | 'V2' | 'AESV2' | 'AESV3' | 'Identity';

export interface CryptFilter {
  name: string;
  method: CryptFilterMethod;
  length?: number;
  authEvent?: string;
}

/**
 * Parsed /Encrypt dictionary (Standard Security Handler).
 * Public-key (PKCS#7) handlers are represented separately.
 */
export interface EncryptDictionary {
  filter: string;
  subFilter?: string;
  version: EncryptionVersion;
  revision: EncryptionRevision;
  /** Key length in bits (40–256). */
  length: number;
  O: Uint8Array;
  U: Uint8Array;
  /** AES-256 (R5/R6) only. */
  OE?: Uint8Array;
  UE?: Uint8Array;
  Perms?: Uint8Array;
  /** Permission flags (signed 32-bit). */
  P: number;
  encryptMetadata: boolean;
  stmF: string;
  strF: string;
  eff: string;
  cryptFilters: Map<string, CryptFilter>;
  /** Original PDF dict (for serialization). */
  dict: PDFDict;
  /** Indirect ref if Encrypt is an indirect object. */
  ref?: PDFRef;
}

export interface FileIdPair {
  permanent: Uint8Array;
  changing: Uint8Array;
}

export interface EncryptionContext {
  encrypt: EncryptDictionary;
  fileId: FileIdPair;
  /** File encryption key (after successful password auth). */
  fileKey: Uint8Array | null;
  /** Whether the authenticated password was the owner password. */
  isOwner: boolean;
  algorithm: EncryptionAlgorithm;
}

// ─── Permissions (ISO 32000 Table 22) ───────────────────────────────────────

export interface PdfPermissions {
  print: boolean;
  modify: boolean;
  copy: boolean;
  annotate: boolean;
  fillForms: boolean;
  accessibility: boolean;
  assemble: boolean;
  printHighQuality: boolean;
}

export const DEFAULT_PERMISSIONS: PdfPermissions = {
  print: true,
  modify: true,
  copy: true,
  annotate: true,
  fillForms: true,
  accessibility: true,
  assemble: true,
  printHighQuality: true,
};

export type RestrictedOperation =
  | 'print'
  | 'printHighQuality'
  | 'modify'
  | 'copy'
  | 'extract'
  | 'annotate'
  | 'fillForms'
  | 'accessibility'
  | 'assemble';

// ─── Password ───────────────────────────────────────────────────────────────

export type PasswordRole = 'user' | 'owner' | 'none';

export interface PasswordAuthResult {
  ok: boolean;
  role: PasswordRole;
  fileKey: Uint8Array | null;
  error?: string;
}

export interface PasswordOptions {
  userPassword?: string;
  ownerPassword?: string;
}

// ─── Encrypt / decrypt options ──────────────────────────────────────────────

export interface EncryptOptions {
  userPassword?: string;
  ownerPassword?: string;
  permissions?: Partial<PdfPermissions>;
  algorithm?: EncryptionAlgorithm;
  encryptMetadata?: boolean;
}

export interface DecryptOptions {
  password?: string;
  /** Prefer owner unlock when both passwords match (rare). */
  preferOwner?: boolean;
}

export interface SecurityOpenResult {
  doc: PDFDocumentData;
  context: EncryptionContext;
  permissions: PdfPermissions;
  role: PasswordRole;
}

// ─── Module interfaces (Phase 1 architecture) ───────────────────────────────

export interface IEncryptionEngine {
  parseEncryptDict(dict: PDFDict, resolve?: (obj: PDFObject) => PDFObject): EncryptDictionary;
  detectAlgorithm(enc: EncryptDictionary): EncryptionAlgorithm;
  computeObjectKey(fileKey: Uint8Array, objNum: number, genNum: number, algorithm: EncryptionAlgorithm): Uint8Array;
  decryptBytes(data: Uint8Array, key: Uint8Array, algorithm: EncryptionAlgorithm): Promise<Uint8Array>;
  encryptBytes(data: Uint8Array, key: Uint8Array, algorithm: EncryptionAlgorithm): Promise<Uint8Array>;
}

export interface IPasswordEngine {
  authenticate(enc: EncryptDictionary, fileId: FileIdPair, password: string): Promise<PasswordAuthResult>;
  createEncryptionKeys(options: EncryptOptions, fileId: FileIdPair): Promise<{
    encrypt: EncryptDictionary;
    fileKey: Uint8Array;
  }>;
  clearCache(): void;
}

export interface IPermissionEngine {
  parse(P: number, revision: EncryptionRevision): PdfPermissions;
  serialize(perms: PdfPermissions, revision: EncryptionRevision): number;
  allows(perms: PdfPermissions, op: RestrictedOperation): boolean;
  assertAllowed(perms: PdfPermissions, op: RestrictedOperation): void;
}

export interface ISecurityEngine {
  isEncrypted(doc: PDFDocumentData): boolean;
  inspectEncrypt(doc: PDFDocumentData): EncryptDictionary | null;
  open(doc: PDFDocumentData, password?: string): Promise<SecurityOpenResult>;
  encrypt(doc: PDFDocumentData, options: EncryptOptions): Promise<PDFDocumentData>;
  decrypt(doc: PDFDocumentData, password?: string): Promise<PDFDocumentData>;
  getPermissions(doc: PDFDocumentData): PdfPermissions | null;
}

/** Stub interfaces for later phases — defined here for architecture. */
export interface IPublicKeyEncryptionEngine {
  isPublicKeyHandler(enc: EncryptDictionary): boolean;
  listRecipients(doc: PDFDocumentData): Promise<RecipientInfo[]>;
  encryptForRecipients(
    doc: PDFDocumentData,
    recipients: RecipientCert[],
    options?: PublicKeyEncryptOptions,
  ): Promise<PDFDocumentData>;
  openWithPrivateKey(
    doc: PDFDocumentData,
    privateKey: CryptoKey,
    certificateDer?: Uint8Array,
  ): Promise<SecurityOpenResult>;
}

export interface RecipientCert {
  /** DER-encoded X.509 certificate. */
  certificateDer: Uint8Array;
  /** Optional display label. */
  label?: string;
}

export interface RecipientInfo {
  index: number;
  label: string;
  serialNumberHex?: string;
  subject?: string;
  /** Raw PKCS#7 / CMS recipient blob size. */
  cmsBytesLength: number;
}

export interface PublicKeyEncryptOptions {
  permissions?: Partial<PdfPermissions>;
  algorithm?: 'AES-128' | 'AES-256';
  encryptMetadata?: boolean;
}

export interface IMetadataEngine {
  readInfo(doc: PDFDocumentData): Record<string, string>;
  readXmp(doc: PDFDocumentData): string | null;
  editInfo(doc: PDFDocumentData, patch: Record<string, string | null>): PDFDocumentData;
  stripMetadata(doc: PDFDocumentData, options?: MetadataStripOptions): PDFDocumentData;
  validateMetadata(doc: PDFDocumentData): MetadataValidationResult;
}

export interface MetadataStripOptions {
  stripInfo?: boolean;
  stripXmp?: boolean;
  stripCustom?: boolean;
  preserveProducer?: boolean;
  preserveDates?: boolean;
}

export interface MetadataValidationResult {
  ok: boolean;
  hasInfo: boolean;
  hasXmp: boolean;
  infoKeys: string[];
  issues: string[];
}

export interface IEmbeddedFileSecurityEngine {
  listAttachments(doc: PDFDocumentData): EmbeddedAttachment[];
  getAttachmentBytes(doc: PDFDocumentData, name: string): Uint8Array | null;
  removeAttachment(doc: PDFDocumentData, name: string): boolean;
  removeAllAttachments(doc: PDFDocumentData): number;
  validateAttachments(doc: PDFDocumentData): AttachmentValidationResult;
  /** Hook for future malware scanners — returns findings without removing. */
  scanAttachments(
    doc: PDFDocumentData,
    scanner?: AttachmentScanner,
  ): Promise<AttachmentScanResult[]>;
}

export interface EmbeddedAttachment {
  name: string;
  description?: string;
  mimeType?: string;
  size?: number;
  creationDate?: string;
  modDate?: string;
  /** Object key of the embedded file stream. */
  streamKey?: string;
  source: 'Names' | 'FileAttachment' | 'EF';
  pageIndex?: number;
}

export interface AttachmentValidationResult {
  ok: boolean;
  count: number;
  issues: string[];
}

export type AttachmentScanner = (
  name: string,
  bytes: Uint8Array,
) => Promise<{ threat: boolean; detail?: string }>;

export interface AttachmentScanResult {
  name: string;
  threat: boolean;
  detail?: string;
}

export interface IJavaScriptSecurityEngine {
  findJavaScript(doc: PDFDocumentData): string[];
  analyze(doc: PDFDocumentData): ActionSecurityReport;
  removeJavaScript(doc: PDFDocumentData): ActionRemovalResult;
  disableActions(doc: PDFDocumentData, kinds?: ActionKind[]): ActionRemovalResult;
}

export type ActionKind =
  | 'JavaScript'
  | 'Launch'
  | 'OpenAction'
  | 'SubmitForm'
  | 'ResetForm'
  | 'ImportData'
  | 'Named'
  | 'URI'
  | 'GoTo'
  | 'GoToR'
  | 'Other';

export interface DetectedAction {
  kind: ActionKind;
  location: string;
  detail?: string;
  /** Object key if action lives in an indirect object. */
  objectKey?: string;
}

export interface ActionSecurityReport {
  actions: DetectedAction[];
  hasJavaScript: boolean;
  hasLaunch: boolean;
  hasOpenAction: boolean;
  hasSubmitForm: boolean;
  warnings: string[];
  summary: string;
}

export interface ActionRemovalResult {
  removed: number;
  disabled: number;
  locations: string[];
}

export interface IRedactionEngine {
  markRegion(
    doc: PDFDocumentData,
    pageIndex: number,
    rect: { x: number; y: number; width: number; height: number },
  ): PDFRef;
  applySecureRedactions(
    doc: PDFDocumentData,
    options?: SecureRedactionOptions,
  ): Promise<SecureRedactionResult>;
  verifyRedaction(doc: PDFDocumentData, forbidden: string[]): RedactionVerification;
}

export interface SecureRedactionOptions {
  /** Remove overlapping text operators (default true). */
  text?: boolean;
  /** Remove overlapping image Do operators (default true). */
  images?: boolean;
  /** Remove overlapping path/vector painting (default true). */
  vectors?: boolean;
  /** Remove annotations intersecting regions (default true). */
  annotations?: boolean;
  /** Remove form widgets intersecting regions (default true). */
  formFields?: boolean;
  /** Also strip document metadata (default false). */
  metadata?: boolean;
  /** Never paint black rectangles (always true for secure engine). */
  paintBlack?: false;
}

export interface SecureRedactionResult {
  pagesProcessed: number;
  textOperatorsRemoved: number;
  imageOperatorsRemoved: number;
  pathOperatorsRemoved: number;
  annotationsRemoved: number;
  formFieldsRemoved: number;
  metadataStripped: boolean;
}

export interface RedactionVerification {
  ok: boolean;
  found: string[];
}

export interface ISanitizationEngine {
  sanitize(doc: PDFDocumentData): Promise<{ doc: PDFDocumentData; report: string[] }>;
}

export interface IIntegrityScanner {
  scan(doc: PDFDocumentData): Promise<{ ok: boolean; issues: string[] }>;
}

export interface ISecureOptimizer {
  optimize(doc: PDFDocumentData): Promise<PDFDocumentData>;
}

export interface ISecurityPolicyEngine {
  listPolicies(): string[];
  applyPolicy(
    doc: PDFDocumentData,
    name: string,
    passwordOverrides?: { userPassword?: string; ownerPassword?: string },
  ): Promise<{ doc: PDFDocumentData; ownerPassword?: string; generatedOwnerPassword: boolean }>;
}

export interface ISecurityInspector {
  inspect(doc: PDFDocumentData): Promise<SecurityInspectionReport>;
}

export interface SecurityInspectionReport {
  encrypted: boolean;
  algorithm?: EncryptionAlgorithm;
  revision?: EncryptionRevision;
  permissions?: PdfPermissions;
  hasUserPassword: boolean;
  hasOwnerPassword: boolean;
  encryptMetadata?: boolean;
  recommendations: string[];
  summary: string;
}
