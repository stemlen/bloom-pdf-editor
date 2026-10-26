import { expect, test } from "@playwright/test";
import { downloadPdf, fx, openInEditor, pdfDoc, pdfText, trackErrors } from "./helpers";

test.beforeEach(async ({ page }) => {
  page.on("dialog", (d) => d.accept());
});

test("page navigation: buttons, arrow keys and thumbnails", async ({ page }) => {
  const errors = trackErrors(page);
  await openInEditor(page);
  const indicator = page.getByTestId("page-indicator");
  await expect(page.getByRole("button", { name: "Previous page" })).toBeDisabled();
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(indicator).toHaveText("2 / 3");
  await page.keyboard.press("ArrowRight");
  await expect(indicator).toHaveText("3 / 3");
  await expect(page.getByRole("button", { name: "Next page" })).toBeDisabled();
  await page.keyboard.press("ArrowLeft");
  await expect(indicator).toHaveText("2 / 3");
  await page.getByTestId("page-thumb").nth(0).click();
  await expect(indicator).toHaveText("1 / 3");
  await expect(page.getByTestId("page-thumb").nth(0)).toHaveAttribute("aria-current", "page");
  expect(errors).toEqual([]);
});

test("zoom in and out with buttons and shortcuts", async ({ page }) => {
  await openInEditor(page);
  const zoom = page.getByTestId("zoom-level");
  const canvas = page.getByTestId("page-canvas");
  const w100 = (await canvas.boundingBox())!.width;
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(zoom).toHaveText("125%");
  await expect.poll(async () => (await canvas.boundingBox())!.width).toBeGreaterThan(w100 * 1.2);
  await page.keyboard.press("ControlOrMeta+Minus");
  await expect(zoom).toHaveText("100%");
  await page.getByRole("button", { name: "Zoom out" }).click();
  await page.getByRole("button", { name: "Zoom out" }).click();
  await expect(zoom).toHaveText("50%");
  await expect(page.getByRole("button", { name: "Zoom out" })).toBeDisabled();
});

test("rotate, insert blank, delete and insert another PDF — all saved in the download", async ({ page }) => {
  const errors = trackErrors(page);
  await openInEditor(page);
  const thumbs = page.getByTestId("page-thumb");

  // Rotate page 2 from its card.
  await thumbs.nth(1).hover();
  await page.getByRole("button", { name: "Rotate page 2" }).click();

  // Insert a blank page after page 3 (insert bars sit before each page and after the last).
  await page.getByRole("button", { name: "Insert blank page" }).last().click();
  await expect(thumbs).toHaveCount(4);
  await expect(page.getByTestId("page-indicator")).toHaveText(/\/ 4/);

  // Delete the first page.
  await thumbs.nth(0).hover();
  await thumbs.nth(0).getByRole("button", { name: "Delete page" }).click();
  await page.getByTestId("confirm-dialog").getByRole("button", { name: "Delete page" }).click();
  await expect(thumbs).toHaveCount(3);

  // Insert the form PDF at the very start.
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Insert PDF" }).first().click();
  await (await chooser).setFiles(fx("form.pdf"));
  await expect(thumbs).toHaveCount(4);

  const { bytes } = await downloadPdf(page);
  const doc = await pdfDoc(bytes);
  expect(doc.getPageCount()).toBe(4);
  const pages = doc.getPages();
  // [form, Sales (rotated 90), Appendix, blank]
  expect(pages[1].getRotation().angle).toBe(90);
  const text = await pdfText(bytes);
  expect(text).toContain("Membership Application");
  expect(text).toContain("1,200.50"); // the rotated Sales page
  expect(text).toContain("Appendix");
  expect(text).not.toContain("Quarterly Garden Report");
  expect(errors).toEqual([]);
});

test("reorder pages by dragging thumbnails", async ({ page }) => {
  await openInEditor(page);
  const thumbs = page.getByTestId("page-thumb");
  await thumbs.nth(2).dragTo(thumbs.nth(0));
  await expect(thumbs.nth(0).getByAltText("Page 1")).toBeVisible();
  const { bytes } = await downloadPdf(page);
  const text = await pdfText(bytes);
  // Appendix (old page 3) now comes before the report.
  expect(text.indexOf("Appendix")).toBeGreaterThanOrEqual(0);
  expect(text.indexOf("Appendix")).toBeLessThan(text.indexOf("Quarterly Garden Report"));
});

test("close clears the document and returns home", async ({ page }) => {
  await openInEditor(page);
  await page.getByRole("button", { name: "Close file & return home" }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/editor");
  await expect(page).toHaveURL(/\/$/);
});
