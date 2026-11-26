import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { decodePDFRawStream, PDFRawStream } from "pdf-lib";
import { downloadPdf, fx, openInEditor, openWithPdfJs, pdfDoc, text, trackErrors } from "./helpers";
import { inkIn, renderWithPdfJs } from "./pdfjs-render";

test("fill a text field and tick a checkbox", async ({ page }) => {
  await openInEditor(page, fx("form.pdf"));
  const panel = page.getByTestId("options-panel");
  await expect(panel.getByText("Form Fields (3)")).toBeVisible();
  await panel.getByRole("button", { name: /full_name/ }).click();
  await panel.getByLabel("Field value").fill("Asha Gardener");
  await panel.getByRole("button", { name: /subscribe/ }).click();
  await panel.getByRole("button", { name: "Unchecked — click to check" }).click();
  await expect(panel.getByRole("button", { name: "Checked — click to uncheck" })).toBeVisible();

  const { bytes } = await downloadPdf(page);
  const form = (await pdfDoc(bytes)).getForm();
  expect(form.getTextField("full_name").getText()).toBe("Asha Gardener");
  expect(form.getCheckBox("subscribe").isChecked()).toBe(true);
});

test("flatten form fields", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  await openInEditor(page, fx("form.pdf"));
  const panel = page.getByTestId("options-panel");
  await panel.getByRole("button", { name: /full_name/ }).click();
  await panel.getByLabel("Field value").fill("Flat Value");
  await panel.getByRole("button", { name: "Flatten All" }).click();
  await expect(panel.getByText("No AcroForm fields on this page.", { exact: false })).toBeVisible();
  const { bytes } = await downloadPdf(page);
  expect((await pdfDoc(bytes)).getForm().getFields()).toHaveLength(0);
});

test("Hindi values are drawn shaped, in the saved file and after flattening", async ({ page }) => {
  const errors = trackErrors(page);
  page.on("dialog", (d) => d.accept());
  const fixture = await pdfDoc(new Uint8Array(readFileSync(fx("hindi-form.pdf"))));
  const naamRect = fixture.getForm().getTextField("naam").acroField.getWidgets()[0].getRectangle();
  const pageHeight = fixture.getPage(0).getHeight();
  // Where the value goes, in top-left page points.
  const naamBox = { x: naamRect.x + 2, y: pageHeight - naamRect.y - naamRect.height + 2, width: 120, height: naamRect.height - 4 };

  await openInEditor(page, fx("hindi-form.pdf"));
  const panel = page.getByTestId("options-panel");
  await panel.getByRole("button", { name: /^naam/ }).click();
  await panel.getByLabel("Field value").fill("राजेश कुमार");
  await panel.getByRole("button", { name: /^rajya/ }).click();
  await panel.locator("#form-field-choice").selectOption("उत्तर प्रदेश");

  let { bytes } = await downloadPdf(page);
  const saved = await pdfDoc(bytes);
  const form = saved.getForm();
  expect(form.getTextField("naam").getText()).toBe("राजेश कुमार");
  expect(form.getDropdown("rajya").getSelected()).toEqual(["उत्तर प्रदेश"]);
  // The appearance carries the browser-shaped text as an image, and viewers
  // aren't asked to rebuild it from Helvetica (which gave "?" or mojibake).
  const ap = saved.context.lookup(form.getTextField("naam").acroField.getWidgets()[0].getNormalAppearance());
  expect(ap).toBeInstanceOf(PDFRawStream);
  const apText = Buffer.from(decodePDFRawStream(ap as PDFRawStream).decode()).toString("latin1");
  expect(apText).toContain("/BloomTx0 Do");
  expect(apText).not.toContain("?");
  expect(text(bytes)).not.toContain("/NeedAppearances true");
  expect(inkIn(await renderWithPdfJs(bytes, 1, 2), naamBox)).toBeGreaterThan(0.03);

  await panel.getByRole("button", { name: "Flatten All" }).click();
  await expect(panel.getByText("No AcroForm fields on this page.", { exact: false })).toBeVisible();
  ({ bytes } = await downloadPdf(page));
  expect((await pdfDoc(bytes)).getForm().getFields()).toHaveLength(0);
  expect(inkIn(await renderWithPdfJs(bytes, 1, 2), naamBox)).toBeGreaterThan(0.03);
  expect(errors).toEqual([]);
});

test("flattening keeps the values visible, even right after a download", async ({ page }) => {
  page.on("dialog", (d) => d.accept());
  await openInEditor(page, fx("form.pdf"));
  const panel = page.getByTestId("options-panel");
  await panel.getByRole("button", { name: /full_name/ }).click();
  await panel.getByLabel("Field value").fill("Flat Value");
  await downloadPdf(page);
  await panel.getByRole("button", { name: "Flatten All" }).click();
  await expect(panel.getByText("No AcroForm fields on this page.", { exact: false })).toBeVisible();
  const { bytes } = await downloadPdf(page);
  expect((await pdfDoc(bytes)).getForm().getFields()).toHaveLength(0);
  expect((await openWithPdfJs(bytes)).text).toContain("Flat Value");
});
