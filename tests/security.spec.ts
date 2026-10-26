import { expect, test } from "@playwright/test";
import { downloadPdf, fx, openInEditor, openWithPdfJs, pdfDoc, pickTool, trackErrors } from "./helpers";

test("open a password-protected PDF", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/");
  await page.getByTestId("file-input").setInputFiles(fx("encrypted.pdf"));
  await page.waitForURL("**/editor");
  await expect(page.getByRole("heading", { name: "Password required" })).toBeVisible();
  await page.getByLabel("Document password").fill("wrong");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /password/i })).toBeVisible();
  await page.getByLabel("Document password").fill("bloom123");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByTestId("page-canvas")).toBeVisible();
  await expect(page.getByTestId("page-indicator")).toHaveText("1 / 1");
  expect(errors.filter((e) => !/password/i.test(e))).toEqual([]);
});

test("encrypt a document with a password", async ({ page }) => {
  await openInEditor(page);
  await pickTool(page, "security");
  const panel = page.getByTestId("security-panel");
  await panel.getByRole("button", { name: "Protect", exact: true }).click();
  await panel.getByPlaceholder("Optional open password").fill("tulip42");
  await panel.getByPlaceholder("Leave blank to generate a strong one").first().fill("owner42");
  await panel.getByRole("switch", { name: "Allow copy" }).click();
  await panel.getByRole("button", { name: "Encrypt PDF" }).click();
  await expect(panel.getByText("Document encrypted")).toBeVisible();

  const { bytes } = await downloadPdf(page);
  expect(Buffer.from(bytes).toString("latin1")).toContain("/Encrypt");
  // Another reader (pdf.js) needs the password and can then read the text.
  await expect(openWithPdfJs(bytes)).rejects.toThrow(/password/i);
  const opened = await openWithPdfJs(bytes, "tulip42");
  expect(opened.pages).toBe(3);
  expect(opened.text).toContain("Quarterly Garden Report");

  // Re-open the download: it asks for the password and unlocks with it.
  await page.goto("/");
  await page.getByTestId("file-input").setInputFiles({ name: "locked.pdf", mimeType: "application/pdf", buffer: Buffer.from(bytes) });
  await expect(page.getByRole("heading", { name: "Password required" })).toBeVisible();
  await page.getByLabel("Document password").fill("tulip42");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByTestId("page-indicator")).toHaveText("1 / 3");
});

test("inspect, strip metadata and apply a policy", async ({ page }) => {
  await openInEditor(page);
  await pickTool(page, "security");
  const panel = page.getByTestId("security-panel");
  await expect(panel.getByText(/\d+\/100/)).toBeVisible();
  await panel.getByRole("button", { name: "Rescan" }).click();
  await expect(panel.getByText("Integrity scan complete")).toBeVisible();

  await panel.getByRole("button", { name: "Clean", exact: true }).click();
  await panel.getByRole("button", { name: "Strip metadata" }).click();
  await expect(panel.getByText("Metadata stripped")).toBeVisible();
  await panel.getByRole("button", { name: "Remove JavaScript" }).click();
  await expect(panel.getByText("JavaScript / risky actions removed")).toBeVisible();

  let { bytes } = await downloadPdf(page);
  expect((await pdfDoc(bytes)).getTitle()).toBeUndefined();

  await panel.getByRole("button", { name: "Policy", exact: true }).click();
  await panel.getByRole("button", { name: "Apply policy" }).click();
  await expect(panel.getByText(/Applied policy/)).toBeVisible();
  ({ bytes } = await downloadPdf(page));
  expect(bytes.length).toBeGreaterThan(1000);
});
