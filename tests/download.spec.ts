import { expect, test } from "@playwright/test";
import { download, downloadPdf, editLine, magic, openInEditor, pdfDoc, pdfPoint, pdfText } from "./helpers";

test("an unedited download is a valid copy of the original", async ({ page }) => {
  await openInEditor(page);
  const { name, bytes } = await downloadPdf(page);
  expect(name).toBe("sample.pdf");
  expect((await pdfDoc(bytes)).getPageCount()).toBe(3);
  expect(await pdfText(bytes)).toContain("Quarterly Garden Report");
});

test("quick (incremental) save mode keeps edits", async ({ page }) => {
  await openInEditor(page);
  await editLine(page, await pdfPoint(page, 120, 670), "Contact: quick@bloompdf.app");
  await page.getByTitle("Download options").click();
  await page.getByRole("button", { name: /Quick/ }).click();
  await page.keyboard.press("Escape");
  const { bytes } = await downloadPdf(page);
  expect(await pdfText(bytes)).toContain("quick@bloompdf.app");
});

test("compressed download shrinks the photo", async ({ page }) => {
  await openInEditor(page);
  const original = (await downloadPdf(page)).bytes.length;
  await page.getByTitle("Download options").click();
  await page.getByRole("button", { name: /Screen/ }).click();
  await page.getByRole("button", { name: /Strongest/ }).click();
  const { name, bytes } = await download(page, page.getByRole("button", { name: /^Download \(20% · 72 DPI\)/ }));
  expect(magic(bytes)).toBe("pdf");
  expect((await pdfDoc(bytes)).getPageCount()).toBe(3);
  expect(bytes.length).toBeLessThanOrEqual(original);
  expect(name).toMatch(/^sample(_compressed)?\.pdf$/);
});
