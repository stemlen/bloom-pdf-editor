/**
 * BE-601: AES-256 (V5/R6) PDFs written by Bloom must open in other readers.
 *
 * Bloom's own reader accepting the file proves nothing (it only has to agree
 * with itself), so these tests check the output three independent ways:
 *  - the /Encrypt entries against a Node `crypto` implementation of ISO 32000-2
 *    Algorithm 2.B, Algorithm 8/9 and the /Perms check,
 *  - qpdf and mutool (skipped when the binary is not installed),
 *  - pdf.js.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { createCipheriv, createDecipheriv, createHash } from 'crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  PDFDict,
  getPageContentBytes,
  parsePDF,
  saveOptimized,
  saveQuick,
  securityEngine,
  serializeDocument,
  serializeDocumentCompact,
} from '@/engine';
import type { EncryptDictionary } from '@/engine';

const fixtureDir = join(__dirname, '..', 'fixtures', 'editor');
const USER = 'user123';
const OWNER = 'owner456';

const load = (name: string) => parsePDF(new Uint8Array(readFileSync(join(fixtureDir, name))));

type Writer = (doc: Awaited<ReturnType<typeof load>>) => Promise<Uint8Array>;
const writers: Record<string, Writer> = {
  saveOptimized: (d) => saveOptimized(d),
  saveQuick: (d) => saveQuick(d),
  serializeDocument: (d) => serializeDocument(d),
  serializeDocumentCompact: (d) => serializeDocumentCompact(d),
};

async function encrypt(
  name: string,
  userPassword: string,
  ownerPassword: string,
  write: Writer = writers.saveOptimized,
): Promise<Uint8Array> {
  const doc = await load(name);
  await securityEngine.encrypt(doc, { userPassword, ownerPassword, algorithm: 'AES-256' });
  return write(doc);
}

/** ISO 32000-2 Algorithm 2.B, written against Node crypto rather than Bloom's own AES. */
function hash2B(password: Buffer, salt: Buffer, udata: Buffer = Buffer.alloc(0)): Buffer {
  let k = createHash('sha256').update(Buffer.concat([password, salt, udata])).digest();
  let e = Buffer.alloc(0);
  for (let i = 0; i < 64 || e[e.length - 1] > i - 32; i++) {
    const k1 = Buffer.concat(Array(64).fill(Buffer.concat([password, k, udata])));
    const cipher = createCipheriv('aes-128-cbc', k.subarray(0, 16), k.subarray(16, 32));
    cipher.setAutoPadding(false);
    e = Buffer.concat([cipher.update(k1), cipher.final()]);
    let mod = 0;
    for (let j = 0; j < 16; j++) mod = (mod * 256 + e[j]) % 3;
    k = createHash(['sha256', 'sha384', 'sha512'][mod]).update(e).digest();
  }
  return k.subarray(0, 32);
}

const aesNoPad = (algo: 'aes-256-cbc' | 'aes-256-ecb', key: Buffer, iv: Buffer | null, data: Buffer, decrypt: boolean) => {
  const c = decrypt ? createDecipheriv(algo, key, iv) : createCipheriv(algo, key, iv);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(data), c.final()]);
};

function binary(name: string): string | null {
  const r = spawnSync(name, ['--version'], { encoding: 'utf8' });
  return r.error ? null : name;
}
const qpdf = binary('qpdf');
const mutool = binary('mutool');

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'bloom-enc-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, bytes: Uint8Array): string {
  const p = join(dir, name);
  writeFileSync(p, bytes);
  return p;
}

describe('BE-601 · /Encrypt dictionary is spec-compliant R6', () => {
  let bytes: Uint8Array;
  let enc: EncryptDictionary;

  beforeAll(async () => {
    bytes = await encrypt('b-mixed-5pages.pdf', USER, OWNER);
    const reopened = await parsePDF(bytes);
    enc = securityEngine.inspectEncrypt(reopened)!;
  });

  it('declares V5 / R6 / AESV3 with correctly sized entries', () => {
    expect(enc.version).toBe(5);
    expect(enc.revision).toBe(6);
    expect(enc.filter).toBe('Standard');
    expect(enc.length).toBe(256);
    expect(enc.O).toHaveLength(48);
    expect(enc.U).toHaveLength(48);
    expect(enc.OE).toHaveLength(32);
    expect(enc.UE).toHaveLength(32);
    expect(enc.Perms).toHaveLength(16);
    expect(enc.stmF).toBe('StdCF');
    expect(enc.strF).toBe('StdCF');
    expect(enc.cryptFilters.get('StdCF')?.method).toBe('AESV3');
    expect(enc.dict.getBool('EncryptMetadata')).toBe(true);
  });

  it('/U validates the user password with Algorithm 2.B and /UE yields the file key', () => {
    const pw = Buffer.from(USER);
    const U = Buffer.from(enc.U);
    expect(hash2B(pw, U.subarray(32, 40)).equals(U.subarray(0, 32))).toBe(true);
    expect(hash2B(Buffer.from('wrong'), U.subarray(32, 40)).equals(U.subarray(0, 32))).toBe(false);

    const ik = hash2B(pw, U.subarray(40, 48));
    const fileKey = aesNoPad('aes-256-cbc', ik, Buffer.alloc(16), Buffer.from(enc.UE!), true);
    expect(fileKey).toHaveLength(32);

    // /Perms decrypts (AES-256 ECB, file key) to P, 0xFFFFFFFF, 'T', 'adb'.
    const perms = aesNoPad('aes-256-ecb', fileKey, null, Buffer.from(enc.Perms!), true);
    expect(perms.readInt32LE(0)).toBe(enc.P);
    expect(perms.subarray(4, 8).equals(Buffer.from([0xff, 0xff, 0xff, 0xff]))).toBe(true);
    expect(String.fromCharCode(perms[8])).toBe('T');
    expect(perms.subarray(9, 12).toString('latin1')).toBe('adb');
  });

  it('/O validates the owner password over the first 48 bytes of /U, and /OE yields the same key', () => {
    const pw = Buffer.from(OWNER);
    const U = Buffer.from(enc.U);
    const O = Buffer.from(enc.O);
    expect(hash2B(pw, O.subarray(32, 40), U).equals(O.subarray(0, 32))).toBe(true);

    const ownerKey = aesNoPad(
      'aes-256-cbc',
      hash2B(pw, O.subarray(40, 48), U),
      Buffer.alloc(16),
      Buffer.from(enc.OE!),
      true,
    );
    const userKey = aesNoPad(
      'aes-256-cbc',
      hash2B(Buffer.from(USER), U.subarray(40, 48)),
      Buffer.alloc(16),
      Buffer.from(enc.UE!),
      true,
    );
    expect(ownerKey.equals(userKey)).toBe(true);
  });

  it('keeps the trailer /ID and the /Encrypt dictionary strings unencrypted', async () => {
    const reopened = await parsePDF(bytes);
    expect(reopened.xref.trailerDict.getArray('ID')?.length).toBe(2);
    expect(reopened.xref.trailerDict.get('Encrypt')).toBeDefined();
    expect(enc.dict).toBeInstanceOf(PDFDict);
  });
});

describe('BE-601 · round-trip in Bloom', () => {
  for (const [label, write_] of Object.entries(writers)) {
    it(`${label}: reopens with the user and owner password`, async () => {
      const bytes = await encrypt('b-mixed-5pages.pdf', USER, OWNER, write_);
      const user = await securityEngine.open(await parsePDF(bytes), USER);
      expect(user.role).toBe('user');
      expect(user.doc.pages).toHaveLength(5);
      const text = new TextDecoder('latin1').decode(getPageContentBytes(user.doc.pages[0], user.doc.objects));
      expect(text).toMatch(/\bTj\b|\bTJ\b/);

      const owner = await securityEngine.open(await parsePDF(bytes), OWNER);
      expect(owner.role).toBe('owner');
      await expect(securityEngine.open(await parsePDF(bytes), 'nope')).rejects.toThrow();
    });
  }

  it('an empty user password opens without a prompt', async () => {
    const bytes = await encrypt('a-simple-1page.pdf', '', OWNER);
    const opened = await securityEngine.open(await parsePDF(bytes), '');
    expect(opened.role).toBe('user');
  });
});

describe('BE-601 · pdf.js', () => {
  for (const [label, write_] of Object.entries(writers)) {
    it(`${label}: asks for a password, then reads the text`, async () => {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const bytes = await encrypt('b-mixed-5pages.pdf', USER, OWNER, write_);
      const open = (password?: string) =>
        pdfjs.getDocument({ data: new Uint8Array(bytes), password, verbosity: 0 }).promise;

      await expect(open()).rejects.toThrow(/password/i);
      await expect(open('wrong')).rejects.toThrow(/password/i);
      for (const pw of [USER, OWNER]) {
        const doc = await open(pw);
        expect(doc.numPages).toBe(5);
        const items = (await (await doc.getPage(1)).getTextContent()).items;
        expect(items.map((i) => ('str' in i ? i.str : '')).join(' ')).toContain('Chapter 1');
      }
    });
  }
});

describe.skipIf(!qpdf)('BE-601 · qpdf', () => {
  const run = (...args: string[]) => spawnSync('qpdf', args, { encoding: 'utf8' });

  for (const [label, write_] of Object.entries(writers)) {
    it(`${label}: --check passes with the user and owner password`, async () => {
      const file = write(`${label}.pdf`, await encrypt('b-mixed-5pages.pdf', USER, OWNER, write_));

      const user = run('--check', `--password=${USER}`, file);
      expect(user.status, user.stdout + user.stderr).toBe(0);
      expect(user.stdout).toContain('R = 6');
      expect(user.stdout).toContain('Supplied password is user password');
      expect(user.stdout).toContain('stream encryption method: AESv3');
      expect(user.stdout).toContain('string encryption method: AESv3');
      expect(user.stderr).not.toMatch(/warning/i);

      const owner = run('--check', `--password=${OWNER}`, file);
      expect(owner.status, owner.stdout + owner.stderr).toBe(0);
      expect(owner.stdout).toContain('Supplied password is owner password');

      const wrong = run('--check', '--password=wrong', file);
      expect(wrong.status).toBe(2);
      expect(wrong.stderr).toMatch(/invalid password/i);
    });
  }

  it('--decrypt yields a plain PDF with the same pages and content', async () => {
    const src = join(fixtureDir, 'b-mixed-5pages.pdf');
    const file = write('to-decrypt.pdf', await encrypt('b-mixed-5pages.pdf', USER, OWNER));
    const out = join(dir, 'decrypted.pdf');

    const r = run(`--password=${USER}`, '--decrypt', file, out);
    expect(r.status, r.stderr).toBe(0);
    expect(run('--show-npages', out).stdout.trim()).toBe('5');
    expect(run('--is-encrypted', out).status).not.toBe(0);

    const plain = (f: string) => run('--qdf', '--object-streams=disable', '--static-id', f, '-').stdout;
    const normalise = (s: string) => s.replace(/^%.*$/gm, '').match(/\(([^()]*)\)\s*Tj/g)?.join('|');
    expect(normalise(plain(out))).toBeTruthy();
    expect(normalise(plain(out))).toBe(normalise(plain(src)));
  });

  it('an empty user password opens without a password', async () => {
    const file = write('owner-only.pdf', await encrypt('a-simple-1page.pdf', '', OWNER));
    const r = run('--check', file);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('User password = ');
    const owner = run('--check', `--password=${OWNER}`, file);
    expect(owner.stdout).toContain('Supplied password is owner password');
  });

  it('records the permissions chosen in the Protect panel', async () => {
    const doc = await load('a-simple-1page.pdf');
    await securityEngine.encrypt(doc, {
      userPassword: USER,
      ownerPassword: OWNER,
      algorithm: 'AES-256',
      permissions: { print: true, printHighQuality: true, copy: false, modify: false, annotate: false, fillForms: true, accessibility: true, assemble: false },
    });
    const file = write('perms.pdf', await saveOptimized(doc));
    const r = run('--show-encryption', `--password=${USER}`, file);
    expect(r.stdout).toContain('extract for any purpose: not allowed');
    expect(r.stdout).toContain('modify other: not allowed');
    expect(r.stdout).toContain('print high resolution: allowed');
  });
});

describe.skipIf(!mutool)('BE-601 · mutool', () => {
  for (const [label, write_] of Object.entries(writers)) {
    it(`${label}: opens and renders with the password, without repairing the file`, async () => {
      const file = write(`mu-${label}.pdf`, await encrypt('b-mixed-5pages.pdf', USER, OWNER, write_));
      for (const pw of [USER, OWNER]) {
        const r = spawnSync('mutool', ['draw', '-p', pw, '-r', '20', '-o', join(dir, `mu-${label}-%d.png`), file], {
          encoding: 'utf8',
        });
        expect(r.status, r.stderr).toBe(0);
        expect(r.stderr).not.toMatch(/repair|error|zlib|cannot/i);
      }
      const bad = spawnSync('mutool', ['draw', '-p', 'wrong', '-o', join(dir, 'bad-%d.png'), file], { encoding: 'utf8' });
      expect(bad.status).not.toBe(0);
    });
  }
});

describe('cross-reference table entries are exactly 20 bytes', () => {
  for (const [label, write_] of [
    ['serializeDocument', writers.serializeDocument],
    ['saveOptimized', writers.saveOptimized],
  ] as const) {
    it(label, async () => {
      const out = Buffer.from(await write_(await load('b-mixed-5pages.pdf'))).toString('latin1');
      const table = out.slice(out.lastIndexOf('\nxref\n') + 6, out.lastIndexOf('trailer'));
      const [header, ...rest] = table.split(/(?<=\n)/);
      const count = Number(header.trim().split(' ')[1]);
      const entries = rest.join('');
      expect(entries.length).toBe(count * 20);
      expect(entries).toMatch(/^(\d{10} \d{5} [nf] \n)+$/);
    });
  }
});
