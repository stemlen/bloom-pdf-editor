import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContainer, type BloomContainer } from '../container.js';

// Five pages: chapter headings, a section heading, body text and, on pages 2
// and 4, a ruled 4×8 table whose rows are each set as one text line.
const fixture = new Uint8Array(
  readFileSync(
    fileURLToPath(
      new URL('../../../src/engine/__tests__/fixtures/editor/b-mixed-5pages.pdf', import.meta.url),
    ),
  ),
);

let container: BloomContainer;

beforeEach(() => {
  container = createContainer({ memoryStorage: true, configOverrides: { 'telemetry.enabled': false } });
  container.startWorkers();
});

afterEach(async () => {
  await container.stop();
});

async function convert(target: string): Promise<string> {
  const queued = await container.documentEngine.enqueueConversion(
    { filename: 'b-mixed-5pages.pdf', target, options: {} },
    fixture,
  );
  for (let i = 0; i < 400; i++) {
    const job = await container.documentEngine.getJob(queued.id);
    if (job?.state === 'Completed') {
      const download = await container.documentEngine.getDownload(queued.id);
      return new TextDecoder().decode(download!.bytes);
    }
    if (job?.state === 'Failed') throw new Error(String(job.error));
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('conversion timed out');
}

describe('Structured exports keep headings and tables (BE-507, BE-509)', () => {
  it('Markdown has heading levels and a pipe table', async () => {
    const md = await convert('markdown');
    expect(md).toMatch(/^# Chapter 1: Mixed Content$/m);
    expect(md).toMatch(/^#{2,3} Section heading level two$/m);
    expect(md).toContain('| Item | Qty | Price | Total |');
    expect(md).toContain('| Product 7 | 7 | $21.50 | $147.50 |');
    // The table's rows must not also appear as loose paragraphs.
    expect(md).not.toMatch(/^Product 1 1 /m);
  });

  it('HTML uses heading elements and a table', async () => {
    const html = await convert('html');
    expect(html).toMatch(/<h1[^>]*>Chapter 1: Mixed Content<\/h1>/);
    expect(html).toContain('<table');
    expect(html).toMatch(/<t[dh][^>]*>\s*Qty\s*<\/t[dh]>/);
  });

  it('SVG places each block at its own position and size', async () => {
    const svg = await convert('svg');
    const page = svg.slice(svg.indexOf('id="page-1"'), svg.indexOf('id="page-2"'));
    const ys = [...page.matchAll(/<tspan x="[\d.]+" y="([\d.]+)">/g)].map((m) => Number(m[1]));
    expect(new Set(ys).size).toBeGreaterThan(10);
    expect(page).toMatch(/font-size="18"[^>]*><tspan[^>]*>Chapter 2: Mixed Content/);
    expect(page).toMatch(/<tspan[^>]*>Qty<\/tspan>/);
  });
});
