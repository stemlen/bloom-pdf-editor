import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { downloadPdf, fx, openInEditor, openWithPdfJs, pdfDoc, pdfPoint, pickTool, trackErrors } from "./helpers";

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

  // The default "Confidential" policy encrypts with an open password the user must supply
  // (policies never ship built-in passwords), so Apply stays disabled until one is entered.
  await panel.getByRole("button", { name: "Policy", exact: true }).click();
  const apply = panel.getByRole("button", { name: "Apply policy" });
  await expect(apply).toBeDisabled();
  await panel.getByPlaceholder("Needed to open the PDF").fill("policy42");
  await apply.click();
  await expect(panel.getByText(/Applied policy: Confidential/)).toBeVisible();
  // No owner password was given, so a generated one is shown once.
  await expect(panel.getByTestId("generated-owner-password")).not.toBeEmpty();
  ({ bytes } = await downloadPdf(page));
  expect(Buffer.from(bytes).toString("latin1")).toContain("/Encrypt");
  await expect(openWithPdfJs(bytes)).rejects.toThrow(/password/i);
  const opened = await openWithPdfJs(bytes, "policy42");
  expect(opened.pages).toBe(3);
  expect(opened.text).toContain("Quarterly Garden Report");
});

async function unlock(page: Page, file: string, password: string) {
  await page.goto("/");
  await page.getByTestId("file-input").setInputFiles(file);
  await expect(page.getByRole("heading", { name: "Password required" })).toBeVisible();
  await page.getByLabel("Document password").fill(password);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.locator("[data-testid=page-canvas] canvas").first()).toBeVisible();
}

test("edit and download a password-protected PDF: content and protection are kept", async ({ page }) => {
  // Used to save plaintext objects behind /Encrypt: every page came out blank.
  const errors = trackErrors(page);
  const original = await openWithPdfJs(readFileSync(fx("encrypted.pdf")), "bloom123");
  await unlock(page, fx("encrypted.pdf"), "bloom123");
  await page.getByRole("button", { name: "Rotate page 1" }).click();
  const { bytes } = await downloadPdf(page);
  expect(Buffer.from(bytes).toString("latin1")).toContain("/Encrypt");
  await expect(openWithPdfJs(bytes)).rejects.toThrow(/password/i);
  const reopened = await openWithPdfJs(bytes, "bloom123");
  expect(reopened.text.trim().length).toBeGreaterThan(0);
  expect(reopened.text).toBe(original.text);
  expect((await pdfDoc(bytes)).getPage(0).getRotation().angle % 360).not.toBe(0);
  expect(errors.filter((e) => !/password/i.test(e))).toEqual([]);
});

test("remove the password from an opened PDF", async ({ page }) => {
  // Used to decrypt the already-decrypted objects a second time.
  const original = await openWithPdfJs(readFileSync(fx("encrypted.pdf")), "bloom123");
  await unlock(page, fx("encrypted.pdf"), "bloom123");
  await pickTool(page, "security");
  const panel = page.getByTestId("security-panel");
  await panel.getByRole("button", { name: "Protect", exact: true }).click();
  await panel.getByPlaceholder("Optional open password").fill("bloom123");
  await panel.getByRole("button", { name: "Remove encryption" }).click();
  await expect(panel.getByText(/Document decrypted/)).toBeVisible();
  const { bytes } = await downloadPdf(page);
  expect(Buffer.from(bytes).toString("latin1")).not.toContain("/Encrypt");
  expect((await openWithPdfJs(bytes)).text).toBe(original.text);
});

test("pages still render after Encrypt PDF, and later edits are saved encrypted", async ({ page }) => {
  // Encrypting used to turn the live document into ciphertext: other pages drew
  // blank (or crashed the tab) and later edits were written unencrypted.
  await openInEditor(page);
  await pickTool(page, "security");
  const panel = page.getByTestId("security-panel");
  await panel.getByRole("button", { name: "Protect", exact: true }).click();
  await panel.getByPlaceholder("Optional open password").fill("tulip42");
  await panel.locator("select").selectOption("AES-128");
  await panel.getByRole("button", { name: "Encrypt PDF" }).click();
  await expect(panel.getByText("Document encrypted")).toBeVisible();
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.getByTestId("page-indicator")).toHaveText("2 / 3");
  await expect(page.getByText(/[1-9]\d* lines on this page/i)).toBeVisible();
  await page.getByRole("button", { name: "Rotate page 2" }).click();
  const { bytes } = await downloadPdf(page);
  await expect(openWithPdfJs(bytes)).rejects.toThrow(/password/i);
  const opened = await openWithPdfJs(bytes, "tulip42");
  expect(opened.pages).toBe(3);
  expect(opened.text).toContain("Quarterly Garden Report");
  expect((await pdfDoc(bytes)).getPage(1).getRotation().angle % 360).not.toBe(0);
});

test("remove attachments from a PDF that has them", async ({ page }) => {
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]).drawText("Has an attachment", { x: 20, y: 150 });
  await doc.attach(Buffer.from("secret notes"), "notes.txt", { mimeType: "text/plain" });
  await page.goto("/");
  await page.getByTestId("file-input").setInputFiles({ name: "attached.pdf", mimeType: "application/pdf", buffer: Buffer.from(await doc.save({ useObjectStreams: false })) });
  await expect(page.locator("[data-testid=page-canvas] canvas").first()).toBeVisible();
  await pickTool(page, "security");
  const panel = page.getByTestId("security-panel");
  await expect(panel.getByText("Attachments").locator("..")).toContainText("1");
  await panel.getByRole("button", { name: "Clean", exact: true }).click();
  await panel.getByRole("button", { name: "Remove attachments" }).click();
  await expect(panel.getByText("Removed 1 attachment")).toBeVisible();
  const { bytes } = await downloadPdf(page);
  expect(Buffer.from(bytes).toString("latin1")).not.toMatch(/EmbeddedFile|secret notes/);
  expect((await openWithPdfJs(bytes)).text).toContain("Has an attachment");
});

test.describe("Hindi", () => {
  const hindi = fx("hindi-truetype.pdf");
  const line = "नमस्ते दुनिया हिन्दी परीक्षण";

  test("Devanagari text survives metadata stripping and encryption", async ({ page }) => {
    const original = await openWithPdfJs(readFileSync(hindi));
    expect(original.text).toContain(line);
    await openInEditor(page, hindi);
    await pickTool(page, "security");
    const panel = page.getByTestId("security-panel");
    await panel.getByRole("button", { name: "Clean", exact: true }).click();
    await panel.getByRole("button", { name: "Strip metadata" }).click();
    await expect(panel.getByText("Metadata stripped")).toBeVisible();
    await panel.getByRole("button", { name: "Protect", exact: true }).click();
    await panel.getByPlaceholder("Optional open password").fill("पासवर्ड123");
    await panel.getByRole("button", { name: "Encrypt PDF" }).click();
    await expect(panel.getByText("Document encrypted")).toBeVisible();
    const { bytes } = await downloadPdf(page);
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const opened = await pdfjs.getDocument({ data: new Uint8Array(bytes), password: "पासवर्ड123", verbosity: 0 }).promise;
    const meta = await opened.getMetadata();
    expect((meta.info as Record<string, unknown>).Producer).toBeUndefined();
    expect(meta.metadata).toBeNull();
    expect((await openWithPdfJs(bytes, "पासवर्ड123")).text).toBe(original.text);
  });

  test("redacting a Hindi line removes the text, not just covers it", async ({ page }) => {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const src = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(hindi)), verbosity: 0 }).promise;
    const p1 = await src.getPage(1);
    const item = (await p1.getTextContent()).items.find((i) => "str" in i && i.str.includes("नमस्ते"));
    expect(item).toBeTruthy();
    const [, , , , x, y] = (item as { transform: number[] }).transform;
    const pageHeight = p1.getViewport({ scale: 1 }).height;

    await openInEditor(page, hindi);
    await pickTool(page, "redact");
    const at = await pdfPoint(page, x + 10, y + 4, pageHeight);
    await page.mouse.click(at.x, at.y);
    await expect(page.getByText("1 line marked on this page")).toBeVisible();
    await page.getByRole("button", { name: "Apply Redactions" }).click();
    await page.getByRole("button", { name: "Apply redactions" }).click();
    await expect(page.getByText("No lines marked on this page")).toBeVisible();
    const { bytes } = await downloadPdf(page);
    // pdf.js reads the text from the content stream: it is gone, not just covered.
    expect((await openWithPdfJs(bytes)).text).not.toContain("नमस्ते");
  });
});
