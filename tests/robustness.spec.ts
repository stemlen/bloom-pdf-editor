import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fx, openInEditor, trackErrors } from "./helpers";

// Damaged and wrong files: the app must explain the problem, never hang or
// crash, and stay usable. Files whose objects are intact (only the
// cross-reference data is damaged) must open, as they do in other readers.

const sample = readFileSync(fx("sample.pdf"));
const latin1 = sample.toString("latin1");
const pdf = (name: string, buffer: Buffer) => ({ name, mimeType: "application/pdf", buffer });

async function upload(page: Page, file: ReturnType<typeof pdf>) {
  await page.goto("/");
  await page.getByTestId("file-input").setInputFiles(file);
}

/** The app is still usable: going home and opening a good file works. */
async function stillUsable(page: Page) {
  await openInEditor(page);
  await expect(page.getByTestId("page-indicator")).toHaveText("1 / 3");
}

test.describe("files with damaged cross-reference data open", () => {
  // sample.pdf keeps most objects (the catalog among them) in an object stream
  // and its cross-reference data in an xref stream.
  const xrefStream = latin1.lastIndexOf("\n", latin1.lastIndexOf(" 0 obj", latin1.indexOf("/Type /XRef"))) + 1;
  const cases = {
    "misspelled startxref": latin1.replace("startxref", "startxrex"),
    "startxref pointing past the end": latin1.replace(/startxref\s+\d+/, "startxref\n99999999"),
    "cross-reference stream and trailer missing": latin1.slice(0, xrefStream),
  };
  for (const [label, body] of Object.entries(cases)) {
    test(label, async ({ page }) => {
      const errors = trackErrors(page);
      await upload(page, pdf("damaged.pdf", Buffer.from(body, "latin1")));
      await page.waitForURL("**/editor");
      await expect(page.locator("[data-testid=page-canvas] canvas").first()).toBeVisible();
      await expect(page.getByTestId("page-indicator")).toHaveText("1 / 3");
      await expect(page.getByText(/[1-9]\d* lines on this page/i)).toBeVisible();
      expect(errors).toEqual([]);
    });
  }
});

test("a corrupted content stream renders without hanging the tab", async ({ page }) => {
  // Stray ")" and an array missing its "]" used to send the content parser into
  // an endless loop that crashed the tab once the page was drawn.
  const content = "BT /F1 18 Tf 72 720 Td (Still readable) Tj ET\nBT 72 700 Td (broken( Tj ET 2) T* [(x) 10 TJ\nBT 72 680 Td (After) Tj ET\n";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  // No xref table: the file is opened by scanning for its objects.
  const body = "%PDF-1.4\n" + objs.map((o, i) => `${i + 1} 0 obj\n${o}\nendobj\n`).join("") + "trailer\n<< /Root 1 0 R >>\n%%EOF\n";
  await upload(page, pdf("corrupt-content.pdf", Buffer.from(body, "latin1")));
  await page.waitForURL("**/editor");
  await expect(page.locator("[data-testid=page-canvas] canvas").first()).toBeVisible();
  await expect(page.getByText(/[1-9]\d* lines? on this page/i)).toBeVisible();
  await stillUsable(page);
});

test("a truncated PDF shows a friendly error and the app stays usable", async ({ page }) => {
  await upload(page, pdf("truncated.pdf", sample.subarray(0, Math.floor(sample.length / 2))));
  await expect(page.getByRole("heading", { name: "We couldn't open this PDF" })).toBeVisible();
  const message = page.locator("p[role=alert]");
  await expect(message).toHaveText(/damaged or incomplete/);
  await expect(message).not.toHaveText(/xref|startxref|trailer/i);
  await page.getByRole("button", { name: "Go Back" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/editor"));
  await stillUsable(page);
});

test("empty, image and text files are refused with a clear message", async ({ page }) => {
  const files = [
    { file: pdf("empty.pdf", Buffer.alloc(0)), message: '"empty.pdf" is empty.' },
    { file: pdf("photo.pdf", readFileSync(fx("small.png"))), message: /"photo\.pdf" isn't a PDF/ },
    { file: pdf("notes.pdf", Buffer.from("just some notes\n")), message: /"notes\.pdf" isn't a PDF/ },
  ];
  for (const { file, message } of files) {
    await upload(page, file);
    await expect(page.getByText(message)).toBeVisible();
    expect(new URL(page.url()).pathname).not.toContain("/editor");
  }
  await stillUsable(page);
});
