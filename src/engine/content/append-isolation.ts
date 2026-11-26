/**
 * Appending new content (text boxes, copied lines, table cells) to the end of
 * a page's content stream assumes the default graphics state: identity CTM,
 * no clip, default text state. Many producers don't leave it that way —
 * Chrome/Skia PDFs start with a bare `.24 0 0 -.24 0 842 cm` (y flipped and
 * scaled) that is never restored — so anything appended inherits that
 * transform and lands mirrored, tiny or off the page.
 *
 * These helpers wrap the existing content in `q … Q` (closing any `q` the
 * producer left open) when, and only when, it leaks state, so the appended
 * operators start from the default state.
 */

import { parseContentStream, type CSInstruction } from './operator-lexer';

/**
 * Operators that change graphics/text state that appended content may rely on:
 * CTM, ExtGState (opacity, blend), clipping, line style, colour, and text state
 * (scale, rise, render mode, spacing, leading). Wrapping is always safe, so err
 * on the side of including an operator. Tf is left out: appended text always
 * sets its own font, and fonts affect nothing else.
 */
const STATE_OPS = new Set([
  'cm', 'w', 'J', 'j', 'M', 'd', 'ri', 'i', 'gs', 'CS', 'cs', 'SC', 'SCN', 'sc', 'scn',
  'G', 'g', 'RG', 'rg', 'K', 'k', 'Tc', 'Tw', 'Tz', 'TL', 'Tr', 'Ts', 'W', 'W*',
]);

export interface StateLeak {
  /** True when content appended after this stream would not start from the default state. */
  leaks: boolean;
  /** `q` operators needed in front so no `Q` in the stream pops below the wrapper. */
  prefix: number;
  /** `Q` operators needed after the stream to restore the state saved by the prefix. */
  suffix: number;
}

export function analyzeStateLeak(instructions: CSInstruction[]): StateLeak {
  let depth = 0;
  let minDepth = 0;
  let leaks = false;
  for (const { operator } of instructions) {
    if (operator === 'q') depth++;
    else if (operator === 'Q') {
      depth--;
      if (depth < minDepth) minDepth = depth;
    } else if (depth <= 0 && STATE_OPS.has(operator)) {
      leaks = true;
    }
  }
  if (depth !== 0 || minDepth < 0) leaks = true;
  if (!leaks) return { leaks: false, prefix: 0, suffix: 0 };
  const prefix = 1 - minDepth;
  return { leaks: true, prefix, suffix: prefix + depth };
}

const op = (operator: string): CSInstruction => ({ operator, operands: [], offset: 0 });

/**
 * Instruction-level form: returns `instructions` wrapped so that anything
 * pushed after the result runs in the default graphics state. Returns the
 * same array when no wrapping is needed. Existing instruction indices shift
 * by `prefix` when wrapped.
 */
export function isolateInstructionsForAppend(instructions: CSInstruction[]): CSInstruction[] {
  const leak = analyzeStateLeak(instructions);
  if (!leak.leaks) return instructions;
  return [
    ...Array.from({ length: leak.prefix }, () => op('q')),
    ...instructions,
    ...Array.from({ length: leak.suffix }, () => op('Q')),
  ];
}

/**
 * Byte-level form: `contentBytes` followed by `injection`, with the original
 * bytes kept verbatim and wrapped in `q … Q` only when they leak state.
 */
export function appendIsolatedContent(contentBytes: Uint8Array, injection: Uint8Array): Uint8Array {
  const leak = analyzeStateLeak(parseContentStream(contentBytes));
  const enc = new TextEncoder();
  const head = enc.encode(leak.leaks ? 'q\n'.repeat(leak.prefix) : '');
  const tail = enc.encode(leak.leaks ? `\n${'Q\n'.repeat(leak.suffix)}` : '');
  const out = new Uint8Array(head.length + contentBytes.length + tail.length + injection.length);
  let o = 0;
  out.set(head, o); o += head.length;
  out.set(contentBytes, o); o += contentBytes.length;
  out.set(tail, o); o += tail.length;
  out.set(injection, o);
  return out;
}
