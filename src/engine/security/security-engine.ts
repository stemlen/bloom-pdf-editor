/**
 * SecurityEngine — facade for Bloom PDF document security (Phases 1–16).
 */

import type { PDFDocumentData } from '../types';
import type {
  EncryptDictionary,
  EncryptOptions,
  EncryptionContext,
  ISecurityEngine,
  PasswordRole,
  PdfPermissions,
  SecurityOpenResult,
} from './types';
import {
  getEncryptDictFromTrailer,
  isEncryptedTrailer,
  parseFileId,
} from './encryption/encrypt-dict';
import { detectAlgorithm } from './encryption/standard-handler';
import { decryptDocumentObjects } from './encryption/decrypt-pipeline';
import { encryptDocumentObjects } from './encryption/encrypt-pipeline';
import { encryptionEngine, EncryptionEngine } from './encryption/encryption-engine';
import { passwordEngine, PasswordEngine } from './password/password-engine';
import { permissionEngine, PermissionEngine } from './permissions/permission-engine';
import {
  publicKeyEncryptionEngine,
  PublicKeyEncryptionEngine,
} from './public-key/public-key-engine';
import { metadataEngine, MetadataEngine } from './metadata/metadata-engine';
import {
  embeddedFileSecurityEngine,
  EmbeddedFileSecurityEngine,
} from './embedded-files/embedded-file-engine';
import {
  javaScriptSecurityEngine,
  JavaScriptSecurityEngine,
} from './javascript/javascript-engine';
import { redactionEngine, RedactionEngine } from './redaction/redaction-engine';
import {
  sanitizationEngine,
  SanitizationEngine,
} from './sanitization/sanitization-engine';
import { integrityScanner, IntegrityScanner } from './integrity/integrity-scanner';
import { securityInspector, SecurityInspector } from './inspector/security-inspector';
import { secureOptimizer, SecureOptimizer } from './optimizer/secure-optimizer';
import {
  securityPolicyEngine,
  SecurityPolicyEngine,
} from './policy/policy-engine';
import {
  enterpriseSecurity,
  EnterpriseSecurityLayer,
} from './enterprise/enterprise-layer';

export class SecurityEngine implements ISecurityEngine {
  readonly encryption: EncryptionEngine;
  readonly password: PasswordEngine;
  readonly permissions: PermissionEngine;
  readonly publicKey: PublicKeyEncryptionEngine;
  readonly metadata: MetadataEngine;
  readonly embeddedFiles: EmbeddedFileSecurityEngine;
  readonly javascript: JavaScriptSecurityEngine;
  readonly redaction: RedactionEngine;
  readonly sanitization: SanitizationEngine;
  readonly integrity: IntegrityScanner;
  readonly optimizer: SecureOptimizer;
  readonly policy: SecurityPolicyEngine;
  readonly inspector: SecurityInspector;
  readonly enterprise: EnterpriseSecurityLayer;

  private contexts = new WeakMap<PDFDocumentData, EncryptionContext>();

  constructor() {
    this.encryption = encryptionEngine;
    this.password = passwordEngine;
    this.permissions = permissionEngine;
    this.publicKey = publicKeyEncryptionEngine;
    this.metadata = metadataEngine;
    this.embeddedFiles = embeddedFileSecurityEngine;
    this.javascript = javaScriptSecurityEngine;
    this.redaction = redactionEngine;
    this.sanitization = sanitizationEngine;
    this.integrity = integrityScanner;
    this.optimizer = secureOptimizer;
    this.policy = securityPolicyEngine;
    this.inspector = securityInspector;
    this.enterprise = enterpriseSecurity;
  }

  isEncrypted(doc: PDFDocumentData): boolean {
    return isEncryptedTrailer(doc.xref.trailerDict);
  }

  inspectEncrypt(doc: PDFDocumentData): EncryptDictionary | null {
    return getEncryptDictFromTrailer(doc.xref.trailerDict, doc.objects);
  }

  getContext(doc: PDFDocumentData): EncryptionContext | undefined {
    return this.contexts.get(doc);
  }

  async open(doc: PDFDocumentData, password = ''): Promise<SecurityOpenResult> {
    if (!this.isEncrypted(doc)) {
      const perms = this.permissions.merge();
      return {
        doc,
        context: {
          encrypt: null as unknown as EncryptDictionary,
          fileId: parseFileId(doc.xref.trailerDict),
          fileKey: null,
          isOwner: true,
          algorithm: 'AES-256',
        },
        permissions: perms,
        role: 'owner' as PasswordRole,
      };
    }

    const enc = this.inspectEncrypt(doc);
    if (!enc) throw new Error('Encrypted document missing /Encrypt dictionary');

    if (this.publicKey.isPublicKeyHandler(enc)) {
      throw new Error(
        'Public-key encrypted PDF — use securityEngine.publicKey.openWithPrivateKey()',
      );
    }

    const fileId = parseFileId(doc.xref.trailerDict);
    const auth = await this.password.authenticate(enc, fileId, password);
    if (!auth.ok || !auth.fileKey) {
      throw new Error(auth.error ?? 'Incorrect password');
    }

    const ctx: EncryptionContext = {
      encrypt: enc,
      fileId,
      fileKey: auth.fileKey,
      isOwner: auth.role === 'owner',
      algorithm: detectAlgorithm(enc),
    };

    // A document that is already open holds plaintext objects; decrypting them
    // again would garble them. Otherwise decrypt in place and keep the key so
    // the writer can encrypt again on save.
    if (!doc.encryptionKey) {
      await decryptDocumentObjects(doc, ctx);
      doc.encryptionKey = auth.fileKey;
    }
    this.contexts.set(doc, ctx);

    const rawPerms = this.permissions.fromEncryptDict(enc);
    const permissions = this.permissions.effectivePermissions(rawPerms, ctx.isOwner);

    return { doc, context: ctx, permissions, role: auth.role };
  }

  async encrypt(doc: PDFDocumentData, options: EncryptOptions = {}): Promise<PDFDocumentData> {
    if (this.isEncrypted(doc)) {
      throw new Error('Document is already encrypted — decrypt first or save a new copy');
    }
    const ctx = await encryptDocumentObjects(doc, options);
    this.contexts.set(doc, ctx);
    return doc;
  }

  async decrypt(doc: PDFDocumentData, password = ''): Promise<PDFDocumentData> {
    const result = await this.open(doc, password);
    result.doc.xref.trailerDict.delete('Encrypt');
    if (result.context.encrypt?.ref) {
      result.doc.objects.delete(result.context.encrypt.ref.toKey());
    }
    delete result.doc.encryptionKey;
    this.contexts.delete(result.doc);
    return result.doc;
  }

  getPermissions(doc: PDFDocumentData): PdfPermissions | null {
    const ctx = this.contexts.get(doc);
    if (ctx?.encrypt) {
      return this.permissions.effectivePermissions(
        this.permissions.fromEncryptDict(ctx.encrypt),
        ctx.isOwner,
      );
    }
    const enc = this.inspectEncrypt(doc);
    if (!enc) return null;
    return this.permissions.fromEncryptDict(enc);
  }

  assertOperation(
    doc: PDFDocumentData,
    op: Parameters<PermissionEngine['assertAllowed']>[1],
  ): void {
    const ctx = this.contexts.get(doc);
    if (ctx?.isOwner) return;
    const perms = this.getPermissions(doc);
    if (!perms) return;
    this.permissions.assertAllowed(perms, op);
  }
}

export const securityEngine = new SecurityEngine();
