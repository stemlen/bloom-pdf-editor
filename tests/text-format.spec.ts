import { expect, test, type Page } from "@playwright/test";
import { inflateSync } from "node:zlib";
import { PDFArray, PDFDict, PDFName, PDFRawStream, PDFRef } from "pdf-lib";
import { downloadPdf, editLine, openInEditor, pdfDoc, pdfPoint, pdfText, trackErrors } from "./helpers";

test.beforeEach(async ({ page }) => {
  page.on("dialog", (d) => d.accept());
});

async function addBox(page: Page, x = 300, y = 160) {
  await page.getByRole("button", { name: "Add Text Box" }).click();
  const at = await pdfPoint(page, x, y);
  await page.mouse.click(at.x, at.y);
  const input = page.getByTestId("text-box-input");
  await expect(input).toBeFocused();
  return input;
}

/** All page-1 content streams, decompressed, joined. */
async function pageOneContent(bytes: Uint8Array) {
  const doc = await pdfDoc(bytes);
  const page = doc.getPage(0);
  const contents = page.node.get(PDFName.of("Contents"));
  const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
  let out = "";
  for (const r of refs) {
    const s = doc.context.lookup(r as PDFRef) as PDFRawStream;
    const filter = s.dict.get(PDFName.of("Filter"));
    const raw = s.getContents();
    out += Buffer.from(filter ? inflateSync(raw) : raw).toString("latin1") + "\n";
  }
  const fonts = page.node.Resources()?.lookup(PDFName.of("Font"), PDFDict);
  const baseFonts = fonts ? fonts.keys().map((k) => (fonts.lookup(k, PDFDict).get(PDFName.of("BaseFont")) as PDFName).asString()) : [];
  return { out, baseFonts };
}

test("format a text box and export it exactly", async ({ page }) => {
  const errors = trackErrors(page);
  await openInEditor(page);
  const input = await addBox(page);
  await input.fill("Garden notes\nWater the roses");

  const pressed = (name: string) => page.getByRole("button", { name, exact: true });
  await pressed("Bold").click();
  await pressed("Italic").click();
  await pressed("Underline").click();
  await pressed("Strikethrough").click();
  await pressed("Justify").click();
  await pressed("Numbered list").click();
  await pressed("Highlight #FFF176").click();
  await page.getByRole("button", { name: "24", exact: true }).click();
  await page.getByLabel("Font", { exact: true }).selectOption("Times New Roman");
  await page.getByLabel("Line spacing").selectOption("1.5");
  await page.getByLabel("Letter spacing").fill("0.5");

  for (const n of ["Bold", "Italic", "Underline", "Strikethrough", "Justify", "Numbered list", "Highlight #FFF176"]) {
    await expect(pressed(n)).toHaveAttribute("aria-pressed", "true");
  }
  await expect(page.getByTestId("text-box-input")).toHaveCSS("font-weight", "700");

  // Leave the box: the exact preview replaces the editor.
  await page.getByTestId("page-canvas").click({ position: { x: 20, y: 20 } });
  const preview = page.getByTestId("text-box-preview");
  await expect(preview).toBeVisible();
  await expect(preview.locator("text")).toHaveText(["1.", "Garden notes", "2.", "Water the roses"]);

  // Selecting the box again reflects its formatting in the panel.
  await page.getByTestId("text-box").click();
  await expect(pressed("Strikethrough")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Letter spacing")).toHaveValue("0.5");
  await expect(page.getByLabel("Line spacing")).toHaveValue("1.5");

  const { bytes } = await downloadPdf(page);
  const text = await pdfText(bytes);
  expect(text).toContain("Garden notes");
  expect(text).toContain("Water the roses");
  const { out, baseFonts } = await pageOneContent(bytes);
  expect(baseFonts).toContain("/Times-BoldItalic");
  expect(out).toMatch(/\/BTB-Times-BoldItalic 24 Tf/);
  expect(out).toContain("0.5 Tc");
  expect(out).toContain("(1.) Tj");
  expect(out).toMatch(/1 0\.945 0\.463 rg/); // #FFF176 highlight
  // Two lines, 24 pt × 1.5 apart.
  const ys = [...out.matchAll(/1 0 0 1 [\d.]+ ([\d.]+) Tm\n\((?:Garden|Water)/g)].map((m) => parseFloat(m[1]));
  expect(ys).toHaveLength(2);
  expect(ys[0] - ys[1]).toBeCloseTo(36, 2);
  expect(errors).toEqual([]);
});

test("bulleted list and existing-line limits", async ({ page }) => {
  await openInEditor(page);
  const input = await addBox(page, 300, 300);
  await input.fill("One\nTwo");
  await page.getByRole("button", { name: "Bulleted list", exact: true }).click();
  await page.getByTestId("page-canvas").click({ position: { x: 20, y: 20 } });
  await expect(page.getByTestId("text-box-preview").locator("text")).toHaveText(["\u2022", "One", "\u2022", "Two"]);
  const { bytes } = await downloadPdf(page);
  const { out } = await pageOneContent(bytes);
  expect(out.match(/\(\\225\) Tj/g)?.length).toBe(2); // WinAnsi bullet
});

test("text boxes are in the undo history: add, type, move, delete", async ({ page }) => {
  await openInEditor(page);
  const undo = page.getByRole("button", { name: "Undo" });
  const redo = page.getByRole("button", { name: "Redo" });
  const boxes = page.getByTestId("text-box");
  const input = await addBox(page, 300, 300);
  await input.fill("Undo me");
  await page.getByTestId("page-canvas").click({ position: { x: 20, y: 20 } }); // leave the box
  await expect(page.getByTestId("text-box-preview")).toBeVisible();

  // Move it, then undo the move.
  const before = (await boxes.first().boundingBox())!;
  await page.mouse.move(before.x + 4, before.y + 4);
  await page.mouse.down();
  await page.mouse.move(before.x + 84, before.y + 64, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await boxes.first().boundingBox())!.x).toBeGreaterThan(before.x + 60);
  await page.getByTestId("page-canvas").click({ position: { x: 20, y: 20 } });
  await undo.click();
  await expect.poll(async () => Math.round((await boxes.first().boundingBox())!.x)).toBe(Math.round(before.x));

  // Undo the typing, then the box itself; redo brings both back.
  await undo.click();
  await expect(page.getByTestId("text-box-preview")).not.toContainText("Undo me");
  await undo.click();
  await expect(boxes).toHaveCount(0);
  await redo.click();
  await redo.click();
  await expect(page.getByTestId("text-box-preview")).toContainText("Undo me");

  // Delete with the box's × and undo it.
  await boxes.first().click();
  await page.getByRole("button", { name: "Delete text box" }).click();
  await expect(boxes).toHaveCount(0);
  await undo.click();
  await expect(boxes).toHaveCount(1);
});

test("undoing a line edit keeps a text box added before it", async ({ page }) => {
  await openInEditor(page);
  const input = await addBox(page, 300, 300);
  await input.fill("Keep this box");
  // Edit an existing line (clicking it also leaves the box).
  await editLine(page, await pdfPoint(page, 120, 670), "Contact: undo@bloompdf.app");
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByTestId("text-box")).toHaveCount(1);
  const { bytes } = await downloadPdf(page);
  const text = await pdfText(bytes);
  expect(text).toContain("Keep this box");
  expect(text).toContain("hello@bloompdf.app");
  expect(text).not.toContain("undo@bloompdf.app");
});
