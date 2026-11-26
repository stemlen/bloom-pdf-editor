/**
 * Damaged content streams and object syntax must never hang the parser.
 *
 * A stray ")" (from a corrupted string) made the lexer return an empty keyword
 * without advancing, so parseContentStream pushed empty operators until the tab
 * ran out of memory; an array missing its "]" re-read the same operator
 * forever. Both showed up on the "corrupted bytes" QA file once it could be
 * opened.
 */
import { describe, expect, it } from 'vitest';
import { PDFLexer, parseContentStream, parsePDF } from '@/engine';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('damaged content streams', () => {
  const cases: Record<string, string> = {
    'stray closing parenthesis': 'BT 1 0 0 1 89 95 Tm ($.r5eC(0oj T* ET\nBT6C Tf-cct 2) T95 Tm\n',
    'unbalanced string at the end': 'BT (never closed Tj ET',
    'braces outside a function': 'q { 1 0 0 1 0 0 cm } Q',
    'array missing its closing bracket': 'BT [(abc) 120 (def) TJ ET',
  };
  for (const [label, content] of Object.entries(cases)) {
    it(`${label}: parses to the end`, () => {
      const ops = parseContentStream(bytes(content));
      expect(ops.length).toBeLessThan(content.length);
    });
  }

  it('keeps the operator after an unterminated array', () => {
    const ops = parseContentStream(bytes('BT [(abc) 120 (def) TJ ET'));
    expect(ops.map((o) => o.operator)).toEqual(['BT', 'TJ', 'ET']);
    expect(ops[1].operands).toHaveLength(1);
  });

  it('the lexer always advances, even on a stray delimiter', () => {
    const lexer = new PDFLexer(bytes(') } {'));
    const seen: unknown[] = [];
    for (let tok = lexer.nextToken(); tok && seen.length < 10; tok = lexer.nextToken()) {
      seen.push(tok.value);
      if (lexer.isEOF) break;
    }
    expect(seen).toEqual([')', '}', '{']);
  });
});

describe('damaged object syntax', () => {
  it('a dictionary with a stray ")" key does not hang the parser', async () => {
    const pdf =
      '%PDF-1.4\n1 0 obj\n<< /Type /Catalog ) /Pages 2 0 R >>\nendobj\n' +
      '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n' +
      'trailer\n<< /Root 1 0 R ) >>\n';
    const doc = await parsePDF(bytes(pdf));
    expect(doc.pages).toHaveLength(1);
  });
});
