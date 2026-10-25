/**
 * Security Engine — Phases 11–16 unit tests.
 */

import { describe, it, expect } from 'vitest';
import {
  PDFArray,
  PDFDict,
  PDFDocumentData,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  PDFString,
} from '../types';
import {
  securityEngine,
  stringToPdfBytes,
  enterpriseSecurity,
} from '../security';

function makeDoc(opts?: { withJs?: boolean }): PDFDocumentData {
  const objects = new Map<string, import('../types').PDFObject>();
  const catalogRef = new PDFRef(1, 0);
  const pagesRef = new PDFRef(2, 0);
  const pageRef = new PDFRef(3, 0);
  const contentRef = new PDFRef(4, 0);
  const infoRef = new PDFRef(5, 0);
  const orphanRef = new PDFRef(99, 0);

  const catalog = new PDFDict();
  catalog.set('Type', new PDFName('Catalog'));
  catalog.set('Pages', pagesRef);
  if (opts?.withJs) {
    const js = new PDFDict();
    js.set('S', new PDFName('JavaScript'));
    js.set('JS', new PDFString('app.alert(1)'));
    catalog.set('OpenAction', js);
  }
  objects.set(catalogRef.toKey(), catalog);

  const pages = new PDFDict();
  pages.set('Type', new PDFName('Pages'));
  pages.set('Kids', new PDFArray([pageRef]));
  pages.set('Count', new PDFNumber(1));
  objects.set(pagesRef.toKey(), pages);

  const contentBytes = stringToPdfBytes('BT (Hello) Tj ET');
  objects.set(
    contentRef.toKey(),
    new PDFStream(new PDFDict([['Length', new PDFNumber(contentBytes.length)]]), contentBytes, contentBytes),
  );

  const page = new PDFDict();
  page.set('Type', new PDFName('Page'));
  page.set('Parent', pagesRef);
  page.set('MediaBox', new PDFArray([
    new PDFNumber(0), new PDFNumber(0), new PDFNumber(612), new PDFNumber(792),
  ]));
  page.set('Contents', contentRef);
  page.set('Annots', new PDFArray([]));
  objects.set(pageRef.toKey(), page);

  const info = new PDFDict();
  info.set('Author', new PDFString('Secret Author'));
  info.set('Title', new PDFString('Doc'));
  objects.set(infoRef.toKey(), info);

  // Orphan unused object
  objects.set(orphanRef.toKey(), new PDFDict([['Foo', new PDFString('bar')]]));

  const trailerDict = new PDFDict();
  trailerDict.set('Size', new PDFNumber(100));
  trailerDict.set('Root', catalogRef);
  trailerDict.set('Info', infoRef);

  return {
    version: '1.7',
    catalog,
    objects,
    pages: [{
      index: 0,
      ref: pageRef,
      dict: page,
      mediaBox: { x: 0, y: 0, width: 612, height: 792 },
      cropBox: { x: 0, y: 0, width: 612, height: 792 },
      rotate: 0,
      contentRefs: [contentRef],
      resources: new PDFDict(),
    }],
    xref: { entries: new Map(), trailerDict },
    info: { author: 'Secret Author', title: 'Doc' },
    rawBytes: new Uint8Array(0),
  };
}

describe('Phase 11 — Sanitization', () => {
  it('removes metadata and javascript', async () => {
    const doc = makeDoc({ withJs: true });
    const { report, detail } = await securityEngine.sanitization.sanitize(doc);
    expect(detail.metadataRemoved).toBe(true);
    expect(detail.javascriptRemoved).toBeGreaterThanOrEqual(1);
    expect(Object.keys(securityEngine.metadata.readInfo(doc)).length).toBe(0);
    expect(securityEngine.javascript.analyze(doc).hasJavaScript).toBe(false);
    expect(report.length).toBeGreaterThan(0);
  });
});

describe('Phase 12 — Integrity Scanner', () => {
  it('reports document structure', () => {
    const doc = makeDoc();
    const report = securityEngine.integrity.inspect(doc);
    expect(report.pageCount).toBe(1);
    expect(report.objectCount).toBeGreaterThan(0);
    expect(report.hasInfo).toBe(true);
  });
});

describe('Phase 13 — Security Inspector', () => {
  it('produces full Acrobat-style report', async () => {
    const doc = makeDoc({ withJs: true });
    const report = await securityEngine.inspector.inspectFull(doc);
    expect(report.encrypted).toBe(false);
    expect(report.javascript.present).toBe(true);
    expect(report.score).toBeGreaterThan(0);
    expect(report.recommendations.length).toBeGreaterThan(0);
    expect(report.summary).toContain('Unencrypted');
  });
});

describe('Phase 14 — Secure Optimizer', () => {
  it('removes unused objects while preserving structure', async () => {
    const doc = makeDoc();
    expect(doc.objects.has('99_0')).toBe(true);
    const report = await securityEngine.optimizer.optimizeWithReport(doc);
    expect(report.beforeObjects).toBeGreaterThan(report.afterObjects);
    expect(doc.objects.has('99_0')).toBe(false);
    expect(doc.objects.has('1_0')).toBe(true);
    expect(report.notes.length).toBeGreaterThan(0);
  });
});

describe('Phase 15 — Policy Engine', () => {
  it('lists built-in policies', () => {
    const names = securityEngine.policy.listPolicies();
    expect(names).toContain('Confidential');
    expect(names).toContain('Sanitized Export');
    expect(names).toContain('No Print');
  });

  it('applies Sanitized Export policy', async () => {
    const doc = makeDoc({ withJs: true });
    await securityEngine.policy.applyPolicy(doc, 'Sanitized Export');
    expect(securityEngine.javascript.analyze(doc).hasJavaScript).toBe(false);
    expect(Object.keys(securityEngine.metadata.readInfo(doc)).length).toBe(0);
  });

  it('refuses Confidential without an open password', async () => {
    const doc = makeDoc({});
    await expect(securityEngine.policy.applyPolicy(doc, 'Confidential')).rejects.toThrow(/open password/);
  });

  it('generates a strong, unique owner password instead of a built-in one', async () => {
    const a = await securityEngine.policy.applyPolicy(makeDoc({}), 'Read Only');
    const b = await securityEngine.policy.applyPolicy(makeDoc({}), 'Read Only');
    expect(a.generatedOwnerPassword).toBe(true);
    expect(a.ownerPassword).toHaveLength(20);
    expect(a.ownerPassword).not.toBe(b.ownerPassword);
    expect(a.ownerPassword).not.toBe('owner');
  });

  it('uses the supplied owner password', async () => {
    const r = await securityEngine.policy.applyPolicy(makeDoc({}), 'Confidential', {
      userPassword: 'open-me',
      ownerPassword: 'my-owner-pw',
    });
    expect(r.generatedOwnerPassword).toBe(false);
    expect(r.ownerPassword).toBe('my-owner-pw');
  });
});

describe('Phase 16 — Enterprise', () => {
  it('lists permission templates and key providers', () => {
    expect(enterpriseSecurity.listPermissionTemplates().length).toBeGreaterThan(0);
    expect(enterpriseSecurity.keyProviders.some((p) => p.id === 'software')).toBe(true);
  });

  it('batch sanitizes documents', async () => {
    const a = makeDoc({ withJs: true });
    const b = makeDoc({ withJs: true });
    const results = await enterpriseSecurity.batchSanitize([
      { id: 'a', doc: a, label: 'A' },
      { id: 'b', doc: b, label: 'B' },
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(securityEngine.javascript.analyze(a).hasJavaScript).toBe(false);
    expect(enterpriseSecurity.getAuditLog().length).toBeGreaterThan(0);
  });

  it('inherits policies', () => {
    const child = enterpriseSecurity.inheritPolicy('Confidential', {
      name: 'Confidential-NoPrint',
      encryption: {
        algorithm: 'AES-256',
        userPassword: 'x',
        ownerPassword: 'y',
        permissions: { print: false, printHighQuality: false, modify: false, copy: false, annotate: false, fillForms: false, accessibility: true, assemble: false },
      },
    });
    expect(child.name).toBe('Confidential-NoPrint');
    expect(child.stripMetadata).toBe(true);
  });
});
