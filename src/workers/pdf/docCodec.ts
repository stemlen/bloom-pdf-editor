/**
 * Codec between PDFDocumentData (class instances, Maps) and a plain structure that survives
 * `postMessage`'s structured clone. Structured clone drops prototypes, so a parsed document
 * can't cross the worker boundary as-is.
 *
 * Identity is preserved: a dict/array/stream reachable through several paths (e.g. the page
 * dict that is both in `objects` and in `pages[i].dict`) is encoded once and decoded back to
 * a single shared instance. The writer and editor rely on that sharing.
 *
 * Wire format: JS number = PDFNumber, boolean = PDFBoolean, null = PDFNull, anything else is a
 * tuple whose first element is a Tag.
 */

import {
  PDFArray,
  PDFBoolean,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFDocumentData,
  type PDFObject,
  type PDFPageInfo,
  type PDFRectangle,
  type XRefEntry,
} from '@/engine/types';

const enum Tag {
  Name = 0,
  String = 1,
  Hex = 2,
  Ref = 3,
  Dict = 4,
  Array = 5,
  Stream = 6,
  Seen = 7,
}

type Wire =
  | null
  | boolean
  | number
  | [Tag.Name, string]
  | [Tag.String, string]
  | [Tag.Hex, string]
  | [Tag.Ref, number, number]
  | [Tag.Dict, number, [string, Wire][]]
  | [Tag.Array, number, Wire[]]
  | [Tag.Stream, number, Wire, Uint8Array, Uint8Array | null]
  | [Tag.Seen, number];

type WirePage = Omit<PDFPageInfo, 'dict' | 'ref' | 'resources' | 'contentRefs'> & {
  dict: Wire;
  ref: Wire;
  resources: Wire;
  contentRefs: Wire[];
};

export interface EncodedDocument {
  version: string;
  objects: [string, Wire][];
  xref: { entries: [string, XRefEntry][]; trailerDict: Wire };
  catalog: Wire;
  pages: WirePage[];
  info: PDFDocumentData['info'];
  rawBytes: Uint8Array;
}

export interface EncodeResult {
  doc: EncodedDocument;
  /** Distinct ArrayBuffers referenced by `doc`; pass as the transfer list to move them. */
  buffers: ArrayBuffer[];
}

export function encodeDocument(doc: PDFDocumentData): EncodeResult {
  const ids = new Map<object, number>();
  const buffers = new Set<ArrayBuffer>();

  const noteBytes = (b: Uint8Array): Uint8Array => {
    if (b.buffer instanceof ArrayBuffer) buffers.add(b.buffer);
    return b;
  };

  const enc = (obj: PDFObject): Wire => {
    if (obj instanceof PDFNumber) return obj.value;
    if (obj instanceof PDFBoolean) return obj.value;
    if (obj instanceof PDFNull) return null;
    if (obj instanceof PDFName) return [Tag.Name, obj.name];
    if (obj instanceof PDFString) return [Tag.String, obj.value];
    if (obj instanceof PDFHexString) return [Tag.Hex, obj.hex];
    if (obj instanceof PDFRef) return [Tag.Ref, obj.objNum, obj.genNum];

    const seen = ids.get(obj);
    if (seen !== undefined) return [Tag.Seen, seen];
    const id = ids.size;
    ids.set(obj, id);

    if (obj instanceof PDFDict) {
      const entries: [string, Wire][] = [];
      for (const [k, v] of obj.entries()) entries.push([k, enc(v)]);
      return [Tag.Dict, id, entries];
    }
    if (obj instanceof PDFArray) return [Tag.Array, id, obj.items.map(enc)];
    if (obj instanceof PDFStream) {
      return [
        Tag.Stream,
        id,
        enc(obj.dict),
        noteBytes(obj.rawBytes),
        obj.decodedBytes ? noteBytes(obj.decodedBytes) : null,
      ];
    }
    throw new TypeError(`Cannot encode PDF object of type ${(obj as { _tag?: string })._tag ?? typeof obj}`);
  };

  const encoded: EncodedDocument = {
    version: doc.version,
    objects: Array.from(doc.objects, ([k, v]) => [k, enc(v)]),
    xref: {
      entries: Array.from(doc.xref.entries),
      trailerDict: enc(doc.xref.trailerDict),
    },
    catalog: enc(doc.catalog),
    pages: doc.pages.map((p) => ({
      ...p,
      mediaBox: { ...p.mediaBox },
      cropBox: { ...p.cropBox },
      dict: enc(p.dict),
      ref: enc(p.ref),
      resources: enc(p.resources),
      contentRefs: p.contentRefs.map(enc),
    })),
    info: { ...doc.info },
    rawBytes: noteBytes(doc.rawBytes),
  };
  return { doc: encoded, buffers: Array.from(buffers) };
}

export function decodeDocument(encoded: EncodedDocument): PDFDocumentData {
  const seen = new Map<number, PDFDict | PDFArray | PDFStream>();

  const dec = (w: Wire): PDFObject => {
    if (w === null) return PDFNull.instance;
    if (typeof w === 'number') return new PDFNumber(w);
    if (typeof w === 'boolean') return new PDFBoolean(w);
    switch (w[0]) {
      case Tag.Name: return new PDFName(w[1]);
      case Tag.String: return new PDFString(w[1]);
      case Tag.Hex: return new PDFHexString(w[1]);
      case Tag.Ref: return new PDFRef(w[1], w[2]);
      case Tag.Seen: {
        const existing = seen.get(w[1]);
        if (!existing) throw new Error('Corrupt document encoding: dangling back-reference');
        return existing;
      }
      case Tag.Dict: {
        const dict = new PDFDict();
        seen.set(w[1], dict);
        for (const [k, v] of w[2]) dict.set(k, dec(v));
        return dict;
      }
      case Tag.Array: {
        const arr = new PDFArray();
        seen.set(w[1], arr);
        for (const item of w[2]) arr.push(dec(item));
        return arr;
      }
      case Tag.Stream: {
        const stream = new PDFStream(dec(w[2]) as PDFDict, w[3], w[4]);
        seen.set(w[1], stream);
        return stream;
      }
    }
  };

  const objects = new Map<string, PDFObject>();
  for (const [k, v] of encoded.objects) objects.set(k, dec(v));

  const trailerDict = dec(encoded.xref.trailerDict) as PDFDict;
  const catalog = dec(encoded.catalog) as PDFDict;

  const pages: PDFPageInfo[] = encoded.pages.map((p) => ({
    ...p,
    mediaBox: { ...p.mediaBox } as PDFRectangle,
    cropBox: { ...p.cropBox } as PDFRectangle,
    dict: dec(p.dict) as PDFDict,
    ref: dec(p.ref) as PDFRef,
    resources: dec(p.resources) as PDFDict,
    contentRefs: p.contentRefs.map((r) => dec(r) as PDFRef),
  }));

  return {
    version: encoded.version,
    objects,
    xref: { entries: new Map(encoded.xref.entries), trailerDict },
    catalog,
    pages,
    info: { ...encoded.info },
    rawBytes: encoded.rawBytes,
  };
}
