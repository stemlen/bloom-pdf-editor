/** BE-604: a PDF the parser can't read gets a plain message, never parser internals. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getPageContentBytes, parsePDF, serializeDocumentCompact } from '@/engine';
import { friendlyPdfError } from '@/lib/pdfErrors';

const original = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'editor', 'b-mixed-5pages.pdf')));
const latin1 = (b: Uint8Array) => Buffer.from(b).toString('latin1');
const fromLatin1 = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'));

// Damage that leaves no usable document: no catalog to start from.
const damaged: Record<string, Uint8Array> = {
  'truncated file': original.slice(0, Math.floor(original.length / 2)),
  'garbage after the header': fromLatin1('%PDF-1.7\n' + 'x'.repeat(200)),
};

// Damage to the cross-reference data only: every object is still in the file,
// so the document is rebuilt by scanning, as pdf.js and other readers do.
const recoverable: Record<string, () => Promise<Uint8Array>> = {
  'missing startxref': async () => fromLatin1(latin1(original).replace(/startxref[\s\S]*$/, '')),
  'misspelled startxref': async () => fromLatin1(latin1(original).replace('startxref', 'startxrex')),
  'bad xref subsection count': async () => fromLatin1(latin1(original).replace(/\nxref\n0 \d+/, '\nxref\n0 9999')),
  'corrupt xref table': async () => fromLatin1(latin1(original).replace(/\nxref\n0 \d+/, '\nxref\nx y')),
  'offsets shifted by inserted bytes': async () =>
    fromLatin1(latin1(original).replace('\n', '\n%' + 'junk '.repeat(20) + '\n')),
  'object streams with a broken startxref': async () => {
    const compact = await serializeDocumentCompact(await parsePDF(original));
    expect(latin1(compact)).toContain('/ObjStm');
    return fromLatin1(latin1(compact).replace(/startxref\s+\d+/, 'startxref\n999999999'));
  },
};

describe('damaged cross-reference data is rebuilt', () => {
  for (const [label, make] of Object.entries(recoverable)) {
    it(`${label}: opens with every page intact`, async () => {
      const expected = await parsePDF(original);
      const doc = await parsePDF(await make());
      expect(doc.pages.length).toBe(5);
      for (let i = 0; i < 5; i++) {
        expect(latin1(getPageContentBytes(doc.pages[i], doc.objects))).toBe(
          latin1(getPageContentBytes(expected.pages[i], expected.objects)),
        );
      }
    });
  }
});

describe('friendlyPdfError', () => {
  for (const [label, bytes] of Object.entries(damaged)) {
    it(`${label}: shows the friendly message`, async () => {
      const error = await parsePDF(bytes).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      const message = friendlyPdfError(error, bytes);
      expect(message).toBe(
        "This PDF couldn't be opened. It may be damaged or incomplete. Try re-saving or re-downloading it, then open it again.",
      );
      expect(message).not.toMatch(/xref|startxref|parse|expected|object count/i);
    });
  }

  it('keeps password messages and explains empty and non-PDF files', () => {
    expect(friendlyPdfError(new Error('Incorrect password'), original)).toBe('Incorrect password');
    expect(friendlyPdfError(new Error('x'), new Uint8Array(0))).toBe('This file is empty.');
    expect(friendlyPdfError(new Error('x'), fromLatin1('hello world, not a pdf'))).toMatch(/isn't a PDF/);
  });
});
