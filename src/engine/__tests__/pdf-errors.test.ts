/** BE-604: a PDF the parser can't read gets a plain message, never parser internals. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parsePDF } from '@/engine';
import { friendlyPdfError } from '@/lib/pdfErrors';

const original = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'editor', 'b-mixed-5pages.pdf')));
const latin1 = (b: Uint8Array) => Buffer.from(b).toString('latin1');
const fromLatin1 = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'));

const damaged: Record<string, Uint8Array> = {
  'missing startxref': fromLatin1(latin1(original).replace(/startxref[\s\S]*$/, '')),
  'truncated file': original.slice(0, Math.floor(original.length / 2)),
  'bad xref subsection count': fromLatin1(latin1(original).replace(/\nxref\n0 \d+/, '\nxref\n0 9999')),
  'garbage after the header': fromLatin1('%PDF-1.7\n' + 'x'.repeat(200)),
};

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
