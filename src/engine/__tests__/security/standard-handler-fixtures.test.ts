/**
 * Standard security handler against real encrypted PDFs.
 *
 * The fixtures in ../fixtures/encryption were produced by qpdf (via pikepdf)
 * with user password "test123" and owner password "owner456"; the
 * owner-only files have an empty user password.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getPageContentBytes, parsePDF, securityEngine } from '@/engine';

const dir = join(__dirname, '..', 'fixtures', 'encryption');
const load = (name: string) => parsePDF(new Uint8Array(readFileSync(join(dir, name))));

const protectedFiles = [
  'rc4-40.pdf',
  'rc4-128.pdf',
  'rc4-128-r4.pdf',
  'aes-128.pdf',
  'aes-128-nometa.pdf',
  'aes-256.pdf',
];

describe('standard security handler (R2–R6 fixtures)', () => {
  for (const file of protectedFiles) {
    it(`${file}: opens with the user password`, async () => {
      const doc = await load(file);
      expect(securityEngine.isEncrypted(doc)).toBe(true);
      const opened = await securityEngine.open(doc, 'test123');
      expect(opened.role).toBe('user');
      expect(opened.doc.pages.length).toBe(1);
      const content = getPageContentBytes(opened.doc.pages[0], opened.doc.objects);
      expect(new TextDecoder('latin1').decode(content)).toContain('(Hello) Tj');
    });

    it(`${file}: opens with the owner password`, async () => {
      const opened = await securityEngine.open(await load(file), 'owner456');
      expect(opened.role).toBe('owner');
    });

    it(`${file}: rejects a wrong password and the empty password`, async () => {
      await expect(securityEngine.open(await load(file), 'wrong')).rejects.toThrow();
      await expect(securityEngine.open(await load(file), '')).rejects.toThrow();
    });
  }

  for (const file of ['owner-only-rc4.pdf', 'owner-only-aes128.pdf']) {
    it(`${file}: opens with no password and keeps its restrictions`, async () => {
      const opened = await securityEngine.open(await load(file), '');
      expect(opened.role).toBe('user');
      expect(opened.permissions.modify).toBe(false);
    });
  }
});
