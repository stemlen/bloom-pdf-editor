/**
 * Form filling on the QA fixture e-form-fields.pdf: radio groups, choice
 * options, read-only fields, multiline/curly-quote text and regenerated
 * appearance streams, all checked after a save and reopen.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as engine from '../index';
import { PDFDict, PDFHexString, PDFName, PDFRef, PDFStream, type PDFDocumentData } from '../types';
import { resolveRef } from '../parser/parser';
import { fieldDictForWidget } from '../forms/apply-field';

const FIXTURE = join(__dirname, 'fixtures/forms/e-form-fields.pdf');

async function open(bytes?: Uint8Array): Promise<PDFDocumentData> {
  return engine.parsePDF(bytes ?? new Uint8Array(readFileSync(FIXTURE)));
}

function fields(doc: PDFDocumentData, name: string) {
  return engine.detectFormFieldsOnPage(doc, 0).filter((f) => f.fieldName === name);
}

async function reopen(doc: PDFDocumentData): Promise<PDFDocumentData> {
  return open(await engine.saveOptimized(doc));
}

describe('form values', () => {
  it('keeps radio buttons mutually exclusive with their export values', async () => {
    const doc = await open();
    const pro = fields(doc, 'plan').find((f) => f.onState === 'pro')!;
    engine.setButtonFieldValue(doc, pro, true);

    const saved = await reopen(doc);
    const plan = fields(saved, 'plan');
    expect(plan.filter((f) => f.value === true).map((f) => f.onState)).toEqual(['pro']);
    const parent = fieldDictForWidget(plan[0], saved.objects);
    expect((parent.get('V') as PDFName).name).toBe('pro');
    for (const f of plan) expect((f.dict.get('AS') as PDFName).name).toBe(f.onState === 'pro' ? 'pro' : 'Off');
  });

  it('exposes /Opt as choice options and regenerates the appearance', async () => {
    const doc = await open();
    const country = fields(doc, 'country')[0];
    expect(country.options).toEqual(['India', 'USA', 'UK', 'Germany']);
    engine.setChoiceFieldValue(doc, country, 'Germany');

    const saved = await reopen(doc);
    const widget = fields(saved, 'country')[0];
    expect(widget.value).toBe('Germany');
    const ap = resolveRef(widget.dict.get('AP') as PDFRef, saved.objects) as PDFDict;
    const n = resolveRef(ap.get('N') as PDFRef, saved.objects) as PDFStream;
    expect(new TextDecoder('latin1').decode(n.getBytes())).toContain('(Germany) Tj');
  });

  it('refuses to change a read-only field', async () => {
    const doc = await open();
    const ro = fields(doc, 'readonly')[0];
    expect(ro.readOnly).toBe(true);
    engine.setFormFieldValue(doc, ro, 'changed');
    expect(fields(await reopen(doc), 'readonly')[0].value).toBe('locked');
  });

  it('keeps newlines and curly quotes in a multiline field', async () => {
    const doc = await open();
    const comments = fields(doc, 'comments')[0];
    expect(comments.multiline).toBe(true);
    const text = 'Line one\nLine two with “curly quotes”';
    engine.setFormFieldValue(doc, comments, text);

    const saved = await reopen(doc);
    const widget = fields(saved, 'comments')[0];
    expect(widget.value).toBe(text);
    expect(fieldDictForWidget(widget, saved.objects).get('V')).toBeInstanceOf(PDFHexString);
  });
});
