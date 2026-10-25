/**
 * Recognising PDFs by content and turning parser failures into messages a
 * user can act on.
 */

/** True when the bytes start (within the first 1 KB, as readers allow) with %PDF-. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length - 5, 1024);
  for (let i = 0; i <= limit; i++) {
    if (
      bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 &&
      bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2d
    ) {
      return true;
    }
  }
  return false;
}

/** User-facing message for a document that failed to open. */
export function friendlyPdfError(error: unknown, bytes?: Uint8Array): string {
  if (bytes && bytes.length === 0) return 'This file is empty.';
  if (bytes && !looksLikePdf(bytes)) {
    return "This file isn't a PDF. Please choose a PDF file.";
  }
  const raw = error instanceof Error ? error.message : String(error);
  if (/password|encrypt/i.test(raw)) return raw;
  return "This PDF couldn't be opened. It may be damaged or incomplete. Try re-saving or re-downloading it, then open it again.";
}

/** Messages from our own code that read well on their own; anything else is internal detail. */
const TECHNICAL_DETAIL =
  /xref|startxref|trailer|\bobj\b|stream|undefined|null|NaN|cannot read|is not a function|is not defined|unexpected|expected|\/[A-Z][A-Za-z]+|[{}[\]<>]|0x[0-9a-f]+|at \w+ \(/i;

/**
 * User-facing message for a failed action, e.g. actionErrorMessage("Couldn't rotate the page", e).
 * Short, readable reasons (such as "Wrong password") are kept; parser and runtime
 * internals are logged to the console and replaced with a plain next step.
 */
export function actionErrorMessage(action: string, error: unknown): string {
  const raw = (error instanceof Error ? error.message : String(error ?? '')).trim();
  if (raw && raw.length <= 140 && !TECHNICAL_DETAIL.test(raw)) {
    return `${action}: ${raw.replace(/\.?$/, '.')}`;
  }
  console.error(`[Bloom] ${action}:`, error);
  return `${action}. Please try again.`;
}
