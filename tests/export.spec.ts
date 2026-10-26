import { expect, test, type Page } from "@playwright/test";
import { download, magic, openInEditor, text, trackErrors, zipEntries, zipText } from "./helpers";

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

    await panel.getByRole("button", { name: /^Plain text Text line/ }).click();
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
