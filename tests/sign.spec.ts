import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { download, downloadPdf, fx, openInEditor, pageImages, pdfDoc, pickTool, trackErrors } from "./helpers";
import { inkIn, renderWithPdfJs } from "./pdfjs-render";

async function createTypedSignature(page: Page, name = "Asha Gardener") {
  await page.getByRole("button", { name: "Create signature" }).click();
  const dialog = page.getByRole("dialog", { name: "Create signature" });
  await dialog.getByRole("tab", { name: "Type" }).or(dialog.getByRole("button", { name: "Type", exact: true })).first().click();
  await dialog.getByPlaceholder("Type your name").fill(name);
  await dialog.getByRole("button", { name: "Save to library" }).click();
  await expect(dialog).toBeHidden();
}

test("create a typed signature, place it on the page and download it", async ({ page }) => {
  const errors = trackErrors(page);
  await openInEditor(page);
  await pickTool(page, "sign");
  await createTypedSignature(page);
  const card = page.getByTestId("options-panel").locator("[draggable=true]").first();
  await expect(card).toBeVisible();
  await card.dragTo(page.getByTestId("page-canvas"), { targetPosition: { x: 400, y: 760 } });
  await expect(page.getByTestId("page-canvas").getByRole("img", { name: "Signature" })).toHaveCount(1);

  const { bytes } = await downloadPdf(page);
  const images = await pageImages(bytes, 0);
  // The photo plus the signature, which keeps its transparency.
  expect(images).toHaveLength(2);
  expect(images.some((i) => i.smask)).toBe(true);
  expect(errors).toEqual([]);
});

test("a signature placed on a Chromium-made page lands where it was dropped", async ({ page }) => {
  // Chromium/Skia PDFs start with a flipped, scaled CTM that is never restored;
  // the signature used to inherit it and come out tiny, mirrored, at the top.
  await openInEditor(page, fx("hindi-letter.pdf"));
  await pickTool(page, "sign");
  await createTypedSignature(page, "राजेश कुमार");
  const canvas = page.getByTestId("page-canvas");
  const card = page.getByTestId("options-panel").locator("[draggable=true]").first();
  await card.dragTo(canvas, { targetPosition: { x: 300, y: 600 } });
  const sig = (await canvas.getByRole("img", { name: "Signature" }).boundingBox())!;
  const box = (await canvas.boundingBox())!;
  const scale = box.width / 595.92;
  const { bytes } = await downloadPdf(page);
  const rendered = await renderWithPdfJs(bytes, 1, 2);
  const where = { x: (sig.x - box.x) / scale, y: (sig.y - box.y) / scale, width: sig.width / scale, height: sig.height / scale };
  expect(inkIn(rendered, where)).toBeGreaterThan(0.02);
  // Nothing new appears in the top band, where it used to land.
  expect(inkIn(rendered, { x: 0, y: 0, width: 300, height: 25 })).toBeLessThan(0.005);
});

test("a signature and an image placed on a /Rotate 90 page stay upright and in place", async ({ page }) => {
  await openInEditor(page, fx("mixed-sizes-rotated.pdf"));
  for (let i = 1; i < 6; i++) await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.getByTestId("page-indicator")).toHaveText("6 / 7");
  const canvas = page.getByTestId("page-canvas");
  const box = (await canvas.boundingBox())!;
  await pickTool(page, "sign");
  await createTypedSignature(page, "Asha Rotated");
  const card = page.getByTestId("options-panel").locator("[draggable=true]").first();
  await card.dragTo(canvas, { targetPosition: { x: box.width * 0.25, y: box.height * 0.2 } });
  const sig = (await canvas.getByRole("img", { name: "Signature" }).boundingBox())!;
  await pickTool(page, "select");
  await page.locator('input[type=file][accept="image/*"]').setInputFiles(fx("small.png"));
  const img = (await page.locator('img[alt="floating"]').boundingBox())!;

  const { bytes } = await downloadPdf(page);
  // pdf.js shows the page turned, as the editor does: 595 × 419.5 points.
  const rendered = await renderWithPdfJs(bytes, 6, 2);
  expect(rendered.pageWidth).toBeGreaterThan(rendered.pageHeight);
  const scale = box.width / rendered.pageWidth;
  const inPage = (b: { x: number; y: number; width: number; height: number }) =>
    ({ x: (b.x - box.x) / scale, y: (b.y - box.y) / scale, width: b.width / scale, height: b.height / scale });
  expect(inkIn(rendered, inPage(sig))).toBeGreaterThan(0.02);
  // small.png is a solid picture: most of its box is covered.
  const photo = inPage(img);
  expect(inkIn(rendered, { x: photo.x + 5, y: photo.y + 5, width: photo.width - 10, height: photo.height - 10 })).toBeGreaterThan(0.3);
});

test("downloading edits to a signed PDF asks before invalidating the signature", async ({ page }) => {
  await openInEditor(page);
  await pickTool(page, "sign");
  await page.getByRole("button", { name: "Import / manage certificates" }).click();
  const certs = page.getByRole("dialog", { name: "Certificates" });
  await certs.getByLabel("Paste PEM").fill(readFileSync(fx("signer.pem"), "utf8"));
  await certs.getByRole("button", { name: "Import PEM" }).click();
  await certs.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Digitally sign document" }).click();
  await expect(page.getByRole("button", { name: "Digitally sign document" })).toBeEnabled({ timeout: 30_000 });

  // An edit after signing.
  await pickTool(page, "draw");
  const box = (await page.getByTestId("page-canvas").boundingBox())!;
  await page.mouse.move(box.x + 80, box.y + 600);
  await page.mouse.down();
  await page.mouse.move(box.x + 220, box.y + 620, { steps: 8 });
  await page.mouse.up();

  const downloadButton = page.getByTitle("Download original / edited PDF (no recompression)");
  await downloadButton.click();
  const dialog = page.getByTestId("signed-compress-dialog");
  await expect(dialog).toContainText("changed the document after it was signed");
  // Keep the signature: the signed file comes back untouched.
  const [dl] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "Download signed file" }).click()]);
  const signed = new Uint8Array(readFileSync((await dl.path())!));
  await page.goto("/");
  await page.getByTestId("file-input").setInputFiles({ name: "signed.pdf", mimeType: "application/pdf", buffer: Buffer.from(signed) });
  await page.waitForURL("**/editor");
  await pickTool(page, "sign");
  await page.getByRole("button", { name: "Validate all signatures" }).click();
  await expect(page.getByTestId("validation-status")).toHaveText("Valid");
});

test("draw a signature", async ({ page }) => {
  await openInEditor(page);
  await pickTool(page, "sign");
  await page.getByRole("button", { name: "Create signature" }).click();
  const dialog = page.getByRole("dialog", { name: "Create signature" });
  const pad = dialog.locator("canvas").first();
  const box = (await pad.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 120);
  await page.mouse.down();
  for (let i = 0; i <= 20; i++) await page.mouse.move(box.x + 40 + i * 18, box.y + 120 - Math.sin(i / 2) * 40);
  await page.mouse.up();
  await dialog.getByRole("button", { name: "Save to library" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("options-panel").locator("[draggable=true] img")).toHaveCount(1);
});

test("digitally sign with an imported certificate and validate it", async ({ page }) => {
  await openInEditor(page);
  await pickTool(page, "sign");
  await page.getByRole("button", { name: "Import / manage certificates" }).click();
  const dialog = page.getByRole("dialog", { name: "Certificates" });
  await dialog.getByLabel("Paste PEM").fill(readFileSync(fx("signer.pem"), "utf8"));
  await dialog.getByRole("button", { name: "Import PEM" }).click();
  await expect(dialog.getByText(/Ready to sign|private key/i).first()).toBeVisible();
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(page.getByText("Ready to sign")).toBeVisible();

  await page.getByRole("button", { name: "Digitally sign document" }).click();
  await expect(page.getByRole("button", { name: "Digitally sign document" })).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByTestId("error-toast")).toHaveCount(0);
  await page.getByRole("button", { name: "Validate all signatures" }).click();
  await expect(page.getByTestId("validation-status")).toHaveText("Valid");

  // The downloaded file must keep a valid signature.
  const { bytes } = await download(page, page.getByTitle("Download original / edited PDF (no recompression)"));
  expect(Buffer.from(bytes).toString("latin1")).toContain("/ByteRange");
  // Other readers can find the signature field too.
  const fields = (await pdfDoc(bytes)).getForm().getFields();
  expect(fields.map((f) => f.constructor.name)).toContain("PDFSignature");
  await page.goto("/");
  await page.getByTestId("file-input").setInputFiles({ name: "signed.pdf", mimeType: "application/pdf", buffer: Buffer.from(bytes) });
  await page.waitForURL("**/editor");
  await pickTool(page, "sign");
  await page.getByRole("button", { name: "Validate all signatures" }).click();
  await expect(page.getByTestId("validation-status")).toHaveText("Valid");
});
