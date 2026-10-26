import { expect, test } from "@playwright/test";
import { annotCount, downloadPdf, editLine, openInEditor, pdfPoint, pdfText, pickTool, trackErrors } from "./helpers";

// Text positions in tests/fixtures/sample.pdf (PDF points, baseline):
// title y=770 (26pt) · paragraph y=730/713/696 · contact line y=666 · page 2 table rows y=720…648.
const CONTACT = { x: 120, y: 670 };
const TITLE = { x: 200, y: 778 };

test.beforeEach(async ({ page }) => {
  page.on("dialog", (d) => d.accept());
});

test("edit a line of text and download it", async ({ page }) => {
  const errors = trackErrors(page);
  await openInEditor(page);
  await editLine(page, await pdfPoint(page, CONTACT.x, CONTACT.y), "Contact: team@bloompdf.app");
  const { bytes } = await downloadPdf(page);
  const text = await pdfText(bytes);
  expect(text).toContain("team@bloompdf.app");
  expect(text).not.toContain("hello@bloompdf.app");
  expect(text).toContain("Quarterly Garden Report");
  expect(errors).toEqual([]);
});

test("style the line being edited: size and bold", async ({ page }) => {
  await openInEditor(page);
  await page.mouse.click(...Object.values(await pdfPoint(page, TITLE.x, TITLE.y)) as [number, number]);
  await expect(page.getByLabel("Edit line")).toBeFocused();
  await page.keyboard.press("ControlOrMeta+a");
  await page.getByTitle("Bold").click();
  await page.getByRole("button", { name: "36", exact: true }).click();
  await page.getByLabel("Edit line").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Edit line")).toHaveCount(0);
  const { bytes } = await downloadPdf(page);
  expect(await pdfText(bytes)).toContain("Quarterly Garden Report");
});

test("undo and redo step one edit at a time", async ({ page }) => {
  await openInEditor(page);
  const undo = page.getByRole("button", { name: "Undo" });
  const redo = page.getByRole("button", { name: "Redo" });
  await expect(undo).toBeDisabled();

  await editLine(page, await pdfPoint(page, CONTACT.x, CONTACT.y), "Contact: one@bloompdf.app");
  await editLine(page, await pdfPoint(page, CONTACT.x, CONTACT.y), "Contact: two@bloompdf.app");
  await expect(undo).toBeEnabled();

  // A single Ctrl/Cmd+Z must undo exactly one step.
  await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press("ControlOrMeta+z");
  await page.getByRole("button", { name: "Toggle Find & Replace" }).click();
  const find = page.getByPlaceholder("Search text in PDF…");
  await find.fill("one@bloompdf");
  await expect(page.getByTestId("match-count")).toHaveText("1/1");
  await page.getByTitle("Close Search").click();

  await undo.click();
  await page.getByRole("button", { name: "Toggle Find & Replace" }).click();
  await find.fill("hello@bloompdf");
  await expect(page.getByTestId("match-count")).toHaveText("1/1");
  await page.getByTitle("Close Search").click();

  await expect(redo).toBeEnabled();
  await page.keyboard.press("ControlOrMeta+Shift+z");
  const { bytes } = await downloadPdf(page);
  expect(await pdfText(bytes)).toContain("one@bloompdf.app");
});

test("add a text box", async ({ page }) => {
  await openInEditor(page);
  await page.getByRole("button", { name: "Add Text Box" }).click();
  const at = await pdfPoint(page, 300, 120);
  await page.mouse.click(at.x, at.y);
  const box = page.locator("textarea").filter({ hasText: "New Text" }).first();
  await expect(box).toBeVisible();
  await box.fill("Approved by the garden club");
  const { bytes } = await downloadPdf(page);
  expect(await pdfText(bytes)).toContain("Approved by the garden club");
});

test("duplicate a line below", async ({ page }) => {
  await openInEditor(page);
  const at = await pdfPoint(page, CONTACT.x, CONTACT.y);
  await page.mouse.click(at.x, at.y);
  await expect(page.getByLabel("Edit line")).toBeFocused();
  await page.getByTitle("Copy this line one row below (table / form rows)").click();
  await expect(page.getByLabel("Edit line")).toHaveCount(0);
  const { bytes } = await downloadPdf(page);
  const text = await pdfText(bytes);
  expect(text.match(/hello@bloompdf\.app/g)?.length).toBe(2);
});

test("add a row to a detected table", async ({ page }) => {
  await openInEditor(page);
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.getByTestId("page-indicator")).toHaveText("2 / 3");
  const cell = await pdfPoint(page, 75, 700); // "North" (baseline 696)
  await page.mouse.click(cell.x, cell.y);
  await expect(page.getByText(/Table \d+×\d+/)).toBeVisible();
  await page.getByRole("button", { name: "Add Row Below" }).click();
  const { bytes } = await downloadPdf(page);
  const text = await pdfText(bytes);
  expect(text.match(/North/g)?.length).toBe(2);
});

test("links: add a link to a line, then scan and find it", async ({ page }) => {
  await openInEditor(page);
  const messages: string[] = [];
  page.on("dialog", (d) => messages.push(d.message()));
  await page.getByRole("button", { name: "Scan for Links" }).click();
  await expect.poll(() => messages).toContain("No links found on this page.");

  const at = await pdfPoint(page, CONTACT.x, CONTACT.y);
  await page.mouse.click(at.x, at.y);
  await page.keyboard.press("ControlOrMeta+a");
  await page.getByRole("button", { name: "Add Link to Selection" }).click();
  const url = page.getByPlaceholder("https://example.com");
  await url.fill("https://bloompdf.app/contact");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("button", { name: /Scan for Links|Links? Highlighted|No Links on This Page/ }).click();
  await expect(page.getByRole("button", { name: /Links? Highlighted/ })).toBeVisible();

  const { bytes } = await downloadPdf(page);
  expect(await annotCount(bytes, "Link")).toBe(1);
  expect(Buffer.from(bytes).toString("latin1")).toContain("bloompdf.app/contact");
});

test("highlight a line of text", async ({ page }) => {
  await openInEditor(page);
  await pickTool(page, "highlight");
  const at = await pdfPoint(page, CONTACT.x, CONTACT.y);
  await page.mouse.click(at.x, at.y);
  const { bytes } = await downloadPdf(page);
  expect(await annotCount(bytes, "Highlight")).toBe(1);
});

test("edits survive a reload (autosaved session)", async ({ page }) => {
  await openInEditor(page);
  await editLine(page, await pdfPoint(page, CONTACT.x, CONTACT.y), "Contact: saved@bloompdf.app");
  // Autosave runs ~2.5 s after the last change.
  await page.waitForTimeout(3500);
  await page.reload();
  await expect(page.getByTestId("page-canvas")).toBeVisible();
  const { bytes } = await downloadPdf(page);
  expect(await pdfText(bytes)).toContain("saved@bloompdf.app");
});
