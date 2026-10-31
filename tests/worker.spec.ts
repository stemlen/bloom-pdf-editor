import { expect, test } from "@playwright/test";
import { downloadPdf, fx, openInEditor, pdfDoc, pdfText, trackErrors } from "./helpers";

test("heavy PDF work runs in the PDF web worker", async ({ page }) => {
  const errors = trackErrors(page);
  const warnings: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "warning" && /PDF worker/i.test(m.text())) warnings.push(m.text());
  });
  const workers: string[] = [];
  page.on("worker", (w) => workers.push(w.url()));

  await openInEditor(page);
  expect(workers.length).toBeGreaterThan(0);

  const { bytes } = await downloadPdf(page);
  expect((await pdfDoc(bytes)).getPageCount()).toBe(3);
  expect(await pdfText(bytes)).toContain("Quarterly Garden Report");

  expect(warnings).toEqual([]);
  expect(errors).toEqual([]);
});

test("with the worker switched off, everything still works on the main thread", async ({ page }) => {
  const workers: string[] = [];
  page.on("worker", (w) => workers.push(w.url()));
  await page.addInitScript(() => localStorage.setItem("bloom:pdf-worker", "off"));

  await openInEditor(page);
  const { bytes } = await downloadPdf(page);
  expect((await pdfDoc(bytes)).getPageCount()).toBe(3);
  expect(await pdfText(bytes)).toContain("Quarterly Garden Report");
  expect(workers).toEqual([]);
});

test("a password-protected PDF opens through the worker", async ({ page }) => {
  const workers: string[] = [];
  page.on("worker", (w) => workers.push(w.url()));
  await page.goto("/");
  await page.getByTestId("file-input").setInputFiles(fx("encrypted.pdf"));
  await page.waitForURL("**/editor");
  await expect(page.getByRole("heading", { name: "Password required" })).toBeVisible();
  await page.getByLabel("Document password").fill("wrong");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /password/i })).toBeVisible();
  await page.getByLabel("Document password").fill("bloom123");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByTestId("page-indicator")).toHaveText("1 / 1");
  expect(workers.length).toBeGreaterThan(0);
});
