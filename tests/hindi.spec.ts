import { expect, test, type Page } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { downloadPdf, fx, openInEditor, pageContent, pdfPoint, trackErrors } from "./helpers";

// hindi-invoice.pdf: printed by Chromium (Devanagari Sangam MN as Identity-H CID
// TrueType, real text in /ActualText spans). Page height 842.88 pt.
// Table row 5, item column: "चीनी" (baseline ≈ 590); row 1 has "चावल".
const PAGE_H = 842.88;
const ROW5_ITEM = { x: 125, y: 591 };

async function matchCount(page: Page, query: string) {
  const find = page.getByPlaceholder("Search text in PDF…");
  if (!(await find.isVisible())) await page.keyboard.press("ControlOrMeta+f");
  await find.fill(query);
  return page.getByTestId("match-count");
}

test("Hindi: the edit box shows logical Unicode and an edited word keeps the PDF's own glyphs", async ({ page }) => {
  const errors = trackErrors(page);
  page.on("dialog", (d) => d.accept());
  await openInEditor(page, fx("hindi-invoice.pdf"));

  const at = await pdfPoint(page, ROW5_ITEM.x, ROW5_ITEM.y, PAGE_H);
  await page.mouse.click(at.x, at.y);
  const box = page.getByLabel("Edit line");
  await expect(box).toBeFocused();
  // Conjunct-free but matra-heavy: lossy ToUnicode alone gives "च न ".
  await expect(box).toHaveValue("चीनी");

  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText("चावल");
  await page.keyboard.press("Enter");
  await expect(box).toHaveCount(0);

  await expect(await matchCount(page, "चावल")).toHaveText("1/2");
  await expect(await matchCount(page, "चीनी")).toHaveText("No matches");
  // Text with conjuncts elsewhere on the page is untouched. (Search is per
  // text run, so query words that Chromium printed within one run.)
  await expect(await matchCount(page, "धन्यवाद")).toHaveText("1/1");

  const { bytes } = await downloadPdf(page);
  const content = await pageContent(bytes, 0);
  expect(content).not.toContain("HelvAug"); // no Helvetica "????" fallback
  expect(content).toContain("/ActualText");

  // Reopen the saved file: the text layer still reads the new word.
  const dir = join(__dirname, "..", "test-results", "outputs");
  mkdirSync(dir, { recursive: true });
  const saved = join(dir, "hindi-invoice-edited.pdf");
  writeFileSync(saved, bytes);
  await openInEditor(page, saved);
  await expect(await matchCount(page, "चावल")).toHaveText("1/2");
  await expect(await matchCount(page, "धन्यवाद")).toHaveText("1/1");
  expect(errors).toEqual([]);
});
