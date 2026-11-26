/**
 * Stream Compiler
 *
 * Recompiles modified content stream tokens back into valid PDF stream bytes.
 * Handles:
 *   - Serialization of all PDF object types
 *   - FlateDecode compression of output
 *   - Stream length calculation
 *   - Multi-stream page handling (Contents as array)
 */

import {
  PDFArray,
  PDFBoolean,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFObject,
  PDFRef,
  PDFStream,
  PDFString,
} from '../types';
import { flateEncode } from '../parser/filters';
import { parseContentStream } from '../content/operator-lexer';

// ─── Content stream compilation ─────────────────────────────────────────────

/**
 * Compile a content stream from raw text bytes.
 * Optionally compresses the output using FlateDecode.
 */
export async function compileContentStream(
  contentBytes: Uint8Array,
  compress: boolean = true,
): Promise<PDFStream> {
  let streamBytes: Uint8Array;
  const dict = new PDFDict();

  if (compress) {
    streamBytes = await flateEncode(contentBytes);
    dict.set('Filter', new PDFName('FlateDecode'));
  } else {
    streamBytes = contentBytes;
  }

  dict.set('Length', new PDFNumber(streamBytes.length));

  return new PDFStream(dict, streamBytes, contentBytes);
}

/**
 * Update a page's content stream with new bytes.
 * Handles both single stream and array of streams.
 *
 * @param page The page whose content to update
 * @param newContentBytes The new decoded content stream bytes
 * @param objects The document object map (will be mutated)
 * @param compress Whether to FlateDecode compress the output
 */
export async function updatePageContent(
  contentRefs: PDFRef[],
  newContentBytes: Uint8Array,
  objects: Map<string, PDFObject>,
  compress: boolean = true,
  page?: { dict: PDFDict; contentRefs: PDFRef[] },
): Promise<PDFRef | void> {
  const newStream = await compileContentStream(newContentBytes, compress);

  if (contentRefs.length === 0) {
    let max = 0;
    for (const key of objects.keys()) {
      const num = parseInt(key.split('_')[0], 10);
      if (num > max) max = num;
    }
    const newRef = new PDFRef(max + 1, 0);
    objects.set(newRef.toKey(), newStream);
    contentRefs.push(newRef);
    if (page) {
      page.dict.set('Contents', newRef);
      if (!page.contentRefs.includes(newRef)) {
        page.contentRefs.push(newRef);
      }
    }
    return newRef;
  }

  if (contentRefs.length === 1) {
    // Single content stream — replace it
    objects.set(contentRefs[0].toKey(), newStream);
  } else {
    // Multiple content streams — replace the first one with all content,
    // and make the rest empty
    objects.set(contentRefs[0].toKey(), newStream);

    // Empty out the remaining streams
    for (let i = 1; i < contentRefs.length; i++) {
      const emptyDict = new PDFDict();
      emptyDict.set('Length', new PDFNumber(0));
      objects.set(contentRefs[i].toKey(), new PDFStream(emptyDict, new Uint8Array(0), new Uint8Array(0)));
    }
  }
}

// ─── PDF Object serialization ───────────────────────────────────────────────

/**
 * Serialize a PDF object to its byte representation for writing to a file.
 * This is used by the PDF writer (serializer.ts) for full document output.
 */
export function serializeObject(obj: PDFObject): Uint8Array {
  const text = serializeToString(obj);
  return stringToBytes(text);
}

/**
 * Serialize a PDF object to its string representation.
 */
export function serializeToString(obj: PDFObject): string {
  if (obj instanceof PDFBoolean) return obj.value ? 'true' : 'false';
  if (obj instanceof PDFNumber) return formatNumber(obj.value);
  if (obj instanceof PDFString) return serializeLiteralString(obj.value);
  if (obj instanceof PDFHexString) return `<${obj.hex}>`;
  if (obj instanceof PDFName) return serializeName(obj.name);
  if (obj instanceof PDFNull) return 'null';
  if (obj instanceof PDFRef) return `${obj.objNum} ${obj.genNum} R`;

  if (obj instanceof PDFArray) {
    const items: string[] = [];
    for (let i = 0; i < obj.length; i++) {
      items.push(serializeToString(obj.get(i)!));
    }
    return `[${items.join(' ')}]`;
  }

  if (obj instanceof PDFDict) {
    const entries: string[] = [];
    const dictEntries = Array.from(obj.entries());
    for (let i = 0; i < dictEntries.length; i++) {
      const [key, value] = dictEntries[i];
      entries.push(`${serializeName(key)} ${serializeToString(value)}`);
    }
    return `<<${entries.join(' ')}>>`;
  }

  if (obj instanceof PDFStream) {
    // Stream = dict + stream keyword + data + endstream
    const dictStr = serializeToString(obj.dict);
    // Use raw bytes for the stream data
    return dictStr; // The caller handles stream data separately
  }

  return 'null';
}

/**
 * Serialize a complete indirect object (objNum genNum obj ... endobj).
 * Includes stream data if the object is a PDFStream.
 */
export function serializeIndirectObject(
  objNum: number,
  genNum: number,
  obj: PDFObject,
): Uint8Array {
  const header = `${objNum} ${genNum} obj\n`;

  if (obj instanceof PDFStream) {
    const dictStr = serializeToString(obj.dict);
    const streamData = obj.rawBytes;

    // header + dict + \nstream\n + data + \nendstream\nendobj\n
    const prefix = stringToBytes(`${header}${dictStr}\nstream\n`);
    const suffix = stringToBytes('\nendstream\nendobj\n');

    const result = new Uint8Array(prefix.length + streamData.length + suffix.length);
    result.set(prefix, 0);
    result.set(streamData, prefix.length);
    result.set(suffix, prefix.length + streamData.length);
    return result;
  }

  const body = serializeToString(obj);
  return stringToBytes(`${header}${body}\nendobj\n`);
}

// ─── Serialization helpers ──────────────────────────────────────────────────

/**
 * Format a number, avoiding unnecessary decimals.
 * PDF spec allows up to 5 decimal places.
 */
function formatNumber(value: number): string {
  if (Number.isInteger(value)) return value.toString();

  // Use up to 5 decimal places, stripping trailing zeros
  let str = value.toFixed(5);
  // Remove trailing zeros after decimal point
  if (str.includes('.')) {
    str = str.replace(/0+$/, '');
    str = str.replace(/\.$/, '');
  }
  return str;
}

/**
 * Serialize a PDF literal string, escaping special characters.
 */
function serializeLiteralString(value: string): string {
  let escaped = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    switch (ch) {
      case 0x0a: escaped += '\\n'; break;
      case 0x0d: escaped += '\\r'; break;
      case 0x09: escaped += '\\t'; break;
      case 0x08: escaped += '\\b'; break;
      case 0x0c: escaped += '\\f'; break;
      case 0x28: escaped += '\\('; break; // (
      case 0x29: escaped += '\\)'; break; // )
      case 0x5c: escaped += '\\\\'; break; // \
      default:
        if (ch < 0x20 || ch > 0x7e) {
          // Octal escape for non-printable
          escaped += '\\' + ch.toString(8).padStart(3, '0');
        } else {
          escaped += value[i];
        }
    }
  }
  return `(${escaped})`;
}

/**
 * Serialize a PDF name, escaping characters that need #xx encoding.
 */
function serializeName(name: string): string {
  let escaped = '/';
  for (let i = 0; i < name.length; i++) {
    const ch = name.charCodeAt(i);
    // Characters that need escaping in names
    if (ch < 0x21 || ch > 0x7e || ch === 0x23 || ch === 0x28 || ch === 0x29 ||
        ch === 0x3c || ch === 0x3e || ch === 0x5b || ch === 0x5d ||
        ch === 0x7b || ch === 0x7d || ch === 0x2f || ch === 0x25) {
      escaped += '#' + ch.toString(16).padStart(2, '0');
    } else {
      escaped += name[i];
    }
  }
  return escaped;
}

// ─── Byte utilities ─────────────────────────────────────────────────────────

function stringToBytes(str: string): Uint8Array {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    bytes[i] = str.charCodeAt(i) & 0xff;
  }
  return bytes;
}

/** Operators that change the graphics (or text) state and outlive their stream. */
const STATE_OPERATORS = new Set([
  'cm', 'w', 'J', 'j', 'M', 'd', 'ri', 'i', 'gs', 'CS', 'cs', 'SC', 'SCN', 'sc', 'scn',
  'G', 'g', 'RG', 'rg', 'K', 'k', 'Tc', 'Tw', 'Tz', 'TL', 'Tf', 'Tr', 'Ts', 'W', 'W*',
]);

/**
 * Make existing page content safe to append to: when it leaves the graphics
 * state changed (a top-level `cm`, as Chromium/Skia PDFs start with
 * `.24 0 0 -.24 0 842 cm`, a colour, a clip, or unbalanced q/Q), wrap it in
 * q … Q so that whatever is drawn after it starts from the page's default
 * user space. Content that already ends in the default state is returned
 * unchanged, so repeated appends don't pile up nesting levels.
 */
export function isolateGraphicsState(content: Uint8Array): Uint8Array {
  if (content.length === 0) return content;
  let depth = 0;
  let minDepth = 0;
  let leaks = false;
  for (const ins of parseContentStream(content)) {
    if (ins.operator === 'q') depth++;
    else if (ins.operator === 'Q') minDepth = Math.min(minDepth, --depth);
    else if (depth <= 0 && STATE_OPERATORS.has(ins.operator)) leaks = true;
  }
  if (!leaks && depth === 0 && minDepth === 0) return content;
  // Extra leading q's absorb stray Q operators; the trailing Q's close every
  // level the content (and this wrapper) left open.
  const open = 1 - minDepth;
  const close = open + depth;
  const enc = new TextEncoder();
  return concatBytes(enc.encode('q\n'.repeat(open)), content, enc.encode('\n' + 'Q\n'.repeat(close)));
}

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  let totalLength = 0;
  for (const arr of arrays) totalLength += arr.length;

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
