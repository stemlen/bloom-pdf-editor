import { expect, test, type Page } from "@playwright/test";
import { annotCount, downloadPdf, fx, openInEditor, pdfDoc, pdfPoint, pickTool, trackErrors } from "./helpers";

test.beforeEach(async ({ page }) => {
  page.on("dialog", (d) => d.accept());
});

async function drag(page: Page, from: [number, number], to: [number, number], steps = 12) {
  const a = await pdfPoint(page, ...from);
  const b = await pdfPoint(page, ...to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps });
  await page.mouse.up();
}

test("draw freehand, line, arrow, rectangle and ellipse", async ({ page }) => {
  const errors = trackErrors(page);
  await openInEditor(page);
  await pickTool(page, "draw");
  await drag(page, [80, 250], [200, 220]);
  for (const [shape, y] of [["Line", 200], ["Arrow", 180], ["Rectangle", 160], ["Ellipse", 140]] as const) {
    await page.getByTitle(shape, { exact: true }).click();
    await drag(page, [300, y], [450, y - 15]);
  }
  await expect(page.getByRole("button", { name: "Clear", exact: true })).toBeVisible();
  const { bytes } = await downloadPdf(page);
  expect(await annotCount(bytes, "Ink")).toBe(1);
  expect(await annotCount(bytes, "Line")).toBe(2);
  expect(await annotCount(bytes, "Square")).toBe(1);
  expect(await annotCount(bytes, "Circle")).toBe(1);
  expect(errors).toEqual([]);
});

test("downloading twice does not duplicate annotations", async ({ page }) => {
  await openInEditor(page);
  await pickTool(page, "draw");
  await drag(page, [80, 250], [200, 220]);
  await downloadPdf(page);
  const { bytes } = await downloadPdf(page);
  expect(await annotCount(bytes, "Ink")).toBe(1);
});

test("erase a stroke and clear the page", async ({ page }) => {
  await openInEditor(page);
  await pickTool(page, "draw");
  await drag(page, [80, 250], [240, 250], 20);
  await drag(page, [80, 200], [240, 200], 20);
  await pickTool(page, "erase");
  await drag(page, [60, 250], [260, 250], 30);
  let { bytes } = await downloadPdf(page);
  expect(await annotCount(bytes, "Ink")).toBe(1);

  await page.getByRole("button", { name: "Clear", exact: true }).click();
  ({ bytes } = await downloadPdf(page));
  expect(await annotCount(bytes)).toBe(0);
});

test("freehand highlight stroke becomes a translucent ink annotation", async ({ page }) => {
  await openInEditor(page);
  await pickTool(page, "highlight");
  await drag(page, [60, 700], [400, 700], 20);
  const { bytes } = await downloadPdf(page);
  expect(await annotCount(bytes, "Ink")).toBe(1);
});

test("shapes on a /Rotate 90 page land where they were drawn", async ({ page }) => {
  await openInEditor(page, fx("mixed-sizes-rotated.pdf"));
  // Page 6 is an A5 portrait MediaBox (419.5 × 595) shown landscape by /Rotate 90.
  for (let i = 1; i < 6; i++) await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.getByTestId("page-indicator")).toHaveText("6 / 7");
  await pickTool(page, "draw");
  await page.getByTitle("Rectangle", { exact: true }).click();
  const box = (await page.getByTestId("page-canvas").boundingBox())!;
  expect(box.width).toBeGreaterThan(box.height);
  // A rectangle in the top-left quarter of the page as displayed…
  await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.1);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.3, { steps: 10 });
  await page.mouse.up();
  const { bytes } = await downloadPdf(page);

  const { PDFName, PDFArray, PDFDict } = await import("pdf-lib");
  const pdf = await pdfDoc(bytes);
  const annots = pdf.getPage(5).node.lookup(PDFName.of("Annots"), PDFArray);
  const square = annots.lookup(annots.size() - 1, PDFDict);
  expect(square.get(PDFName.of("Subtype"))?.toString()).toBe("/Square");
  const [x0, y0, x1, y1] = square.lookup(PDFName.of("Rect"), PDFArray).asArray().map((n) => Number(n.toString()));
  // …is, in the unrotated MediaBox, near the origin: x spans the displayed
  // top edge (10–30 % of 419.5) and y the displayed left edge (10–40 % of 595).
  expect(x0).toBeGreaterThan(419.5 * 0.05);
  expect(x1).toBeLessThan(419.5 * 0.35);
  expect(y0).toBeGreaterThan(595 * 0.05);
  expect(y1).toBeLessThan(595 * 0.45);
});

test("tool shortcuts switch tools", async ({ page }) => {
  await openInEditor(page);
  const status = page.locator("footer").last();
  for (const [key, label] of [["d", "DRAW"], ["h", "HIGHLIGHT"], ["e", "ERASE"], ["w", "WATERMARK"], ["s", "SIGN"], ["v", "SELECT"], ["t", "EDIT TEXT"]]) {
    await page.keyboard.press(key);
    await expect(status).toContainText(`TOOL: ${label}`);
  }
});
