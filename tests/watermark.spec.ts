import { expect, test } from "@playwright/test";
import type { PDFRawStream } from "pdf-lib";
import { downloadPdf, fx, openInEditor, pageContent, pageImages, pdfDoc, pdfText, pickTool, trackErrors } from "./helpers";
import { inkIn, renderWithPdfJs } from "./pdfjs-render";

test("a Hindi text watermark is drawn shaped, not as mojibake", async ({ page }) => {
  const errors = trackErrors(page);
  await openInEditor(page, fx("hindi-letter.pdf"));
  await pickTool(page, "watermark");
  await page.getByLabel("Watermark text").fill("गोपनीय");
  await page.getByRole("button", { name: "Add watermark" }).click();
  await page.getByRole("button", { name: "Okay" }).click();
  const { bytes } = await downloadPdf(page);
  const content = await pageContent(bytes, 0);
  // UTF-8 bytes of "गोपनीय" read as WinAnsi.
  expect(content).not.toContain("à¤");
  expect(content).toMatch(/\/ImWM_\S+_tx Do/);
  expect((await pageImages(bytes, 0)).some((i) => i.smask)).toBe(true);
  // Something is drawn around the middle of the page (the watermark is centred).
  const rendered = await renderWithPdfJs(bytes, 1, 1);
  const c = { x: rendered.pageWidth / 2 - 60, y: rendered.pageHeight / 2 - 60, width: 120, height: 120 };
  expect(inkIn(rendered, c)).toBeGreaterThan(0.01);

  // It can be found and removed like any other watermark.
  await page.getByRole("button", { name: "Scan for Watermarks" }).click();
  await page.getByRole("button", { name: "Remove Selected" }).click();
  await page.getByRole("button", { name: "Yes, Remove" }).click();
  const removed = await downloadPdf(page);
  expect(await pageContent(removed.bytes, 0)).not.toMatch(/\/ImWM_\S+ Do/);
  expect(errors).toEqual([]);
});

test("apply a text watermark to every page, then scan and remove it", async ({ page }) => {
  const errors = trackErrors(page);
  await openInEditor(page);
  await pickTool(page, "watermark");
  await page.getByLabel("Watermark text").fill("CONFIDENTIAL");
  const preview = page.getByRole("switch", { name: "Live preview" });
  await expect(preview).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("page-canvas").getByText("CONFIDENTIAL").first()).toBeVisible();
  await preview.click();
  await expect(page.getByTestId("page-canvas").getByText("CONFIDENTIAL")).toHaveCount(0);
  await page.getByRole("button", { name: "Add watermark" }).click();
  await expect(page.getByRole("dialog", { name: "Watermark applied" })).toBeVisible();
  await page.getByRole("button", { name: "Okay" }).click();

  let { bytes } = await downloadPdf(page);
  expect((await pdfText(bytes)).match(/CONFIDENTIAL/g)?.length).toBe(3);

  await page.getByRole("button", { name: "Scan for Watermarks" }).click();
  await page.getByRole("button", { name: "Remove Selected" }).click();
  await page.getByRole("button", { name: "Yes, Remove" }).click();
  ({ bytes } = await downloadPdf(page));
  expect((await pdfText(bytes)).match(/CONFIDENTIAL/g)?.length ?? 0).toBeLessThan(3);
  expect(errors).toEqual([]);
});

test("apply an image watermark", async ({ page }) => {
  await openInEditor(page);
  await pickTool(page, "watermark");
  await page.getByRole("button", { name: "Image", exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "ADD IMAGE" }).click();
  await (await chooser).setFiles(fx("small.png"));
  await expect(page.getByText("Loaded: small.png")).toBeVisible();
  await page.getByRole("button", { name: "Add watermark" }).click();
  await page.getByRole("button", { name: "Okay" }).click();
  const { bytes } = await downloadPdf(page);
  // Page 3 had no images before.
  expect((await pageImages(bytes, 2)).length).toBeGreaterThan(0);
});

test("an image watermark keeps its pixel size and PNG transparency", async ({ page }) => {
  await openInEditor(page);
  await pickTool(page, "watermark");
  await page.getByRole("button", { name: "Image", exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "ADD IMAGE" }).click();
  await (await chooser).setFiles(fx("signature.png"));
  await expect(page.getByText("Loaded: signature.png")).toBeVisible();
  await page.getByRole("button", { name: "Add watermark" }).click();
  await page.getByRole("button", { name: "Okay" }).click();
  const { bytes } = await downloadPdf(page);
  const { PDFName, PDFDict } = await import("pdf-lib");
  const pdf = await pdfDoc(bytes);
  const xobjects = pdf.getPage(2).node.Resources()!.lookup(PDFName.of("XObject"), PDFDict);
  const [, ref] = xobjects.entries().find(([k]) => k.toString().startsWith("/ImWM_"))!;
  const image = pdf.context.lookup(ref) as PDFRawStream;
  // signature.png is 900 × 300 with a transparent background.
  expect(image.dict.get(PDFName.of("Width"))?.toString()).toBe("900");
  expect(image.dict.get(PDFName.of("Height"))?.toString()).toBe("300");
  expect(image.dict.get(PDFName.of("SMask"))).toBeDefined();
  // pdf.js draws it (a wrong /Width made it throw).
  await renderWithPdfJs(bytes, 3, 0.5);
});
