/**
 * Content Stream Text Editor
 *
 * Modifies text directly in a PDF page's content stream.
 * This is the core "inline editing" capability — what makes this
 * an Adobe Acrobat-class tool rather than a simple viewer.
 *
 * Operations:
 *   - Replace text within a Tj/TJ operator
 *   - Insert new text at a position
 *   - Delete text from a content stream
 *   - Reflow text with adjusted spacing
 *
 * The editor works at the token level: it locates the exact Tj/TJ
 * instruction in the content stream, modifies its operands, and
 * recompiles the stream.
 */

import { parseContentStream, type CSInstruction } from '../content/operator-lexer';
import { interpretPage, type TextRun } from '../content/interpreter';
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFPageInfo,
} from '../types';
import { resolveRef } from '../parser/parser';
import { loadFont, type FontData, charCodeToUnicode } from '../fonts/font-parser';
import { ensureFallbackFont } from '../fonts/font-augmentation';
import { resolveRunStyleFlags } from '../flow/metrics';
import { serializeToString } from './stream-compiler';
import { findTextMatches, replaceInChainRuns, type TextChain, type TextMatch } from './text-search';

/** Visual size for Tf when switching to the Helvetica fallback. */
function runFontSize(run: TextRun): number {
  if (run.glyphs.length > 0) {
    const tRm = run.glyphs[0].tRm;
    const fromTm = Math.hypot(tRm.a, tRm.b) || Math.hypot(tRm.c, tRm.d);
    if (fromTm > 0.5) return fromTm;
  }
  return run.fontSize > 0.5 ? run.fontSize : 12;
}

// ─── Edit operations ────────────────────────────────────────────────────────

export interface TextEdit {
  /** The text run being edited (from the interpreter's display list) */
  targetRun: TextRun;
  /** New text to replace the original */
  newText: string;
}

export interface EditResult {
  /** The modified content stream bytes */
  newContentBytes: Uint8Array;
  /** Whether font augmentation is needed (new glyphs required) */
  needsFontAugmentation: boolean;
  /** Character codes that are missing from the font */
  missingCharCodes: number[];
}

export interface RunPositionShift {
  run: TextRun;
  dx: number;
  dy: number;
}

// ─── Main editing function ──────────────────────────────────────────────────

/**
 * Apply text edits to a page's content stream.
 *
 * @param contentBytes Original decoded content stream bytes
 * @param page Page info for resources
 * @param objects Document object map
 * @param edits Array of text edits to apply
 * @returns Modified content stream bytes
 */
export function applyTextEdits(
  contentBytes: Uint8Array,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  edits: TextEdit[],
): EditResult {
  // Parse the content stream into instructions
  const instructions = parseContentStream(contentBytes);

  // Build a map of text-showing instructions with their byte offsets
  const textInstructions = findTextInstructions(instructions);

  let needsFontAugmentation = false;
  const missingCharCodes: number[] = [];
  let indexOffset = 0;

  // Apply each edit
  for (const edit of edits) {
    // Unchanged runs must not be rewritten — re-encoding through Helvetica
    // fallback turns Symbol/Zapf bullets (•) into "-" and can perturb spacing.
    if (edit.newText === edit.targetRun.text) {
      continue;
    }

    // Load font data for encoding
    const fontData = loadFontForRun(edit.targetRun, page, objects);

    // Encode with the run's font; subset/CID fonts often can't encode typed ASCII (`.` → missing/`?`)
    let encoded = encodeTextForFont(edit.newText, fontData);
    let useFallbackFont: string | null = null;
    const lossy = isEncodingLossy(edit.newText, encoded, fontData);

    if (lossy) {
      // Keep bold/italic of the source run — HelvAug (regular) was stripping
      // weight from mid-line edits on subset/CID bold faces (F2, etc.).
      const flags = resolveRunStyleFlags(edit.targetRun.fontName, fontData);
      useFallbackFont = ensureFallbackFont(page, objects, flags);
      encoded = encodeTextWinAnsi(edit.newText);
      needsFontAugmentation = true;
      if (encoded.missing.length > 0) {
        missingCharCodes.push(...encoded.missing);
      }
    } else if (encoded.missing.length > 0) {
      needsFontAugmentation = true;
      missingCharCodes.push(...encoded.missing);
    }

    const rawIndices = edit.targetRun.sourceInstructionIndices ?? [];

    // Cover original run ink before rewrite (grow or shrink). Prevents ghost
    // glyphs when sibling fragments / subset fonts leave paint behind.
    if (edit.newText !== edit.targetRun.text && rawIndices.length > 0) {
      const inserted = insertEraseRectForRun(
        instructions,
        edit.targetRun,
        edit.newText,
        Math.min(...rawIndices) + indexOffset,
      );
      indexOffset += inserted;
    }

    const sourceInstructionIndices = rawIndices.map(i => i + indexOffset);

    if (sourceInstructionIndices.length > 1) {
      const wrote = applyGroupedTextEdit(
        instructions,
        sourceInstructionIndices,
        edit.newText,
        encoded,
        useFallbackFont,
        edit.targetRun,
        fontData,
      );
      indexOffset += wrote;
      continue;
    }

    // Prefer stable index-based matching (immune to fuzzy text match failures)
    let matched: TextInstruction | null = null;
    if (sourceInstructionIndices.length === 1) {
      const idx = sourceInstructionIndices[0];
      const inst = instructions[idx];
      if (inst && isTextShowingOperator(inst.operator)) {
        matched = {
          index: idx,
          instruction: inst,
          fontInstruction: null,
          fontName: edit.targetRun.fontName,
          fontSize: edit.targetRun.fontSize,
          tmX: edit.targetRun.x,
          tmY: edit.targetRun.y,
        };
      }
    }

    if (!matched) {
      matched = matchTextRunToInstruction(
        edit.targetRun,
        textInstructions,
        contentBytes,
        page,
        objects,
      );
    }

    if (!matched) {
      console.warn('[TextEditor] Could not match text run to instruction');
      continue;
    }

    // Spaces: subset fonts often have ~0 space advance (live CSS shows gaps,
    // PDF does not). Emit TJ with explicit advances instead of a bare string.
    applyEncodedShowingOperands(
      matched.instruction,
      edit.newText,
      encoded,
      fontData,
      !!useFallbackFont,
    );

    // Switch to Helvetica when the original subset font can't encode the typed text.
    // Restore the prior font afterward so later Type3 letters in the same BT
    // are not mis-drawn as WinAnsi (Type3 byte 0x48 under Helvetica → "H").
    if (useFallbackFont) {
      const inserted = insertFallbackFontAround(
        instructions,
        matched.index,
        useFallbackFont,
        runFontSize(edit.targetRun),
      );
      indexOffset += inserted;
    }
  }

  // Recompile the instructions back into a content stream
  const newBytes = compileInstructions(instructions);

  return {
    newContentBytes: newBytes,
    needsFontAugmentation,
    missingCharCodes,
  };
}

/**
 * Shift text runs by modifying Tm/Td operands in their BT block.
 * Used by the flow layout layer for horizontal reflow and line push-down.
 */
export function applyRunPositionShifts(
  contentBytes: Uint8Array,
  shifts: RunPositionShift[],
  /** Extra runs whose sourceInstructionIndices must stay in sync when we inject ops. */
  indexPeers: TextRun[] = [],
): Uint8Array {
  if (shifts.length === 0) return contentBytes;

  const instructions = parseContentStream(contentBytes);
  const merged = new Map<TextRun, { dx: number; dy: number }>();
  for (let i = 0; i < shifts.length; i++) {
    const s = shifts[i];
    const prev = merged.get(s.run) ?? { dx: 0, dy: 0 };
    prev.dx += s.dx;
    prev.dy += s.dy;
    merged.set(s.run, prev);
  }

  type ShiftItem = { textIndex: number; dx: number; dy: number; run: TextRun };
  const items: ShiftItem[] = [];
  merged.forEach((delta, run) => {
    const indices = run.sourceInstructionIndices;
    if (!indices || indices.length === 0) return;
    if (Math.abs(delta.dx) < 0.01 && Math.abs(delta.dy) < 0.01) return;
    items.push({ textIndex: Math.min(...indices), dx: delta.dx, dy: delta.dy, run });
  });
  items.sort((a, b) => a.textIndex - b.textIndex);

  // Prefer in-place Tm/Td in the BT, then CTM `cm` just outside it. Resume
  // generators often position via `cm` with a bare BT/Tj — absolute Tm inject
  // double-counts under CTM. Last resort: absolute Tm (identity CTM).
  const appliedToOp = new Map<number, { dx: number; dy: number }>();
  const trackedRuns: TextRun[] = [];
  const seen = new Set<TextRun>();
  merged.forEach((_, run) => {
    if (!seen.has(run)) { seen.add(run); trackedRuns.push(run); }
  });
  for (let p = 0; p < indexPeers.length; p++) {
    const run = indexPeers[p];
    if (!seen.has(run)) { seen.add(run); trackedRuns.push(run); }
  }

  const bumpIndicesFrom = (at: number, by: number) => {
    for (let r = 0; r < trackedRuns.length; r++) {
      const idxs = trackedRuns[r].sourceInstructionIndices;
      if (!idxs) continue;
      for (let k = 0; k < idxs.length; k++) {
        if (idxs[k] >= at) idxs[k] += by;
      }
    }
    for (let j = 0; j < items.length; j++) {
      if (items[j].textIndex >= at) items[j].textIndex += by;
    }
    // Position-op map keys shift when we insert before them
    const nextMap = new Map<number, { dx: number; dy: number }>();
    appliedToOp.forEach((v, key) => {
      nextMap.set(key >= at ? key + by : key, v);
    });
    appliedToOp.clear();
    nextMap.forEach((v, key) => appliedToOp.set(key, v));
  };

  const resolvePos = (textIndex: number) =>
    findTextPositionInstruction(instructions, textIndex)
    ?? findCtmPositionInstruction(instructions, textIndex);

  const findBtIndex = (textIndex: number): number => {
    for (let i = textIndex; i >= 0; i--) {
      if (instructions[i].operator === 'ET') return -1;
      if (instructions[i].operator === 'BT') return i;
    }
    return -1;
  };

  // True when mutating `posIndex` would also move a run that is not in this
  // shift batch (shared BT Tm/Td or outer cm). Resume streams often park a
  // whole line under one cm — nudging a trailer would drag earlier runs and
  // invent a column gutter mid-line.
  const posSharedWithUnshifted = (posIndex: number, self: TextRun): boolean => {
    for (let r = 0; r < trackedRuns.length; r++) {
      const other = trackedRuns[r];
      if (other === self || merged.has(other)) continue;
      const idxs = other.sourceInstructionIndices;
      if (!idxs || idxs.length === 0) continue;
      const otherPos = resolvePos(Math.min(...idxs));
      if (otherPos && otherPos.index === posIndex) return true;
    }
    return false;
  };

  const injectLocalTd = (textIndex: number, dx: number, dy: number) => {
    const [tdx, tdy] = toOperandSpace(dx, dy, textSpaceLinearAt(instructions, textIndex));
    instructions.splice(textIndex, 0, {
      operator: 'Td',
      operands: [new PDFNumber(tdx), new PDFNumber(tdy)],
      offset: 0,
    });
    bumpIndicesFrom(textIndex, 1);
  };

  // One local Td advances the text matrix for later showing ops in the same BT.
  const localTdByBt = new Map<number, { dx: number; dy: number }>();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.textIndex < 0 || item.textIndex >= instructions.length) {
      continue;
    }

    const pos = resolvePos(item.textIndex);

    if (!pos) {
      // Prefer local Td inside the BT — absolute Tm at run.x is wrong for
      // after-fragments of a style split (run.x is the before-origin while
      // glyphs already sit further right via Tj advance).
      const bt = findBtIndex(item.textIndex);
      if (bt >= 0) {
        const prevLocal = localTdByBt.get(bt) ?? { dx: 0, dy: 0 };
        const needDx = item.dx - prevLocal.dx;
        const needDy = item.dy - prevLocal.dy;
        if (Math.abs(needDx) >= 0.01 || Math.abs(needDy) >= 0.01) {
          injectLocalTd(item.textIndex, needDx, needDy);
          localTdByBt.set(bt, { dx: prevLocal.dx + needDx, dy: prevLocal.dy + needDy });
        }
        continue;
      }
      // Last resort: absolute Tm from glyph origin (not run.x).
      const g0 = item.run.glyphs[0]?.tRm;
      const absX = (g0?.e ?? item.run.x) + item.dx;
      const absY = (g0?.f ?? item.run.y) + item.dy;
      const insertAt = item.textIndex;
      instructions.splice(insertAt, 0, {
        operator: 'Tm',
        operands: [
          new PDFNumber(1), new PDFNumber(0), new PDFNumber(0), new PDFNumber(1),
          new PDFNumber(absX), new PDFNumber(absY),
        ],
        offset: 0,
      });
      bumpIndicesFrom(insertAt, 1);
      appliedToOp.set(insertAt, { dx: item.dx, dy: item.dy });
      continue;
    }

    const already = appliedToOp.get(pos.index) ?? { dx: 0, dy: 0 };
    const remainDx = item.dx - already.dx;
    const remainDy = item.dy - already.dy;
    if (Math.abs(remainDx) < 0.01 && Math.abs(remainDy) < 0.01) {
      continue;
    }

    if (posSharedWithUnshifted(pos.index, item.run)) {
      const bt = findBtIndex(item.textIndex);
      const prevLocal = bt >= 0 ? (localTdByBt.get(bt) ?? { dx: 0, dy: 0 }) : { dx: 0, dy: 0 };
      const needDx = item.dx - prevLocal.dx;
      const needDy = item.dy - prevLocal.dy;
      if (Math.abs(needDx) < 0.01 && Math.abs(needDy) < 0.01) {
        continue;
      }
      injectLocalTd(item.textIndex, needDx, needDy);
      if (bt >= 0) {
        localTdByBt.set(bt, { dx: prevLocal.dx + needDx, dy: prevLocal.dy + needDy });
      }
      continue;
    }

    const inst = instructions[pos.index];
    // Shifts are in page space; operands are in the space of the CTM (Tm, and
    // the CTM before a cm) or of the text matrix (Td). Chrome/Skia pages run
    // under a scaled, y-flipped CTM, where raw deltas moved trailing text too
    // little (and the wrong way vertically), leaving it under grown text.
    if ((pos.kind === 'Tm' || pos.kind === 'cm') && inst.operands.length >= 6) {
      const [ox, oy] = toOperandSpace(remainDx, remainDy, ctmLinearAt(instructions, pos.index));
      inst.operands[4] = new PDFNumber(numVal(inst.operands[4]) + ox);
      inst.operands[5] = new PDFNumber(numVal(inst.operands[5]) + oy);
      appliedToOp.set(pos.index, {
        dx: already.dx + remainDx,
        dy: already.dy + remainDy,
      });
    } else if (pos.kind === 'Td' || inst.operator === 'Td' || inst.operator === 'TD') {
      // Relative Td/TD: applying the full absolute dx to every glyph's Td
      // stacks shifts (Type3 per-letter score cards explode to the right).
      // Only apply the delta beyond what earlier local Td already contributed.
      const bt = findBtIndex(item.textIndex);
      const prevLocal = bt >= 0 ? (localTdByBt.get(bt) ?? { dx: 0, dy: 0 }) : { dx: 0, dy: 0 };
      const needDx = item.dx - prevLocal.dx;
      const needDy = item.dy - prevLocal.dy;
      if (Math.abs(needDx) < 0.01 && Math.abs(needDy) < 0.01) {
        continue;
      }
      if (inst.operands.length >= 2) {
        const [ox, oy] = toOperandSpace(needDx, needDy, textSpaceLinearAt(instructions, pos.index));
        inst.operands[0] = new PDFNumber(numVal(inst.operands[0]) + ox);
        inst.operands[1] = new PDFNumber(numVal(inst.operands[1]) + oy);
      }
      if (bt >= 0) {
        localTdByBt.set(bt, { dx: prevLocal.dx + needDx, dy: prevLocal.dy + needDy });
      }
      appliedToOp.set(pos.index, {
        dx: already.dx + needDx,
        dy: already.dy + needDy,
      });
    } else if (inst.operands.length >= 2) {
      inst.operands[0] = new PDFNumber(numVal(inst.operands[0]) + remainDx);
      inst.operands[1] = new PDFNumber(numVal(inst.operands[1]) + remainDy);
      appliedToOp.set(pos.index, {
        dx: already.dx + remainDx,
        dy: already.dy + remainDy,
      });
    } else {
      continue;
    }
  }

  return compileInstructions(instructions);
}

type Linear = [number, number, number, number];
const IDENTITY_LINEAR: Linear = [1, 0, 0, 1];
const mulLinear = (m: Linear, n: Linear): Linear => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
];

/** Linear part of the CTM in effect just before instruction `index`. */
function ctmLinearAt(instructions: CSInstruction[], index: number): Linear {
  let m = IDENTITY_LINEAR;
  const stack: Linear[] = [];
  for (let i = 0; i < index && i < instructions.length; i++) {
    const { operator, operands } = instructions[i];
    if (operator === 'q') stack.push(m);
    else if (operator === 'Q') m = stack.pop() ?? IDENTITY_LINEAR;
    else if (operator === 'cm' && operands.length >= 6) {
      m = mulLinear(operands.slice(0, 4).map(numVal) as Linear, m);
    }
  }
  return m;
}

/**
 * Linear map from text space (Td operands) to page space just before
 * `index`: the last Tm in the text object (identity at BT) times the CTM.
 */
function textSpaceLinearAt(instructions: CSInstruction[], index: number): Linear {
  let tm = IDENTITY_LINEAR;
  for (let i = Math.min(index, instructions.length) - 1; i >= 0; i--) {
    const { operator, operands } = instructions[i];
    if (operator === 'BT') break;
    if (operator === 'Tm' && operands.length >= 6) {
      tm = operands.slice(0, 4).map(numVal) as Linear;
      break;
    }
  }
  return mulLinear(tm, ctmLinearAt(instructions, index));
}

/** Page-space delta → operand-space delta for a row-vector map `m` (page = v × m). */
function toOperandSpace(dx: number, dy: number, m: Linear): [number, number] {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-9) return [dx, dy];
  return [(dx * m[3] - dy * m[2]) / det, (dy * m[0] - dx * m[1]) / det];
}

function findTextPositionInstruction(
  instructions: CSInstruction[],
  textIndex: number,
): { index: number; kind: 'Tm' | 'Td' } | null {
  if (textIndex < 0 || textIndex >= instructions.length) return null;

  let btIndex = -1;
  for (let i = textIndex; i >= 0; i--) {
    if (instructions[i].operator === 'ET') return null;
    if (instructions[i].operator === 'BT') {
      btIndex = i;
      break;
    }
  }
  if (btIndex < 0) return null;

  let last: { index: number; kind: 'Tm' | 'Td' } | null = null;
  for (let i = btIndex; i < textIndex; i++) {
    const op = instructions[i].operator;
    if (op === 'Tm') last = { index: i, kind: 'Tm' };
    else if (op === 'Td' || op === 'TD') last = { index: i, kind: 'Td' };
  }

  return last;
}

/**
 * CTM translate that still applies at BT. Resume streams often do:
 *   cm  q  BT ... ET  Q
 * so we must walk past the opening `q` (not stop there). Skip nested
 * q/Q pairs so we don't pick a cm from an already-restored region.
 */
function findCtmPositionInstruction(
  instructions: CSInstruction[],
  textIndex: number,
): { index: number; kind: 'cm' } | null {
  if (textIndex < 0 || textIndex >= instructions.length) return null;

  let btIndex = -1;
  for (let i = textIndex; i >= 0; i--) {
    if (instructions[i].operator === 'ET') return null;
    if (instructions[i].operator === 'BT') {
      btIndex = i;
      break;
    }
  }
  if (btIndex < 0) return null;

  let nest = 0;
  for (let i = btIndex - 1; i >= 0; i--) {
    const op = instructions[i].operator;
    if (op === 'Q') {
      nest++;
      continue;
    }
    if (op === 'q') {
      if (nest > 0) nest--;
      continue;
    }
    if (nest === 0 && op === 'cm' && instructions[i].operands.length >= 6) {
      return { index: i, kind: 'cm' };
    }
  }
  return null;
}

/**
 * Inserts a new text run into a page's content stream.
 *
 * @param contentBytes Original decoded content stream bytes
 * @param page Page info for resources
 * @param objects Document object map
 * @param text The new text to insert
 * @param x X coordinate (PDF units)
 * @param y Y coordinate (PDF units)
 * @param fontSize Font size in points
 * @param color RGB color [0-1, 0-1, 0-1]
 * @returns Modified content stream bytes
 */
export function insertTextRun(
  contentBytes: Uint8Array,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  text: string,
  x: number,
  y: number,
  fontSize: number,
  color: [number, number, number],
): Uint8Array {
  // Ensure the page has the Helv font in its resources
  const resourcesObj = page.dict.get('Resources');
  let resources = resourcesObj instanceof PDFRef ? resolveRef(resourcesObj, objects) : resourcesObj;
  if (!(resources instanceof PDFDict)) {
    resources = new PDFDict();
    page.dict.set('Resources', resources);
  }
  
  const fontObj = resources.get('Font');
  let fontDict = fontObj instanceof PDFRef ? resolveRef(fontObj, objects) : fontObj;
  if (!(fontDict instanceof PDFDict)) {
    fontDict = new PDFDict();
    resources.set('Font', fontDict);
  }
  
  if (!fontDict.has('Helv')) {
    const helvetica = new PDFDict();
    helvetica.set('Type', new PDFName('Font'));
    helvetica.set('Subtype', new PDFName('Type1'));
    helvetica.set('BaseFont', new PDFName('Helvetica'));
    fontDict.set('Helv', helvetica);
  }

  // PDF strings are usually encoded in MacRoman or PDFDocEncoding for standard fonts.
  // For basic text, just convert chars to a PDF string.
  // (In a full implementation, we'd encode correctly using the font's encoding).
  let encodedText = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 256) {
      encodedText += String.fromCharCode(code);
    } else {
      encodedText += '?'; // fallback for unsupported chars in standard font
    }
  }
  const pdfString = new PDFString(encodedText);
  const escaped = serializeToString(pdfString);

  const [r, g, b] = color;
  const injection = `\nq\nBT\n${r} ${g} ${b} rg\n/Helv ${fontSize} Tf\n1 0 0 1 ${x} ${y} Tm\n${escaped} Tj\nET\nQ\n`;
  const enc = new TextEncoder();
  const injectionBytes = enc.encode(injection);

  // Concat using a helper
  const newBytes = new Uint8Array(contentBytes.length + injectionBytes.length);
  newBytes.set(contentBytes);
  newBytes.set(injectionBytes, contentBytes.length);

  return newBytes;
}

// ─── Text instruction matching ──────────────────────────────────────────────

interface TextInstruction {
  instruction: CSInstruction;
  index: number;
  /** The preceding Tf instruction (font selection) */
  fontInstruction: CSInstruction | null;
  /** Font name from the most recent Tf */
  fontName: string;
  /** Font size from the most recent Tf */
  fontSize: number;
  /** Approximate X position from text matrix (user space) */
  tmX: number;
  /** Approximate Y position from text matrix (user space) */
  tmY: number;
}

function numVal(obj: PDFObject | undefined): number {
  return obj instanceof PDFNumber ? obj.value : 0;
}

function findTextInstructions(instructions: CSInstruction[]): TextInstruction[] {
  const result: TextInstruction[] = [];
  let currentFont = '';
  let currentFontSize = 12;
  let lastTfInstruction: CSInstruction | null = null;

  // Track text matrix for position-based matching
  // tm = [a, b, c, d, e, f] where e=x, f=y in user space
  let tmE = 0, tmF = 0;     // text matrix translation (position)
  let tlmE = 0, tlmF = 0;   // text line matrix translation
  let tmA = 1, tmB = 0, tmC = 0, tmD = 1;  // text matrix rotation/scale
  let tlmA = 1, tlmB = 0, tlmC = 0, tlmD = 1;
  let textLeading = 0;

  for (let i = 0; i < instructions.length; i++) {
    const inst = instructions[i];

    switch (inst.operator) {
      case 'BT':
        tmA = 1; tmB = 0; tmC = 0; tmD = 1; tmE = 0; tmF = 0;
        tlmA = 1; tlmB = 0; tlmC = 0; tlmD = 1; tlmE = 0; tlmF = 0;
        break;

      case 'Tm': {
        tmA = numVal(inst.operands[0]); tmB = numVal(inst.operands[1]);
        tmC = numVal(inst.operands[2]); tmD = numVal(inst.operands[3]);
        tmE = numVal(inst.operands[4]); tmF = numVal(inst.operands[5]);
        tlmA = tmA; tlmB = tmB; tlmC = tmC; tlmD = tmD;
        tlmE = tmE; tlmF = tmF;
        break;
      }

      case 'Td': {
        const tx = numVal(inst.operands[0]);
        const ty = numVal(inst.operands[1]);
        // textLineMatrix = translate(tx,ty) * textLineMatrix
        tlmE = tlmA * tx + tlmC * ty + tlmE;
        tlmF = tlmB * tx + tlmD * ty + tlmF;
        tmA = tlmA; tmB = tlmB; tmC = tlmC; tmD = tlmD;
        tmE = tlmE; tmF = tlmF;
        break;
      }

      case 'TD': {
        const tx = numVal(inst.operands[0]);
        const ty = numVal(inst.operands[1]);
        textLeading = -ty;
        tlmE = tlmA * tx + tlmC * ty + tlmE;
        tlmF = tlmB * tx + tlmD * ty + tlmF;
        tmA = tlmA; tmB = tlmB; tmC = tlmC; tmD = tlmD;
        tmE = tlmE; tmF = tlmF;
        break;
      }

      case 'T*': {
        const ty = -textLeading;
        tlmE = tlmC * ty + tlmE;
        tlmF = tlmD * ty + tlmF;
        tmA = tlmA; tmB = tlmB; tmC = tlmC; tmD = tlmD;
        tmE = tlmE; tmF = tlmF;
        break;
      }

      case 'TL':
        textLeading = numVal(inst.operands[0]);
        break;

      case 'Tf':
        currentFont = inst.operands[0] instanceof PDFName ? inst.operands[0].name : '';
        currentFontSize = inst.operands[1] instanceof PDFNumber ? inst.operands[1].value : 12;
        lastTfInstruction = inst;
        break;
    }

    if (inst.operator === 'Tj' || inst.operator === 'TJ' ||
        inst.operator === "'" || inst.operator === '"') {
      result.push({
        instruction: inst,
        index: i,
        fontInstruction: lastTfInstruction,
        fontName: currentFont,
        fontSize: currentFontSize,
        tmX: tmE,
        tmY: tmF,
      });
    }
  }

  return result;
}

/**
 * Match a TextRun (from the interpreter) to the corresponding
 * text instruction in the content stream.
 *
 * We match based on font name and approximate text content.
 */
function matchTextRunToInstruction(
  run: TextRun,
  textInstructions: TextInstruction[],
  contentBytes: Uint8Array,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
): TextInstruction | null {
  // Helper: check if font names are compatible
  const fontsMatch = (tiFontName: string, runFontName: string): boolean => {
    if (runFontName === '' || tiFontName === '') return true;
    if (tiFontName === runFontName) return true;
    return false;
  };

  // 1) Try exact or trimmed match first
  for (const ti of textInstructions) {
    if (!fontsMatch(ti.fontName, run.fontName)) continue;

    const decoded = decodeInstructionText(ti.instruction, ti.fontName, page, objects);
    if (decoded === null) continue;

    if (decoded === run.text || decoded.trim() === run.text.trim()) {
      return ti;
    }
  }

  // 2) Try whitespace-insensitive match
  const runClean = run.text.replace(/\s+/g, '');
  if (runClean.length > 0) {
    for (const ti of textInstructions) {
      if (!fontsMatch(ti.fontName, run.fontName)) continue;

      const decoded = decodeInstructionText(ti.instruction, ti.fontName, page, objects);
      if (decoded === null) continue;

      const decClean = decoded.replace(/\s+/g, '');
      if (decClean === runClean) {
        return ti;
      }
    }
  }

  // 3) Try substring match ONLY if decoded instruction contains the run text (e.g. multi-line TJ array)
  // NEVER check if run.text.includes(decoded), as short/single-character instructions would falsely match!
  for (const ti of textInstructions) {
    if (!fontsMatch(ti.fontName, run.fontName)) continue;

    const decoded = decodeInstructionText(ti.instruction, ti.fontName, page, objects);
    if (decoded === null) continue;

    if (decoded.includes(run.text) && run.text.trim().length > 1) {
      return ti;
    }
  }

  // 4) Normalized comparison — strip all non-alphanumeric characters and compare
  const runNorm = run.text.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  if (runNorm.length > 2) {
    for (const ti of textInstructions) {
      if (!fontsMatch(ti.fontName, run.fontName)) continue;

      const decoded = decodeInstructionText(ti.instruction, ti.fontName, page, objects);
      if (decoded === null) continue;

      const decNorm = decoded.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      if (decNorm === runNorm) {
        return ti;
      }
    }
  }

  // 5) For single/short text (brackets, special chars, bullet points), try
  //    matching by font name alone when there's a single instruction with that font
  //    that produces similar-length text
  if (run.text.trim().length <= 2 && run.text.trim().length > 0) {
    const candidates = textInstructions.filter(ti => {
      if (!fontsMatch(ti.fontName, run.fontName)) return false;
      const decoded = decodeInstructionText(ti.instruction, ti.fontName, page, objects);
      if (decoded === null) return false;
      return decoded.trim().length <= 3 && decoded.trim().length > 0;
    });
    // If exactly one candidate, return it
    if (candidates.length === 1) {
      return candidates[0];
    }
  }

  return null;
}

function decodeInstructionText(
  instruction: CSInstruction,
  fontName: string,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
): string | null {
  const op = instruction.operator;
  const ops = instruction.operands;

  if (op === 'Tj') {
    return extractStringText(ops[0], fontName, page, objects);
  }

  if (op === 'TJ') {
    const arr = ops[0];
    if (!(arr instanceof PDFArray)) return null;

    let text = '';
    for (let i = 0; i < arr.length; i++) {
      const item = arr.get(i)!;
      if (item instanceof PDFString || item instanceof PDFHexString) {
        text += extractStringText(item, fontName, page, objects) ?? '';
      }
      // Numbers are spacing adjustments — skip
    }
    return text;
  }

  if (op === "'") {
    return extractStringText(ops[0], fontName, page, objects);
  }

  if (op === '"') {
    return extractStringText(ops[2], fontName, page, objects);
  }

  return null;
}

function extractStringText(
  obj: PDFObject | undefined,
  fontName: string,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
): string | null {
  if (!obj) return null;

  let bytes: Uint8Array;
  if (obj instanceof PDFString) {
    bytes = obj.toBytes();
  } else if (obj instanceof PDFHexString) {
    bytes = obj.toBytes();
  } else {
    return null;
  }

  // Load font data for decoding
  const fontData = loadFontForName(fontName, page, objects);
  if (!fontData) {
    // Fallback: decode as Latin-1
    let text = '';
    for (let i = 0; i < bytes.length; i++) {
      text += String.fromCharCode(bytes[i]);
    }
    return text;
  }

  // Decode using font's ToUnicode map
  let text = '';
  const isComposite = fontData.isComposite;
  let idx = 0;

  while (idx < bytes.length) {
    let charCode: number;
    if (isComposite && idx + 1 < bytes.length) {
      charCode = (bytes[idx] << 8) | bytes[idx + 1];
      idx += 2;
    } else {
      charCode = bytes[idx];
      idx += 1;
    }
    text += charCodeToUnicode(charCode, fontData);
  }

  return text;
}

// ─── Text encoding ──────────────────────────────────────────────────────────

export interface EncodedText {
  pdfString: PDFObject;
  /** Unicode characters that couldn't be encoded */
  missing: number[];
}

/**
 * Encode a Unicode string into PDF text using the font's encoding.
 * This is the reverse of text extraction — Unicode → character codes.
 */
export function encodeTextForFont(text: string, fontData: FontData | null): EncodedText {
  if (!fontData) {
    return encodeTextWinAnsi(text);
  }

  const missing: number[] = [];

  if (fontData.isComposite) {
    // Composite font: build reverse ToUnicode map
    const reverseMap = buildReverseUnicodeMap(fontData);
    let hex = '';

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const code = reverseMap.get(char);
      if (code !== undefined && code !== 0) {
        hex += code.toString(16).padStart(4, '0');
      } else {
        // Character not in subset — do NOT write CID 0 (.notdef / invisible)
        missing.push(char.codePointAt(0)!);
        // Keep hex length aligned so caller can detect lossiness; real bytes replaced via fallback
        hex += '0000';
      }
    }

    return {
      pdfString: new PDFHexString(hex),
      missing,
    };
  } else {
    // Simple font: use encoding differences or direct mapping
    const reverseMap = buildReverseUnicodeMap(fontData);
    let result = '';

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const code = reverseMap.get(char);
      if (code !== undefined && code !== 0) {
        result += String.fromCharCode(code & 0xff);
      } else {
        const cp = char.codePointAt(0)!;
        // Subset fonts often omit `.` / digits from ToUnicode — mark missing so we
        // fall back to Helvetica instead of writing `?` or invisible glyphs.
        if (fontData.toUnicode.size > 0) {
          missing.push(cp);
          result += '?';
        } else if (cp < 256) {
          result += char;
        } else {
          missing.push(cp);
          result += '?';
        }
      }
    }

    return {
      pdfString: new PDFString(result),
      missing,
    };
  }
}

/** True for bullet / list-marker code points (and dingbat PUA stand-ins). */
function isBulletLike(cp: number): boolean {
  return (
    cp === 0x2022 || cp === 0x2023 || cp === 0x2043 || cp === 0x2219
    || cp === 0x25cf || cp === 0x25cb || cp === 0x25e6 || cp === 0x25aa
    || cp === 0x25ab || cp === 0x00b7 || cp === 0x2024 || cp === 0xfe61
    || cp === 0xff65 || (cp >= 0xf000 && cp <= 0xf0ff)
  );
}

/** WinAnsi / Latin-1 encode for Helvetica fallback — keeps `.` `a-z` etc. intact. */
export function encodeTextWinAnsi(text: string): EncodedText {
  const missing: number[] = [];
  let result = '';
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i)!;
    if (cp > 0xffff) {
      i++; // skip trailing surrogate
    }
    if (isBulletLike(cp)) {
      // WinAnsiEncoding 0x95 = • — never substitute ASCII hyphen (turns list
      // bullets into "-" whenever a run falls back to Helvetica).
      result += String.fromCharCode(0x95);
      continue;
    }
    if (cp <= 0xff) {
      result += String.fromCharCode(cp);
    } else {
      missing.push(cp);
      // Best-effort ASCII substitutes for common punctuation
      if (cp === 0x2018 || cp === 0x2019) result += "'";
      else if (cp === 0x201c || cp === 0x201d) result += '"';
      else if (cp === 0x2013 || cp === 0x2014) result += '-';
      else if (cp === 0x2026) result += '...';
      else result += '?';
    }
  }
  return { pdfString: new PDFString(result), missing };
}

/** True when encoding dropped/replaced glyphs the user typed (causes missing text / `?`). */
function isEncodingLossy(
  text: string,
  encoded: EncodedText,
  fontData: FontData | null,
): boolean {
  if (!text) return false;
  if (encoded.missing.length > 0) return true;
  if (!fontData) return false;

  if (fontData.isComposite && encoded.pdfString instanceof PDFHexString) {
    const hex = encoded.pdfString.hex.replace(/\s/g, '');
    for (let i = 0; i + 3 < hex.length; i += 4) {
      if (hex.slice(i, i + 4) === '0000') return true;
    }
  }

  if (encoded.pdfString instanceof PDFString) {
    const out = encoded.pdfString.value;
    const n = Math.min(text.length, out.length);
    for (let i = 0; i < n; i++) {
      if (text[i] !== '?' && out[i] === '?') return true;
    }
    if (out.length !== text.length) return true;

    // Type3 fonts use custom CharProcs. ASCII identity fallback in
    // buildReverseUnicodeMap can "succeed" while mapping to .notdef (g0),
    // which renders as a solid bar and must force Helvetica fallback.
    const isType3 = !!(fontData.charProcs && fontData.charProcs.size > 0);
    if (isType3) {
      let g0Hits = 0;
      for (let i = 0; i < out.length; i++) {
        const code = out.charCodeAt(i) & 0xff;
        const name = fontData.differences.get(code);
        if (name === 'g0' || (name != null && !fontData.charProcs!.has(name))) g0Hits++;
        else if (name == null && fontData.toUnicode.size > 0 && !fontData.toUnicode.has(code)) g0Hits++;
      }
      if (g0Hits > 0) return true;
    }
  }

  return false;
}

/** Insert ` /Font size Tf ` before a text-showing op. Returns number of ops inserted. */
function insertFontSwitchBefore(
  instructions: CSInstruction[],
  textIndex: number,
  fontKey: string,
  visualSize: number,
): number {
  if (textIndex < 0 || textIndex >= instructions.length) return 0;

  // Prefer the existing Tf size. Resumes often use `1 Tf` + scaled Tm — if we
  // inject absolute visual size while Tm still scales, text becomes huge.
  let size = Number.isFinite(visualSize) && visualSize > 0 ? visualSize : 12;
  for (let i = textIndex - 1; i >= 0; i--) {
    if (instructions[i].operator === 'BT') break;
    if (instructions[i].operator === 'Tf' && instructions[i].operands.length >= 2) {
      const cur = instructions[i].operands[1];
      if (cur instanceof PDFNumber && cur.value > 0) {
        size = cur.value;
      }
      break;
    }
  }

  instructions.splice(textIndex, 0, {
    operator: 'Tf',
    operands: [new PDFName(fontKey), new PDFNumber(size)],
    offset: 0,
  });
  return 1;
}

/**
 * Switch to a fallback font for one text-showing op, then restore the previous
 * font so later glyphs in the same BT block (common with Type3 per-letter fonts)
 * are not drawn with WinAnsi codes under Helvetica (e.g. Type3 E @ 0x48 → "H").
 * Returns number of ops inserted.
 */
function insertFallbackFontAround(
  instructions: CSInstruction[],
  textIndex: number,
  fallbackFont: string,
  visualSize: number,
): number {
  if (textIndex < 0 || textIndex >= instructions.length) return 0;

  let size = Number.isFinite(visualSize) && visualSize > 0 ? visualSize : 12;
  let prevFont: string | null = null;
  for (let i = textIndex - 1; i >= 0; i--) {
    if (instructions[i].operator === 'BT') break;
    if (instructions[i].operator === 'Tf' && instructions[i].operands.length >= 2) {
      const nameOp = instructions[i].operands[0];
      const sizeOp = instructions[i].operands[1];
      if (nameOp instanceof PDFName) prevFont = nameOp.name;
      if (sizeOp instanceof PDFNumber && sizeOp.value > 0) size = sizeOp.value;
      break;
    }
  }

  instructions.splice(textIndex, 0, {
    operator: 'Tf',
    operands: [new PDFName(fallbackFont), new PDFNumber(size)],
    offset: 0,
  });
  let inserted = 1;

  // text showing op is now at textIndex + 1; restore after it
  if (prevFont && prevFont !== fallbackFont) {
    instructions.splice(textIndex + 2, 0, {
      operator: 'Tf',
      operands: [new PDFName(prevFont), new PDFNumber(size)],
      offset: 0,
    });
    inserted += 1;
  }
  return inserted;
}

function buildReverseUnicodeMap(fontData: FontData): Map<string, number> {
  const reverse = new Map<string, number>();

  // ToUnicode entries take priority
  const entries = Array.from(fontData.toUnicode.entries());
  for (let i = 0; i < entries.length; i++) {
    const [code, unicode] = entries[i];
    reverse.set(unicode, code);
  }

  // Also add encoding differences
  const diffEntries = Array.from(fontData.differences.entries());
  for (let i = 0; i < diffEntries.length; i++) {
    const [code, glyphName] = diffEntries[i];
    // Simple: if the glyph name is a single character, map it
    if (glyphName.length === 1) {
      reverse.set(glyphName, code);
    }
  }

  // For simple fonts, add standard ASCII mapping — but NOT for Type3.
  // Type3 Differences often map ASCII codes to .notdef (g0); inventing
  // identity mappings makes encode look successful while drawing solid bars.
  const isType3 = !!(fontData.charProcs && fontData.charProcs.size > 0);
  if (!fontData.isComposite && !isType3) {
    for (let i = 0x20; i <= 0x7e; i++) {
      const char = String.fromCharCode(i);
      if (!reverse.has(char)) {
        reverse.set(char, i);
      }
    }
  }

  return reverse;
}

// ─── Text region erase ────────────────────────────────────────────────────────

function isTextShowingOperator(op: string): boolean {
  return op === 'Tj' || op === 'TJ' || op === "'" || op === '"';
}

/**
 * Paint a white rectangle over the text run's bounding box before replacing text.
 * Prevents longer edits from visually overlapping adjacent content.
 */
function insertEraseRectForRun(
  instructions: CSInstruction[],
  run: TextRun,
  newText: string,
  hintIndex: number,
): number {
  if (hintIndex < 0 || hintIndex >= instructions.length) return 0;

  // Always cover the ORIGINAL run bounds before rewriting. Growing still needs
  // this when subset-font glyphs / sibling fragments would otherwise ghost under
  // the replacement. Never expand the erase past the original run width.
  let btIndex = hintIndex;
  for (let i = hintIndex; i >= 0; i--) {
    if (instructions[i].operator === 'BT') {
      btIndex = i;
      break;
    }
    if (instructions[i].operator === 'ET') break;
  }

  const fontSize = run.fontSize || run.glyphs[0]?.fontSize || 12;
  const pad = Math.max(1, fontSize * 0.08);
  // Cover ONLY the original run bounds (baseline-relative)
  const eraseWidth = Math.max(run.width, fontSize * 0.5) + pad * 2;
  const ascent = fontSize * 0.85;
  const descent = fontSize * 0.25;
  const eraseHeight = ascent + descent + pad * 2;
  const eraseX = run.x - pad;
  const eraseY = run.y - descent - pad;

  const eraseOps: CSInstruction[] = [
    { operator: 'q', operands: [], offset: 0 },
    { operator: 'rg', operands: [new PDFNumber(1), new PDFNumber(1), new PDFNumber(1)], offset: 0 },
    {
      operator: 're',
      operands: [
        new PDFNumber(eraseX),
        new PDFNumber(eraseY),
        new PDFNumber(eraseWidth),
        new PDFNumber(eraseHeight),
      ],
      offset: 0,
    },
    { operator: 'f', operands: [], offset: 0 },
    { operator: 'Q', operands: [], offset: 0 },
  ];

  instructions.splice(btIndex, 0, ...eraseOps);
  return eraseOps.length;
}

// ─── Grouped text edit (multi-instruction spans) ────────────────────────────

/**
 * Replace text for a run that spans multiple Tj/TJ instructions.
 *
 * Important: put the FULL new string on the first text-showing op and clear
 * siblings. Proportional splits left undecoded/old fragments in place and
 * produced doubled/interleaved text (e.g. "PRxxxOFESSIONAL EXPERIENCEfgOFESSIONAL…").
 *
 * @returns number of instructions inserted (font switch)
 */
function applyGroupedTextEdit(
  instructions: CSInstruction[],
  sourceIndices: number[],
  newText: string,
  encoded: EncodedText,
  fallbackFont: string | null,
  run: TextRun,
  fontData: FontData | null,
): number {
  const sortedIndices = Array.from(new Set(sourceIndices)).sort((a, b) => a - b);
  let primaryIdx = -1;
  for (let i = 0; i < sortedIndices.length; i++) {
    const idx = sortedIndices[i];
    const inst = instructions[idx];
    if (inst && isTextShowingOperator(inst.operator)) {
      primaryIdx = idx;
      break;
    }
  }
  if (primaryIdx < 0) return 0;

  const empty = new PDFString('');
  const primary = instructions[primaryIdx];
  applyEncodedShowingOperands(primary, newText, encoded, fontData, !!fallbackFont);

  for (let i = 0; i < sortedIndices.length; i++) {
    const idx = sortedIndices[i];
    if (idx === primaryIdx) continue;
    const inst = instructions[idx];
    if (!inst || !isTextShowingOperator(inst.operator)) continue;
    if (inst.operator === 'TJ') {
      inst.operands = [new PDFArray([empty])];
    } else {
      inst.operands = [empty];
    }
  }

  if (fallbackFont) {
    return insertFallbackFontAround(
      instructions,
      primaryIdx,
      fallbackFont,
      runFontSize(run),
    );
  }
  return 0;
}

/** Em-fraction per Space via TJ (negative number → next glyph moves right). */
export const SPACE_TJ_EM = 0.28;
/**
 * Safety ceiling only — the old cap of 3 clipped intentional multi-space gaps
 * so glyphs after the spaces stayed left and overlapped the next run.
 */
export const SPACE_TJ_MAX_CHARS = 64;

/**
 * Extra TJ (thousandths of em) needed beyond the font's native Space advance
 * so total ≈ SPACE_TJ_EM. Subset fonts often have ~0 Space width; Standard 14
 * Helvetica Space is already ~278 — adding a full 0.28em TJ on top doubles gaps.
 */
export function spaceSupplementalTJ(
  fontData: FontData | null,
  useWinAnsi: boolean,
): number {
  const desired = Math.round(SPACE_TJ_EM * 1000);
  const glyphW = fontData?.widths?.get(32)
    ?? fontData?.widths?.get(0x20)
    ?? (useWinAnsi ? 278 : 0);
  return Math.max(0, desired - Math.max(0, glyphW));
}

/**
 * Subset/CID resume fonts often encode Space with ~0 advance. Keep space
 * glyphs (for re-interpret) and add TJ advances so gaps survive commit.
 * Advance length must match layout spaceFloor (0.28em × space count).
 */
export function buildTJWithSpaceAdvances(
  text: string,
  fontData: FontData | null,
  useWinAnsi: boolean,
): PDFArray {
  const items: PDFObject[] = [];
  const parts = text.split(/([ ]+)/);
  const supplemental = spaceSupplementalTJ(fontData, useWinAnsi);
  for (const part of parts) {
    if (!part) continue;
    if (/^ +$/.test(part)) {
      const enc = useWinAnsi ? encodeTextWinAnsi(part) : encodeTextForFont(part, fontData);
      items.push(enc.pdfString);
      if (supplemental > 0) {
        const advChars = Math.min(part.length, SPACE_TJ_MAX_CHARS);
        items.push(new PDFNumber(-Math.round(advChars * supplemental)));
      }
      continue;
    }
    const enc = useWinAnsi ? encodeTextWinAnsi(part) : encodeTextForFont(part, fontData);
    items.push(enc.pdfString);
  }
  if (items.length === 0) {
    const enc = useWinAnsi ? encodeTextWinAnsi(text) : encodeTextForFont(text, fontData);
    items.push(enc.pdfString);
  }
  return new PDFArray(items);
}

function applyEncodedShowingOperands(
  inst: CSInstruction,
  text: string,
  encoded: EncodedText,
  fontData: FontData | null,
  useWinAnsi: boolean,
): void {
  if (/ /.test(text)) {
    inst.operator = 'TJ';
    inst.operands = [buildTJWithSpaceAdvances(text, fontData, useWinAnsi)];
    return;
  }
  if (inst.operator === 'TJ') {
    inst.operands = [new PDFArray([encoded.pdfString])];
  } else {
    inst.operands = [encoded.pdfString];
  }
}

function findFontNameForInstruction(instructions: CSInstruction[], index: number): string {
  for (let i = index; i >= 0; i--) {
    if (instructions[i].operator === 'Tf') {
      const op = instructions[i].operands[0];
      return op instanceof PDFName ? op.name : '';
    }
  }
  return '';
}

// ─── Smart TJ array building ────────────────────────────────────────────────

/**
 * Build a new TJ array that preserves the spacing pattern from the original.
 * 
 * TJ arrays look like: [(Hello) -80 (World) -120 (!)]
 * The numbers between strings are kerning/spacing adjustments in thousandths
 * of a unit of text space. Destroying these numbers (as the old code did)
 * causes text to render with wrong spacing.
 * 
 * Strategy:
 * - Extract the text fragments and spacing numbers from the old array
 * - If the new text has the same length, apply character-level diff
 * - Otherwise, emit the new text as a single string but inject the average
 *   spacing at word boundaries to maintain readable spacing
 */
function buildSmartTJArray(
  oldArr: PDFArray,
  oldText: string,
  newText: string,
  encodedNewText: PDFObject,
  fontData: FontData | null,
): PDFArray {
  // Collect spacing numbers and their decoded fragment texts
  const fragments: { text: string }[] = [];
  const spacings: number[] = [];

  for (let i = 0; i < oldArr.length; i++) {
    const item = oldArr.get(i)!;
    if (item instanceof PDFNumber) {
      spacings.push(item.value);
    } else if (item instanceof PDFString) {
      fragments.push({ text: item.value });
    } else if (item instanceof PDFHexString) {
      fragments.push({ text: item.hex });
    }
  }

  if (spacings.length === 0 || fragments.length <= 1) {
    return new PDFArray([encodedNewText]);
  }

  // Same-length text: replace fragments in-place, keep all spacing numbers
  if (newText.length === oldText.length && fragments.length === spacings.length + 1) {
    const newItems: PDFObject[] = [];
    let charPos = 0;
    for (let fi = 0; fi < fragments.length; fi++) {
      const fragLen = fragments[fi].text.length;
      const fragText = newText.substring(charPos, charPos + fragLen);
      newItems.push(encodeTextForFont(fragText, fontData).pdfString);
      charPos += fragLen;
      if (fi < spacings.length) {
        newItems.push(new PDFNumber(spacings[fi]));
      }
    }
    return new PDFArray(newItems);
  }

  // Different length: split at word boundaries and distribute spacing proportionally
  const words = newText.split(/(\s+)/);
  if (words.length > 1 && spacings.length > 0) {
    const newItems: PDFObject[] = [];
    const spacingPerGap = spacings.reduce((s, v) => s + v, 0) / spacings.length;
    let wordIdx = 0;

    for (let wi = 0; wi < words.length; wi++) {
      const word = words[wi];
      if (word.length === 0) continue;
      newItems.push(encodeTextForFont(word, fontData).pdfString);
      if (wi < words.length - 1 && wordIdx < spacings.length) {
        // Use original spacing when available, average otherwise
        newItems.push(new PDFNumber(spacings[wordIdx] ?? spacingPerGap));
        wordIdx++;
      }
    }

    if (newItems.length > 0) {
      return new PDFArray(newItems);
    }
  }

  // Last resort: single string (loses justification but avoids orphan spacing)
  return new PDFArray([encodedNewText]);
}

// ─── Instruction compilation ────────────────────────────────────────────────

/**
 * Compile an array of CSInstructions back into content stream bytes.
 */
export function compileInstructions(instructions: CSInstruction[]): Uint8Array {
  const parts: string[] = [];

  for (let i = 0; i < instructions.length; i++) {
    const inst = instructions[i];

    // Write operands
    for (const op of inst.operands) {
      parts.push(serializeToString(op));
      parts.push(' ');
    }

    // Write operator
    parts.push(inst.operator);
    parts.push('\n');
  }

  const text = parts.join('');
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    bytes[i] = text.charCodeAt(i) & 0xff;
  }
  return bytes;
}

// ─── Font helpers ───────────────────────────────────────────────────────────

function loadFontForRun(
  run: TextRun,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
): FontData | null {
  return loadFontForName(run.fontName, page, objects);
}

export function loadFontForName(
  fontName: string,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
): FontData | null {
  const fontDictRef = page.resources.get('Font');
  if (!fontDictRef) return null;

  const fontDict = resolveRef(fontDictRef, objects);
  if (!(fontDict instanceof PDFDict)) return null;

  const fontRef = fontDict.get(fontName);
  if (!fontRef) return null;

  const fontObj = resolveRef(fontRef, objects);
  if (!(fontObj instanceof PDFDict)) return null;

  return loadFont(fontName, fontObj, objects);
}

// ─── Text search (for find-and-replace) ─────────────────────────────────────

/**
 * Find all occurrences of a search string in a page's text.
 * Returns the TextRuns that contain the search text.
 */
export function findTextInPage(
  contentBytes: Uint8Array,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  searchText: string,
  caseSensitive: boolean = false,
): TextRun[] {
  const interpreted = interpretPage(contentBytes, page, objects);
  const results: TextRun[] = [];

  const search = caseSensitive ? searchText : searchText.toLowerCase();

  for (const run of interpreted.textRuns) {
    const text = caseSensitive ? run.text : run.text.toLowerCase();
    if (text.includes(search)) {
      results.push(run);
    }
  }

  return results;
}

/**
 * Find and replace text in a page's content stream.
 *
 * @param occurrence When set, replace only that match (0-based, in the order
 *   `findTextMatches` lists the page's matches); otherwise replace every match.
 */
export function findAndReplace(
  contentBytes: Uint8Array,
  page: PDFPageInfo,
  objects: Map<string, PDFObject>,
  searchText: string,
  replaceText: string,
  caseSensitive: boolean = false,
  occurrence?: number,
): EditResult {
  const unchanged: EditResult = { newContentBytes: contentBytes, needsFontAugmentation: false, missingCharCodes: [] };
  const runs = interpretPage(contentBytes, page, objects).textRuns;
  let matches = findTextMatches(runs, searchText, caseSensitive);
  if (occurrence !== undefined) {
    const one = matches[occurrence];
    if (!one) return unchanged;
    matches = [one];
  }

  // A match may span several runs (see text-search.ts); edit every run it touches.
  const byChain = new Map<TextChain, TextMatch[]>();
  for (const m of matches) byChain.set(m.chain, [...(byChain.get(m.chain) ?? []), m]);
  const edits: TextEdit[] = [];
  for (const [chain, chainMatches] of byChain) {
    for (const { run, newText } of replaceInChainRuns(chain, chainMatches, replaceText)) {
      edits.push({ targetRun: run, newText });
    }
  }
  if (edits.length === 0) return unchanged;
  return applyTextEdits(contentBytes, page, objects, edits);
}
