import { expect, test } from "@playwright/test";
import { downloadPdf, fx, openInEditor, openWithPdfJs, pdfText, trackErrors } from "./helpers";

test("find text across pages, replace one match, then replace all", async ({ page }) => {
  const errors = trackErrors(page);
  await openInEditor(page);
  await page.keyboard.press("ControlOrMeta+f");
  const find = page.getByPlaceholder("Search text in PDF…");
  await expect(find).toBeFocused();
  await find.fill("the");
  const count = page.getByTestId("match-count");
  await expect(count).toHaveText(/^1\/\d+$/);
  const total = Number((await count.innerText()).split("/")[1]);
  expect(total).toBeGreaterThan(3);

  await find.fill("Report");
  await expect(count).toHaveText("1/1");
  await find.fill("page");
  // "page layout" (p1), then "third page" and "page tools" (p3)
  await expect(count).toHaveText("1/3");
  await page.getByTitle("Next Match (Enter)").click();
  await expect(count).toHaveText("2/3");
  await expect(page.getByTestId("page-indicator")).toHaveText("3 / 3");

  // Replace only the current match.
  await page.getByPlaceholder("Replace with…").fill("sheet");
  await page.getByRole("button", { name: "Replace", exact: true }).click();
  await expect(count).toHaveText(/^\d\/2$/);

  await find.fill("Bloom");
  await page.getByPlaceholder("Replace with…").fill("Blossom");
  await page.getByRole("button", { name: "Replace All" }).click();
  await expect(count).toHaveText("No matches");
  await expect(page.getByTestId("unsaved-badge")).toBeVisible();

  const { bytes } = await downloadPdf(page);
  const txt = await pdfText(bytes);
  expect(txt).toContain("third sheet gives page tools");
  expect(txt).toContain("page layout");
  expect(txt).toContain("Blossom is a privacy-first");
  expect(txt).not.toMatch(/\bBloom\b/);
  expect(errors).toEqual([]);
});

test("finds words drawn as several text runs (Hindi and Latin) and won't write letters the fonts lack", async ({ page }) => {
  const errors = trackErrors(page);
  // "M"+"eeting" and "नोट"+"्स" are separate text runs in this file.
  await openInEditor(page, fx("hindi-mixed-en.pdf"));
  await page.keyboard.press("ControlOrMeta+f");
  const find = page.getByPlaceholder("Search text in PDF…");
  const replace = page.getByPlaceholder("Replace with…");
  const count = page.getByTestId("match-count");
  await find.fill("नोट्स");
  await expect(count).toHaveText("1/1");
  await find.fill("Meeting");
  await expect(count).toHaveText("1/1");
  await replace.fill("Session");
  await page.getByRole("button", { name: "Replace", exact: true }).click();
  await expect(count).toHaveText("No matches");

  // Devanagari the embedded fonts have glyphs for is written...
  await find.fill("बजट");
  await replace.fill("भारत");
  await page.getByRole("button", { name: "Replace All" }).click();
  await expect(count).toHaveText("No matches");

  // ...letters they lack are refused with a message, not written as "?".
  await find.fill("भारत");
  await expect(count).toHaveText("1/5");
  await replace.fill("हिंदुस्तान");
  await page.getByRole("button", { name: "Replace All" }).click();
  await expect(page.getByText(/Can't replace with "हिंदुस्तान"/)).toBeVisible();
  await expect(count).toHaveText("1/5");

  const { bytes } = await downloadPdf(page);
  const { text: txt } = await openWithPdfJs(bytes);
  expect(txt).toMatch(/Session\s*Notes/);
  expect(txt).not.toContain("बजट");
  expect(txt).not.toContain("?");
  expect(errors).toEqual([]);
});

test("search highlights turn with a rotated page", async ({ page }) => {
  await openInEditor(page);
  const thumbs = page.getByTestId("page-thumb");
  await thumbs.nth(0).hover();
  await page.getByRole("button", { name: "Rotate page 1" }).click();
  const canvas = page.getByTestId("page-canvas");
  // Landscape once turned.
  await expect.poll(async () => { const b = (await canvas.boundingBox())!; return b.width > b.height; }).toBe(true);

  await page.keyboard.press("ControlOrMeta+f");
  await page.getByPlaceholder("Search text in PDF…").fill("Quarterly Garden Report");
  await expect(page.getByTestId("match-count")).toHaveText("1/1");
  const hl = (await page.getByTestId("search-highlight").boundingBox())!;
  const c = (await canvas.boundingBox())!;
  // The title runs along the top of the unrotated page; turned 90° clockwise it reads
  // top-to-bottom near the right edge, so its highlight is tall, narrow and on the right.
  expect(hl.height).toBeGreaterThan(hl.width * 3);
  expect(hl.x - c.x).toBeGreaterThan(c.width * 0.75);
  expect(hl.y - c.y).toBeLessThan(c.height * 0.5);
});

test("match case toggle", async ({ page }) => {
  await openInEditor(page);
  await page.getByRole("button", { name: "Toggle Find & Replace" }).click();
  const find = page.getByPlaceholder("Search text in PDF…");
  await find.fill("bloom");
  const count = page.getByTestId("match-count");
  await expect(count).toHaveText(/^1\/[2-9]$/);
  await page.getByTitle("Match Case (Inactive)").click();
  await expect(count).toHaveText(/^1\/1$/); // only "hello@bloompdf.app"
});

test("OCR adds a searchable text layer", async ({ page }) => {
  test.setTimeout(180_000);
  await openInEditor(page);
  await page.getByRole("button", { name: "Toggle Find & Replace" }).click();
  const find = page.getByPlaceholder("Search text in PDF…");
  await find.fill("Garden");
  await expect(page.getByTestId("match-count")).toHaveText("1/1");
  // Needs the tesseract.js worker + English data from the jsDelivr CDN.
  const ocrLog = page.waitForEvent("console", { predicate: (m) => /\[OCR\] Inserted/.test(m.text()), timeout: 150_000 });
  await page.getByTestId("search-ocr-button").click();
  await ocrLog;
  await expect(page.getByTestId("unsaved-badge")).toBeVisible();
  // The recognised words are now a second, invisible text layer.
  await find.fill("");
  await find.fill("Garden");
  await expect(page.getByTestId("match-count")).toHaveText(/^1\/[2-9]$/);
});
