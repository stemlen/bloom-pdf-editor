import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import {
  annotCount, download, downloadPdf, fx, magic, openInEditor, openWithPdfJs, pageContent, pageImages,
  pdfPoint, pdfText, pickTool, trackErrors,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  page.on("dialog", (d) => d.accept());
});

const imageCount = (text: string) => (text.match(/\[Image/g) ?? []).length;

async function selectPhoto(page: Page) {
  await pickTool(page, "select");
  const img = await pdfPoint(page, 250, 450);
  await page.mouse.click(img.x, img.y);
  await expect(page.getByText("Image Properties")).toBeVisible();
}

test.describe("images", () => {
  test("replace an embedded image, keeping its place", async ({ page }) => {
    await openInEditor(page);
    await selectPhoto(page);
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Replace Image" }).click();
    await (await chooser).setFiles(fx("small.png"));
    await expect(page.getByRole("button", { name: "Undo" })).toBeEnabled();
    const { bytes } = await downloadPdf(page);
    expect(imageCount(await pdfText(bytes))).toBe(1);
  });

  test("copy an embedded image as a movable duplicate", async ({ page }) => {
    await openInEditor(page);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await selectPhoto(page);
    await page.getByRole("button", { name: "Copy Image" }).click();
    await expect(page.locator('img[alt="floating"]')).toBeVisible();
    const { bytes } = await downloadPdf(page);
    expect(imageCount(await pdfText(bytes))).toBe(2);
  });

  test("removed-images bin: insert, download and delete", async ({ page }) => {
    await openInEditor(page);
    await selectPhoto(page);
    await page.getByRole("button", { name: "Delete (Save to Bin)" }).click();
    const dl = await download(page, page.getByTitle("Download image").first());
    expect(["jpg", "png"]).toContain(magic(dl.bytes));
    await page.getByRole("button", { name: "Insert Here" }).first().click();
    await expect(page.locator('img[alt="floating"]')).toBeVisible();
    await page.getByTitle("Delete permanently from bin").first().click();
    await expect(page.getByText("No removed images")).toBeVisible();
  });

  test("floating image: rotate, then delete back to the bin", async ({ page }) => {
    await openInEditor(page);
    await page.locator('input[type=file][accept="image/*"]').setInputFiles(fx("small.png"));
    const floating = page.locator(".floating-image-container").first();
    await floating.click();
    await page.getByTitle("Rotate 90° clockwise").click();
    let { bytes } = await downloadPdf(page);
    expect(imageCount(await pdfText(bytes))).toBe(2);
    await floating.click();
    await page.getByTitle("Delete Image").click();
    await expect(page.locator('img[alt="floating"]')).toHaveCount(0);
    ({ bytes } = await downloadPdf(page));
    expect(imageCount(await pdfText(bytes))).toBe(1);
  });

  test("drop and paste images onto the page", async ({ page }) => {
    await openInEditor(page);
    const png = readFileSync(fx("small.png")).toString("base64");
    const dispatch = (type: "drop" | "paste") =>
      page.evaluate(
        ({ type, png }) => {
          const bin = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
          const dt = new DataTransfer();
          dt.items.add(new File([bin], "small.png", { type: "image/png" }));
          if (type === "paste") {
            window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt }));
          } else {
            const target = document.querySelector("[data-testid=page-canvas]")!;
            target.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true, clientX: 700, clientY: 400 }));
          }
        },
        { type, png },
      );
    await dispatch("drop");
    await expect(page.locator('img[alt="floating"]')).toHaveCount(1);
    await dispatch("paste");
    await expect(page.locator('img[alt="floating"]')).toHaveCount(2);
  });
});

test.describe("text & tables", () => {
  test("add a table column", async ({ page }) => {
    await openInEditor(page);
    await page.getByRole("button", { name: "Next page" }).click();
    const cell = await pdfPoint(page, 75, 700);
    await page.mouse.click(cell.x, cell.y);
    await page.getByRole("button", { name: "Add Column Right" }).click();
    const { bytes } = await downloadPdf(page);
    // One new (empty) cell per table row, placed right of the last column.
    expect((await pageContent(bytes, 1)).match(/\(\s\)\s*Tj/g)?.length).toBeGreaterThanOrEqual(4);
  });

  test("restyle a line: font, colour and alignment", async ({ page }) => {
    const errors = trackErrors(page);
    await openInEditor(page);
    const at = await pdfPoint(page, 120, 670);
    await page.mouse.click(at.x, at.y);
    await page.keyboard.press("ControlOrMeta+a");
    const panel = page.getByTestId("options-panel");
    await panel.locator("select").first().selectOption("Times New Roman");
    await panel.getByRole("button", { name: "Text colour #3b82f6" }).click();
    await panel.getByRole("button", { name: "Align center" }).click();
    await expect(panel.getByRole("button", { name: "Align center" })).toHaveAttribute("aria-pressed", "true");
    await page.getByLabel("Edit line").focus();
    await page.keyboard.press("Enter");
    const { bytes } = await downloadPdf(page);
    expect(await pdfText(bytes)).toContain("hello@bloompdf.app");
    expect(errors).toEqual([]);
  });
});

test.describe("links", () => {
  test("edit and remove a link", async ({ page }) => {
    await openInEditor(page);
    const at = await pdfPoint(page, 120, 670);
    await page.mouse.click(at.x, at.y);
    await page.keyboard.press("ControlOrMeta+a");
    await page.getByRole("button", { name: "Add Link to Selection" }).click();
    await page.getByPlaceholder("https://example.com").fill("https://bloompdf.app/one");
    await page.getByRole("button", { name: "Save" }).click();
    // Finish editing the line (link hovering is paused while a line is open).
    const blank = await pdfPoint(page, 500, 120);
    await page.mouse.click(blank.x, blank.y);
    await expect(page.getByLabel("Edit line")).toHaveCount(0);
    await page.getByRole("button", { name: /Scan for Links|Links? Highlighted|No Links on This Page/ }).click();

    const popover = page.locator("[data-link-popover]");
    // The popover opens after hovering a link for a moment.
    const hoverLink = async () => {
      const until = Date.now() + 15_000;
      for (let i = 0; Date.now() < until && (await popover.count()) === 0; i++) {
        await page.mouse.move(at.x + 10 + (i % 8) * 5, at.y, { steps: 2 });
        await page.waitForTimeout(300);
      }
      await expect(popover).toBeVisible();
    };
    await test.step("first hover", hoverLink);
    await expect(popover).toContainText("bloompdf.app/one");
    await popover.getByRole("button", { name: "Edit" }).click();
    await popover.getByLabel("Link:").fill("https://bloompdf.app/two");
    await popover.getByRole("button", { name: "Close" }).click();
    let { bytes } = await downloadPdf(page);
    expect(Buffer.from(bytes).toString("latin1")).toContain("bloompdf.app/two");

    await test.step("second hover", hoverLink);
    await popover.getByRole("button", { name: "Edit" }).click();
    await popover.getByRole("button", { name: "Remove" }).click();
    ({ bytes } = await downloadPdf(page));
    expect(await annotCount(bytes, "Link")).toBe(0);
  });
});

test.describe("signatures", () => {
  test("upload a signature and manage the library", async ({ page }) => {
    await openInEditor(page);
    await pickTool(page, "sign");
    await page.getByRole("button", { name: "Create signature" }).click();
    const dialog = page.getByRole("dialog", { name: "Create signature" });
    await dialog.getByRole("button", { name: "Upload" }).click();
    await dialog.locator("input[type=file]").setInputFiles(fx("small.png"));
    await expect(dialog.getByAltText("Upload preview")).toBeVisible();
    await dialog.getByRole("button", { name: "Save to library" }).click();

    const panel = page.getByTestId("options-panel");
    const cards = panel.locator("[draggable=true]");
    await expect(cards).toHaveCount(1);
    await panel.getByLabel("Signature name").fill("Stamp");
    await cards.first().getByTitle("Favorite").click();
    await expect(cards.first().getByTitle("Favorite")).toHaveAttribute("aria-pressed", "true");
    await cards.first().getByTitle("Duplicate").click();
    await expect(cards).toHaveCount(2);
    await cards.nth(1).getByTitle("Delete").click();
    await expect(cards).toHaveCount(1);
  });

  test("rotate, lock and delete a placed signature", async ({ page }) => {
    await openInEditor(page);
    await pickTool(page, "sign");
    await page.getByRole("button", { name: "Create signature" }).click();
    const dialog = page.getByRole("dialog", { name: "Create signature" });
    await dialog.getByRole("button", { name: "Type", exact: true }).click();
    await dialog.getByPlaceholder("Type your name").fill("Asha");
    await dialog.getByRole("button", { name: "Save to library" }).click();
    const card = page.getByTestId("options-panel").locator("[draggable=true]").first();
    await card.dragTo(page.getByTestId("page-canvas"), { targetPosition: { x: 300, y: 700 } });
    const sig = page.getByTestId("page-canvas").getByRole("img", { name: "Signature" });
    // A dropped signature starts selected. (The <img> lets clicks through to its frame.)
    await page.getByTitle("Rotate 15°").click();
    await page.getByRole("button", { name: "Lock", exact: true }).click();
    await expect(page.getByRole("button", { name: "Unlock", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Unlock", exact: true }).click();
    let { bytes } = await downloadPdf(page);
    expect((await pageImages(bytes, 0)).filter((i) => i.smask)).toHaveLength(1);
    await sig.click({ force: true });
    await page.keyboard.press("Delete");
    await expect(sig).toHaveCount(0);
    ({ bytes } = await downloadPdf(page));
    expect((await pageImages(bytes, 0)).filter((i) => i.smask)).toHaveLength(0);
  });

  test("embed long-term validation data after signing", async ({ page }) => {
    await openInEditor(page);
    await pickTool(page, "sign");
    await page.getByRole("button", { name: "Import / manage certificates" }).click();
    const dialog = page.getByRole("dialog", { name: "Certificates" });
    await dialog.getByLabel("Paste PEM").fill(readFileSync(fx("signer.pem"), "utf8"));
    await dialog.getByRole("button", { name: "Import PEM" }).click();
    await dialog.getByRole("button", { name: "Done" }).click();
    await page.getByRole("button", { name: "Digitally sign document" }).click();
    await expect(page.getByText("#1 Bloom Test Signer")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Enable LTV (embed DSS)" }).click();
    await expect(page.getByText(/LTV not enabled/)).toHaveCount(0);
    const { bytes } = await downloadPdf(page);
    expect(Buffer.from(bytes).toString("latin1")).toContain("/DSS");
  });
});

test.describe("watermark & security extras", () => {
  test("shape watermark below the content", async ({ page }) => {
    await openInEditor(page);
    await pickTool(page, "watermark");
    await page.getByRole("button", { name: "Shape", exact: true }).click();
    await page.getByLabel("Watermark text").fill("DRAFT");
    await page.getByRole("button", { name: "Below the PDF content" }).click();
    await page.getByRole("button", { name: "Add watermark" }).click();
    await page.getByRole("button", { name: "Okay" }).click();
    const { bytes } = await downloadPdf(page);
    expect((await pdfText(bytes)).match(/DRAFT/g)?.length).toBe(3);
  });

  test("encrypt, then remove encryption again", async ({ page }) => {
    await openInEditor(page);
    await pickTool(page, "security");
    const panel = page.getByTestId("security-panel");
    await panel.getByRole("button", { name: "Protect", exact: true }).click();
    await panel.getByPlaceholder("Optional open password").fill("tulip42");
    await panel.getByPlaceholder("Required for permissions").fill("owner42");
    await panel.getByRole("button", { name: "Encrypt PDF" }).click();
    await expect(panel.getByText("Document encrypted")).toBeVisible();
    await panel.getByRole("button", { name: "Remove encryption" }).click();
    await expect(panel.getByText(/Document decrypted/)).toBeVisible();
    const { bytes } = await downloadPdf(page);
    expect(Buffer.from(bytes).toString("latin1")).not.toContain("/Encrypt");
    expect((await openWithPdfJs(bytes)).text).toContain("Quarterly Garden Report");
  });

  test("sanitize, remove attachments and optimize", async ({ page }) => {
    const errors = trackErrors(page);
    await openInEditor(page);
    await pickTool(page, "security");
    const panel = page.getByTestId("security-panel");
    await panel.getByRole("button", { name: "Clean", exact: true }).click();
    await panel.getByRole("button", { name: "Sanitize document" }).click();
    await expect(panel.getByText(/sanitiz/i).last()).toBeVisible();
    await panel.getByRole("button", { name: "Remove attachments" }).click();
    await expect(panel.getByText(/Removed \d+ attachment/)).toBeVisible();
    await panel.getByRole("button", { name: "Optimize (keep security)" }).click();
    const { bytes } = await downloadPdf(page);
    expect((await openWithPdfJs(bytes)).pages).toBe(3);
    expect(errors).toEqual([]);
  });
});

test.describe("layout", () => {
  test("thumbnail grid view", async ({ page }) => {
    await openInEditor(page);
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await page.getByTestId("page-thumb").nth(2).click();
    await expect(page.getByTestId("page-indicator")).toHaveText("3 / 3");
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
  });

  test("hide and show the options panel and shrink the toolbar", async ({ page }) => {
    await openInEditor(page);
    await page.getByTitle("Hide options panel").click();
    await expect(page.getByTestId("options-panel")).toHaveCount(0);
    await page.getByTitle("Show options panel").click();
    await expect(page.getByTestId("options-panel")).toBeVisible();
    await page.getByTitle("Shrink toolbar").click();
    await page.getByTitle("Expand toolbar").click();
  });

  test("editor theme toggle", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await openInEditor(page);
    await page.getByRole("button", { name: "Toggle theme" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
  });
});

test.describe("mobile", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("tool strip, options sheet and page drawer", async ({ page }) => {
    const errors = trackErrors(page);
    await openInEditor(page);
    await page.getByTitle("Draw", { exact: true }).click();
    await expect(page.getByTestId("options-panel")).toBeVisible();
    await page.locator(".mobile-backdrop").click({ position: { x: 20, y: 80 } });
    await expect(page.getByTestId("options-panel")).toHaveCount(0);
    await page.getByTitle("Show page thumbnails").click();
    await page.getByTestId("page-thumb").nth(1).click();
    await expect(page.getByTestId("page-indicator")).toHaveText("2 / 3");
    const { scroll, width } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth }));
    expect(scroll).toBeLessThanOrEqual(width);
    expect(errors).toEqual([]);
  });
});
