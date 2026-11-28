/**
 * Core PDF Object Types
 *
 * PDF files are built from a small set of primitive types:
 *   - Boolean, Integer, Real, String, HexString, Name, Null
 *   - Array, Dictionary, Stream
 *   - Indirect Reference (obj_num gen_num R)
 *
 * We model each as a distinct class so we can use `instanceof` checks
 * throughout the parser, renderer, and editor.
 */

// ─── Primitive wrappers ────────────────────────────────────────────────────

export class PDFName {
  readonly _tag = 'PDFName' as const;
  constructor(public readonly name: string) {}
  toString(): string { return `/${this.name}`; }
  equals(other: PDFName): boolean { return this.name === other.name; }
}

export class PDFString {
  readonly _tag = 'PDFString' as const;
  constructor(public readonly value: string) {}
  /** Raw bytes (for binary strings). Stores decoded bytes. */
  toBytes(): Uint8Array {
    const bytes = new Uint8Array(this.value.length);
    for (let i = 0; i < this.value.length; i++) {
      bytes[i] = this.value.charCodeAt(i) & 0xff;
    }
    return bytes;
  }
  toString(): string { return `(${this.value})`; }
}

export class PDFHexString {
  readonly _tag = 'PDFHexString' as const;
  constructor(public readonly hex: string) {}
  /** Decode hex string to raw bytes */
  toBytes(): Uint8Array {
    const clean = this.hex.replace(/\s/g, '');
    // Pad with trailing 0 if odd length (per PDF spec)
    const padded = clean.length % 2 === 1 ? clean + '0' : clean;
    const bytes = new Uint8Array(padded.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(padded.substring(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }
  /** Decode hex pairs to a string (latin-1) */
  toText(): string {
    const bytes = this.toBytes();
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }
  toString(): string { return `<${this.hex}>`; }
}

export class PDFNumber {
  readonly _tag = 'PDFNumber' as const;
  constructor(public readonly value: number) {}
  toString(): string { return String(this.value); }
}

export class PDFBoolean {
  readonly _tag = 'PDFBoolean' as const;
  constructor(public readonly value: boolean) {}
  toString(): string { return this.value ? 'true' : 'false'; }
}

export class PDFNull {
  readonly _tag = 'PDFNull' as const;
  private static _instance: PDFNull | null = null;
  static get instance(): PDFNull {
    if (!PDFNull._instance) PDFNull._instance = new PDFNull();
    return PDFNull._instance;
  }
  toString(): string { return 'null'; }
}

// ─── Indirect reference ────────────────────────────────────────────────────

export class PDFRef {
  readonly _tag = 'PDFRef' as const;
  constructor(
    public readonly objNum: number,
    public readonly genNum: number,
  ) {}
  toKey(): string { return `${this.objNum}_${this.genNum}`; }
  toString(): string { return `${this.objNum} ${this.genNum} R`; }
  equals(other: PDFRef): boolean {
    return this.objNum === other.objNum && this.genNum === other.genNum;
  }
}

// ─── Composite types ───────────────────────────────────────────────────────

export class PDFArray {
  readonly _tag = 'PDFArray' as const;
  constructor(public readonly items: PDFObject[] = []) {}
  get length(): number { return this.items.length; }
  get(index: number): PDFObject | undefined { return this.items[index]; }
  push(item: PDFObject): void { this.items.push(item); }

  /** Helper: get all items as numbers (returns NaN for non-numbers) */
  asNumbers(): number[] {
    return this.items.map((it) =>
      it instanceof PDFNumber ? it.value : NaN,
    );
  }
  toString(): string { return `[${this.items.map(String).join(' ')}]`; }
}

export class PDFDict {
  readonly _tag = 'PDFDict' as const;
  private readonly map: Map<string, PDFObject>;

  constructor(entries?: [string, PDFObject][]) {
    this.map = new Map(entries);
  }

  get(key: string): PDFObject | undefined { return this.map.get(key); }
  set(key: string, value: PDFObject): void { this.map.set(key, value); }
  has(key: string): boolean { return this.map.has(key); }
  delete(key: string): boolean { return this.map.delete(key); }
  entries(): IterableIterator<[string, PDFObject]> { return this.map.entries(); }
  keys(): IterableIterator<string> { return this.map.keys(); }
  values(): IterableIterator<PDFObject> { return this.map.values(); }
  get size(): number { return this.map.size; }

  // ── Typed accessors for common patterns ──

  /** Resolve a key expecting a PDFName, return the name string or undefined */
  getName(key: string): string | undefined {
    const v = this.map.get(key);
    return v instanceof PDFName ? v.name : undefined;
  }

  /** Resolve a key expecting a PDFNumber, return the number or undefined */
  getNumber(key: string): number | undefined {
    const v = this.map.get(key);
    return v instanceof PDFNumber ? v.value : undefined;
  }

  /** Resolve a key expecting a PDFBoolean */
  getBool(key: string): boolean | undefined {
    const v = this.map.get(key);
    return v instanceof PDFBoolean ? v.value : undefined;
  }

  /** Resolve a key expecting a PDFArray */
  getArray(key: string): PDFArray | undefined {
    const v = this.map.get(key);
    return v instanceof PDFArray ? v : undefined;
  }

  /** Resolve a key expecting a PDFDict */
  getDict(key: string): PDFDict | undefined {
    const v = this.map.get(key);
    return v instanceof PDFDict ? v : undefined;
  }

  /** Resolve a key that should be a PDFString or PDFHexString, return text */
  getString(key: string): string | undefined {
    const v = this.map.get(key);
    if (v instanceof PDFString) return v.value;
    if (v instanceof PDFHexString) return v.toText();
    return undefined;
  }

  /** Resolve a key that may be a PDFRef */
  getRef(key: string): PDFRef | undefined {
    const v = this.map.get(key);
    return v instanceof PDFRef ? v : undefined;
  }

  toString(): string {
    const entries: string[] = [];
    Array.from(this.map.entries()).forEach(([k, v]) => entries.push(`/${k} ${v}`));
    return `<< ${entries.join(' ')} >>`;
  }
}

export class PDFStream {
  readonly _tag = 'PDFStream' as const;
  constructor(
    public readonly dict: PDFDict,
    /** Raw (possibly compressed) stream bytes */
    public rawBytes: Uint8Array,
    /** Decoded (decompressed) bytes — populated after filter application */
    public decodedBytes: Uint8Array | null = null,
  ) {}

  /** Get the effective bytes (decoded if available, raw otherwise) */
  getBytes(): Uint8Array {
    return this.decodedBytes ?? this.rawBytes;
  }

  /** Length from the dictionary (pre-decode) */
  get length(): number {
    return this.dict.getNumber('Length') ?? this.rawBytes.length;
  }

  /** Filter names */
  getFilters(): string[] {
    const f = this.dict.get('Filter');
    if (f instanceof PDFName) return [f.name];
    if (f instanceof PDFArray) {
      return f.items
        .filter((it): it is PDFName => it instanceof PDFName)
        .map((n) => n.name);
    }
    return [];
  }

  /** Decode parameters (array of dicts, one per filter) */
  getDecodeParams(): (PDFDict | null)[] {
    const dp = this.dict.get('DecodeParms');
    if (dp instanceof PDFDict) return [dp];
    if (dp instanceof PDFArray) {
      return dp.items.map((it) => (it instanceof PDFDict ? it : null));
    }
    if (dp instanceof PDFNull) return [null];
    return [];
  }
}

// ─── Union type for any PDF object ─────────────────────────────────────────

export type PDFObject =
  | PDFBoolean
  | PDFNumber
  | PDFString
  | PDFHexString
  | PDFName
  | PDFNull
  | PDFArray
  | PDFDict
  | PDFStream
  | PDFRef;

// ─── Cross-reference entry ─────────────────────────────────────────────────

export interface XRefEntry {
  /** Object number */
  objNum: number;
  /** Generation number */
  genNum: number;
  /** Byte offset in the file (for uncompressed objects) */
  offset: number;
  /** Whether this entry is in use ('n') or free ('f') */
  type: 'n' | 'f';
  /** For compressed objects: the object number of the containing ObjStm */
  compressedObjNum?: number;
  /** For compressed objects: the index within the ObjStm */
  compressedIndex?: number;
}

export interface XRefTable {
  entries: Map<string, XRefEntry>; // keyed by "objNum_genNum"
  trailerDict: PDFDict;
}

// ─── High-level document structures ────────────────────────────────────────

export interface PDFRectangle {
  x: number;     // lower-left x
  y: number;     // lower-left y
  width: number;
  height: number;
}

export interface PDFPageInfo {
  /** 0-based index */
  index: number;
  /** The page dictionary object */
  dict: PDFDict;
  /** MediaBox in PDF coordinate space */
  mediaBox: PDFRectangle;
  /** CropBox (defaults to MediaBox if absent) */
  cropBox: PDFRectangle;
  /** Page rotation in degrees (0, 90, 180, 270) */
  rotate: number;
  /** Indirect ref to the page object (for back-references) */
  ref: PDFRef;
  /** The Resources dictionary (may be inherited from parent) */
  resources: PDFDict;
  /** Content stream references (single ref or array of refs) */
  contentRefs: PDFRef[];
}

export interface PDFDocumentInfo {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  creationDate?: string;
  modDate?: string;
}

/**
 * The top-level parsed PDF document.
 * Contains the object graph, page tree, and document metadata.
 */
export interface PDFDocumentData {
  /** PDF version from header (e.g. "1.7", "2.0") */
  version: string;
  /** All indirect objects keyed by "objNum_genNum" */
  objects: Map<string, PDFObject>;
  /** The merged cross-reference table */
  xref: XRefTable;
  /** Catalog dictionary (root of the document) */
  catalog: PDFDict;
  /** Parsed page info array */
  pages: PDFPageInfo[];
  /** Document info dictionary */
  info: PDFDocumentInfo;
  /** The raw file bytes (kept for incremental saves) */
  rawBytes: Uint8Array;
  /**
   * File encryption key, set once an encrypted document has been opened or a
   * document has been given a password. Objects in memory are then plaintext;
   * the writer encrypts them with this key (and trailer /Encrypt) on save.
   */
  encryptionKey?: Uint8Array;
}
