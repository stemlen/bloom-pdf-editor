// Builds tests/fixtures/hindi-form.pdf: a one-page AcroForm with Hindi labels.
// The labels are printed by Chromium (so the Devanagari is properly shaped and
// embedded); the empty fields are added with pdf-lib.
// Run: node scripts/make-hindi-form.mjs   (needs `npx playwright install chromium`)
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { PDFDocument } from "pdf-lib";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures", "hindi-form.pdf");

const label = (top, left, text, size = 16) =>
  `<div style="position:absolute;top:${top}px;left:${left}px;font-size:${size}px">${text}</div>`;
const html = `<!doctype html><meta charset="utf-8"><style>
@page { size: A4; margin: 0 }
body { margin: 0; font-family: "Kohinoor Devanagari", "Noto Sans Devanagari", "Mangal", sans-serif }
</style>
${label(50, 60, "आवेदन पत्र (Application Form)", 22)}
${label(118, 60, "नाम")}
${label(168, 60, "पिता का नाम")}
${label(218, 60, "पता")}
${label(318, 60, "राज्य")}
${label(368, 60, "लिंग")}
${label(368, 250, "पुरुष")}
${label(368, 350, "महिला")}
${label(418, 60, "मैं सहमत हूँ")}`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(html);
const printed = await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
await browser.close();

const doc = await PDFDocument.load(printed);
const p = doc.getPage(0);
const H = p.getHeight();
// CSS px (top of the label) → PDF y of a field box `h` pt tall.
const y = (top, h) => H - top * 0.75 - h + 2;
const form = doc.getForm();
form.createTextField("naam").addToPage(p, { x: 180, y: y(112, 24), width: 300, height: 24 });
form.createTextField("pita_naam").addToPage(p, { x: 180, y: y(162, 24), width: 300, height: 24 });
const pata = form.createTextField("pata");
pata.enableMultiline();
pata.addToPage(p, { x: 180, y: y(212, 64), width: 300, height: 64 });
const rajya = form.createDropdown("rajya");
rajya.addOptions(["उत्तर प्रदेश", "बिहार", "राजस्थान", "Delhi"]);
rajya.addToPage(p, { x: 180, y: y(312, 24), width: 200, height: 24 });
const ling = form.createRadioGroup("ling");
ling.addOptionToPage("purush", p, { x: 228, y: y(368, 14), width: 14, height: 14 });
ling.addOptionToPage("mahila", p, { x: 328, y: y(368, 14), width: 14, height: 14 });
form.createCheckBox("sahmat").addToPage(p, { x: 180, y: y(418, 14), width: 14, height: 14 });
// pdf-lib would otherwise size the text to the box (18 pt, 54 pt for the address).
for (const name of ["naam", "pita_naam", "rajya"]) form.getField(name).setFontSize(12);
pata.setFontSize(11);

writeFileSync(out, await doc.save());
console.log("  ✓ hindi-form.pdf");
