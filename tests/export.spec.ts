import { expect, test, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { download, fx, magic, openInEditor, text, trackErrors, zipEntries, zipText } from "./helpers";

async function openExport(page: Page) {
  await page.getByTitle("Export to Word, PNG, Markdown, etc.").click();
  const panel = page.getByTestId("export-panel");
  await expect(panel).toBeVisible();
  return panel;
}

test.describe("render export", () => {
  test("PNG of the current page", async ({ page }) => {
    await openInEditor(page);
    const panel = await openExport(page);
    await panel.getByRole("button", { name: /^PNG Image/ }).click();
    await panel.getByRole("button", { name: "Page 1", exact: true }).click();
    const { name, bytes } = await download(page, panel.getByTestId("export-submit"));
    expect(name).toBe("sample_page1.png");
    expect(magic(bytes)).toBe("png");
    await expect(panel.getByTestId("export-done")).toBeVisible();
  });

  test("JPEG of every page as a zip", async ({ page }) => {
    await openInEditor(page);
    const panel = await openExport(page);
    await panel.getByRole("button", { name: /^JPEG Image/ }).click();
    const { name, bytes } = await download(page, panel.getByTestId("export-submit"));
    expect(name).toBe("sample_images.zip");
    expect((await zipEntries(bytes)).filter((e) => e.endsWith(".jpg"))).toHaveLength(3);
  });

  test("SVG and plain text", async ({ page }) => {
    await openInEditor(page);
    const panel = await openExport(page);
    await panel.getByRole("button", { name: /^SVG \(page image\)/ }).click();
    await panel.getByRole("button", { name: "Page 1", exact: true }).click();
    let dl = await download(page, panel.getByTestId("export-submit"));
    expect(text(dl.bytes)).toContain("<svg");

    // Button names are "<label> <extension>"; the description is shown below the grid.
    await panel.getByRole("button", { name: /^Plain text \.txt$/ }).click();
    await panel.getByRole("button", { name: "All Pages" }).click();
    dl = await download(page, panel.getByTestId("export-submit"));
    expect(dl.name).toBe("sample.txt");
    expect(text(dl.bytes)).toContain("Quarterly Garden Report");
    expect(text(dl.bytes)).toContain("Appendix");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("export-panel")).toHaveCount(0);
  });
});

// Every conversion runs in the in-browser Bloom engine (Web Worker) — no server.
const CONVERSIONS: { label: RegExp; ext: string; check: (b: Uint8Array) => Promise<void> | void }[] = [
  { label: /Word \(DOCX\)/, ext: "docx", check: async (b) => expect(await zipText(b, "word/document.xml")).toContain("Quarterly Garden Report") },
  { label: /Excel \(XLSX\)/, ext: "xlsx", check: async (b) => expect(await zipEntries(b)).toContain("xl/workbook.xml") },
  { label: /PowerPoint \(PPTX\)/, ext: "pptx", check: async (b) => expect(await zipEntries(b)).toContain("ppt/presentation.xml") },
  { label: /OpenDocument/, ext: "odt", check: async (b) => expect(await zipText(b, "content.xml")).toContain("Quarterly Garden Report") },
  { label: /Rich Text/, ext: "rtf", check: (b) => expect(text(b)).toMatch(/^\{\\rtf/) },
  { label: /^HTML/, ext: "html", check: (b) => expect(text(b)).toContain("Quarterly Garden Report") },
  { label: /Markdown/, ext: "md", check: (b) => expect(text(b)).toContain("Quarterly Garden Report") },
  { label: /EPUB/, ext: "epub", check: async (b) => expect(await zipText(b, "mimetype")).toBe("application/epub+zip") },
  { label: /Plain text \(paragraphs\)/, ext: "txt", check: (b) => expect(text(b)).toContain("Sales by Region") },
  { label: /JSON/, ext: "json", check: (b) => expect(() => JSON.parse(text(b))).not.toThrow() },
  { label: /XML/, ext: "xml", check: (b) => expect(text(b)).toContain("<?xml") },
  { label: /SVG \(structure\)/, ext: "svg", check: (b) => expect(text(b)).toContain("<svg") },
];

test("convert to all 12 document formats in the browser", async ({ page }) => {
  const errors = trackErrors(page);
  const apiCalls: string[] = [];
  page.on("request", (r) => r.url().includes("/api/") && apiCalls.push(r.url()));
  await openInEditor(page);
  const panel = await openExport(page);
  await panel.getByRole("button", { name: "Document convert" }).click();
  await expect(panel.getByText("Converts on your device")).toBeVisible();
  for (const c of CONVERSIONS) {
    await panel.getByRole("button", { name: c.label }).first().click();
    const { name, bytes } = await download(page, panel.getByTestId("export-submit"));
    expect(name, c.ext).toBe(`sample.${c.ext}`);
    await c.check(bytes);
    await expect(panel.getByTestId("export-done")).toBeVisible();
  }
  expect(apiCalls).toEqual([]);
  expect(errors).toEqual([]);
});

test("convert an edited document and a page range", async ({ page }) => {
  await openInEditor(page);
  const panel = await openExport(page);
  await panel.getByRole("button", { name: "Document convert" }).click();
  await panel.getByRole("button", { name: /Markdown/ }).click();
  await panel.getByRole("button", { name: "Range" }).click();
  await panel.getByLabel("From").fill("2");
  await panel.getByLabel("To").fill("2");
  const { bytes } = await download(page, panel.getByTestId("export-submit"));
  expect(text(bytes)).toContain("Sales by Region");
  expect(text(bytes)).not.toContain("Quarterly Garden Report");
});

/** Width × height from a PNG's IHDR. */
const pngSize = (b: Uint8Array) => {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
};

test.describe("render export on a high-DPI screen", () => {
  test.use({ deviceScaleFactor: 2 });

  test("PNG has the chosen DPI, not DPI × the screen's pixel ratio", async ({ page }) => {
    await openInEditor(page);
    const panel = await openExport(page);
    await panel.getByRole("button", { name: /^PNG Image/ }).click();
    await panel.getByRole("button", { name: "Page 1", exact: true }).click();
    const { bytes } = await download(page, panel.getByTestId("export-submit"));
    // A4 at the default 150 DPI: 595.28 × 841.89 pt → 1241 × 1754 px.
    expect(pngSize(bytes)).toEqual({ width: 1241, height: 1754 });
  });
});

test("SVG page image of a /Rotate 90 page keeps the page's landscape shape", async ({ page }, info) => {
  const { PDFDocument, StandardFonts, degrees } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  const p = pdf.addPage([300, 500]);
  p.setRotation(degrees(90));
  p.drawText("Turned page", { x: 40, y: 400, size: 20, font: await pdf.embedFont(StandardFonts.Helvetica) });
  const file = info.outputPath("rotated.pdf");
  writeFileSync(file, await pdf.save());

  await openInEditor(page, file);
  const panel = await openExport(page);
  await panel.getByRole("button", { name: /^SVG \(page image\)/ }).click();
  const { bytes } = await download(page, panel.getByTestId("export-submit"));
  const svg = text(bytes);
  expect(svg).toMatch(/<svg[^>]*width="500" height="300" viewBox="0 0 500 300"/);
  expect(svg).toContain('<image width="500" height="300"');
});

test("Hindi made by Chrome converts with its matras, conjuncts and invoice table", async ({ page }) => {
  await openInEditor(page, fx("hindi-invoice.pdf"));
  const panel = await openExport(page);
  await panel.getByRole("button", { name: "Document convert" }).click();
  await panel.getByRole("button", { name: /^Markdown/ }).click();
  const md = text((await download(page, panel.getByTestId("export-submit"))).bytes);
  expect(md).toContain("| क्रम | विवरण | मात्रा | मूल्य (₹) |");
  expect(md).toContain("| 4 | शुद्ध घी | 5 | 480.00 |");
  expect(md).toContain("ग्राहक: श्री राजेश कुमार, नई दिल्ली");
  await panel.getByRole("button", { name: /^Word \(DOCX\)/ }).click();
  const docx = (await download(page, panel.getByTestId("export-submit"))).bytes;
  const xml = await zipText(docx, "word/document.xml");
  expect(xml).toContain("<w:tbl>");
  expect(xml).toContain("गेहूँ का आटा");
  await panel.getByRole("button", { name: /^Rich Text/ }).click();
  const rtf = text((await download(page, panel.getByTestId("export-submit"))).bytes);
  expect(/^[\x00-\x7f]*$/.test(rtf)).toBe(true);
  expect(rtf).toContain("\\u2350?\\u2370?\\u2354?\\u2381?\\u2351?"); // मूल्य
});

test("a password-protected PDF converts to its text, not to zlib errors or garbage", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/");
  await page.getByTestId("file-input").setInputFiles(fx("encrypted.pdf"));
  await page.waitForURL("**/editor");
  await page.getByLabel("Document password").fill("bloom123");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.locator("[data-testid=page-canvas] canvas").first()).toBeVisible();
  const panel = await openExport(page);
  await panel.getByRole("button", { name: "Document convert" }).click();
  for (const [label, ext] of [[/^Markdown/, "md"], [/^Word \(DOCX\)/, "docx"]] as const) {
    await panel.getByRole("button", { name: label }).click();
    const { name, bytes } = await download(page, panel.getByTestId("export-submit"));
    expect(name).toBe(`encrypted.${ext}`);
    const body = ext === "docx" ? await zipText(bytes, "word/document.xml") : text(bytes);
    expect(body).toContain("Top secret garden plans");
  }
  expect(errors).toEqual([]);
});

test("a page range typed backwards exports those pages", async ({ page }) => {
  await openInEditor(page);
  const panel = await openExport(page);
  await panel.getByRole("button", { name: /^Plain text \.txt$/ }).click();
  await panel.getByRole("button", { name: "Range" }).click();
  await panel.getByLabel("From").fill("3");
  await panel.getByLabel("To").fill("2");
  const lines = text((await download(page, panel.getByTestId("export-submit"))).bytes);
  expect(lines).toContain("Sales by Region");
  expect(lines).toContain("Appendix");
  expect(lines).not.toContain("Quarterly Garden Report");

  await panel.getByRole("button", { name: "Document convert" }).click();
  await panel.getByRole("button", { name: /^Markdown/ }).click();
  const md = text((await download(page, panel.getByTestId("export-submit"))).bytes);
  expect(md).toContain("Sales by Region");
  expect(md).not.toContain("Quarterly Garden Report");
});
