/**
 * PDF Lexer — Byte-level tokenizer for PDF files
 *
 * Reads raw Uint8Array bytes and emits typed tokens.
 * Handles all PDF token types per ISO 32000-2:
 *   - Integers and reals
 *   - Literal strings (with escape sequences and nested parens)
 *   - Hex strings
 *   - Name objects
 *   - Booleans, null
 *   - Keywords (obj, endobj, stream, endstream, xref, trailer, startxref, R)
 *   - Comments
 */

// ─── Token types ───────────────────────────────────────────────────────────

export const enum TokenType {
  Integer = 'Integer',
  Real = 'Real',
  String = 'String',
  HexString = 'HexString',
  Name = 'Name',
  Boolean = 'Boolean',
  Null = 'Null',
  Keyword = 'Keyword',
  Comment = 'Comment',
  EOF = 'EOF',
}

export interface Token {
  type: TokenType;
  value: string | number | boolean | null;
  /** Byte offset in the file where this token starts */
  offset: number;
}

// ─── Character classification ──────────────────────────────────────────────

const SPACE = 0x20;   // ' '
const TAB = 0x09;     // '\t'
const LF = 0x0a;      // '\n'
const CR = 0x0d;      // '\r'
const FF = 0x0c;      // '\f'
const NULL_BYTE = 0x00;

const LPAREN = 0x28;  // '('
const RPAREN = 0x29;  // ')'
const LANGLE = 0x3c;  // '<'
const RANGLE = 0x3e;  // '>'
const LBRACKET = 0x5b; // '['
const RBRACKET = 0x5d; // ']'
const LBRACE = 0x7b;  // '{'
const RBRACE = 0x7d;  // '}'
const SLASH = 0x2f;   // '/'
const PERCENT = 0x25;  // '%'
const BACKSLASH = 0x5c; // '\'
const HASH = 0x23;    // '#'

const PLUS = 0x2b;    // '+'
const MINUS = 0x2d;   // '-'
const DOT = 0x2e;     // '.'

function isWhitespace(ch: number): boolean {
  return ch === SPACE || ch === TAB || ch === LF || ch === CR || ch === FF || ch === NULL_BYTE;
}

function isDelimiter(ch: number): boolean {
  return (
    ch === LPAREN || ch === RPAREN ||
    ch === LANGLE || ch === RANGLE ||
    ch === LBRACKET || ch === RBRACKET ||
    ch === LBRACE || ch === RBRACE ||
    ch === SLASH || ch === PERCENT
  );
}

function isDigit(ch: number): boolean {
  return ch >= 0x30 && ch <= 0x39; // '0'-'9'
}

function isHexDigit(ch: number): boolean {
  return (
    (ch >= 0x30 && ch <= 0x39) ||   // '0'-'9'
    (ch >= 0x41 && ch <= 0x46) ||   // 'A'-'F'
    (ch >= 0x61 && ch <= 0x66)      // 'a'-'f'
  );
}

function isEOL(ch: number): boolean {
  return ch === LF || ch === CR;
}

// ─── Lexer ─────────────────────────────────────────────────────────────────

export class PDFLexer {
  private readonly data: Uint8Array;
  private pos: number;
  private readonly length: number;

  constructor(data: Uint8Array, startOffset: number = 0) {
    this.data = data;
    this.pos = startOffset;
    this.length = data.length;
  }

  /** Current byte position */
  get position(): number { return this.pos; }
  set position(p: number) { this.pos = p; }

  /** Whether we've reached the end of the data */
  get isEOF(): boolean { return this.pos >= this.length; }

  /** Peek at current byte without advancing */
  peek(): number {
    return this.pos < this.length ? this.data[this.pos] : -1;
  }

  /** Peek at byte at an offset from current position */
  peekAt(offset: number): number {
    const idx = this.pos + offset;
    return idx < this.length ? this.data[idx] : -1;
  }

  /** Read current byte and advance */
  private read(): number {
    return this.pos < this.length ? this.data[this.pos++] : -1;
  }

  /** Skip all whitespace and comments */
  skipWhitespaceAndComments(): void {
    while (this.pos < this.length) {
      const ch = this.data[this.pos];
      if (isWhitespace(ch)) {
        this.pos++;
        continue;
      }
      if (ch === PERCENT) {
        // Skip comment until end of line
        this.pos++;
        while (this.pos < this.length && !isEOL(this.data[this.pos])) {
          this.pos++;
        }
        continue;
      }
      break;
    }
  }

  /** Skip only whitespace (not comments) */
  skipWhitespace(): void {
    while (this.pos < this.length && isWhitespace(this.data[this.pos])) {
      this.pos++;
    }
  }

  /**
   * Read the next token from the byte stream.
   * Returns null at EOF.
   */
  nextToken(): Token | null {
    this.skipWhitespaceAndComments();
    if (this.pos >= this.length) {
      return { type: TokenType.EOF, value: null, offset: this.pos };
    }

    const offset = this.pos;
    const ch = this.data[this.pos];

    // ── Literal string: (...) ──
    if (ch === LPAREN) return this.readLiteralString(offset);

    // ── Hex string or dict delimiter: < or << ──
    if (ch === LANGLE) {
      if (this.peekAt(1) === LANGLE) {
        this.pos += 2;
        return { type: TokenType.Keyword, value: '<<', offset };
      }
      return this.readHexString(offset);
    }

    // ── Dict close: >> ──
    if (ch === RANGLE) {
      if (this.peekAt(1) === RANGLE) {
        this.pos += 2;
        return { type: TokenType.Keyword, value: '>>', offset };
      }
      // Single > shouldn't appear outside hex strings, but handle gracefully
      this.pos++;
      return { type: TokenType.Keyword, value: '>', offset };
    }

    // ── Array delimiters ──
    if (ch === LBRACKET) {
      this.pos++;
      return { type: TokenType.Keyword, value: '[', offset };
    }
    if (ch === RBRACKET) {
      this.pos++;
      return { type: TokenType.Keyword, value: ']', offset };
    }

    // ── Name object: /Name ──
    if (ch === SLASH) return this.readName(offset);

    // ── Number: starts with digit, +, -, or . ──
    if (isDigit(ch) || ch === PLUS || ch === MINUS || ch === DOT) {
      return this.readNumber(offset);
    }

    // ── Regular keyword or boolean/null ──
    return this.readKeyword(offset);
  }

  // ─── Literal string: (...)  ───────────────────────────────────────────────

  private readLiteralString(offset: number): Token {
    this.pos++; // skip opening '('
    let depth = 1;
    let result = '';

    while (this.pos < this.length && depth > 0) {
      const ch = this.data[this.pos];

      if (ch === BACKSLASH) {
        this.pos++;
        if (this.pos >= this.length) break;
        const esc = this.data[this.pos];
        switch (esc) {
          case 0x6e: result += '\n'; this.pos++; break;  // \n
          case 0x72: result += '\r'; this.pos++; break;  // \r
          case 0x74: result += '\t'; this.pos++; break;  // \t
          case 0x62: result += '\b'; this.pos++; break;  // \b
          case 0x66: result += '\f'; this.pos++; break;  // \f
          case LPAREN: result += '('; this.pos++; break;  // \(
          case RPAREN: result += ')'; this.pos++; break;  // \)
          case BACKSLASH: result += '\\'; this.pos++; break; // \\
          case CR:
            // Line continuation: \<CR> or \<CR><LF>
            this.pos++;
            if (this.pos < this.length && this.data[this.pos] === LF) this.pos++;
            break;
          case LF:
            // Line continuation: \<LF>
            this.pos++;
            break;
          default:
            // Octal escape: \ddd (1-3 octal digits)
            if (esc >= 0x30 && esc <= 0x37) {
              let octal = esc - 0x30;
              this.pos++;
              if (this.pos < this.length && this.data[this.pos] >= 0x30 && this.data[this.pos] <= 0x37) {
                octal = octal * 8 + (this.data[this.pos] - 0x30);
                this.pos++;
                if (this.pos < this.length && this.data[this.pos] >= 0x30 && this.data[this.pos] <= 0x37) {
                  octal = octal * 8 + (this.data[this.pos] - 0x30);
                  this.pos++;
                }
              }
              result += String.fromCharCode(octal & 0xff);
            } else {
              // Unknown escape — ignore the backslash per spec
              result += String.fromCharCode(esc);
              this.pos++;
            }
            break;
        }
        continue;
      }

      if (ch === LPAREN) {
        depth++;
        result += '(';
        this.pos++;
        continue;
      }

      if (ch === RPAREN) {
        depth--;
        if (depth > 0) {
          result += ')';
        }
        this.pos++;
        continue;
      }

      // Normalize CR and CR+LF to LF
      if (ch === CR) {
        result += '\n';
        this.pos++;
        if (this.pos < this.length && this.data[this.pos] === LF) this.pos++;
        continue;
      }

      result += String.fromCharCode(ch);
      this.pos++;
    }

    return { type: TokenType.String, value: result, offset };
  }

  // ─── Hex string: <...> ───────────────────────────────────────────────────

  private readHexString(offset: number): Token {
    this.pos++; // skip opening '<'
    let hex = '';

    while (this.pos < this.length) {
      const ch = this.data[this.pos];
      if (ch === RANGLE) {
        this.pos++;
        break;
      }
      if (isWhitespace(ch)) {
        this.pos++;
        continue;
      }
      if (isHexDigit(ch)) {
        hex += String.fromCharCode(ch);
        this.pos++;
      } else {
        // Invalid hex char — skip per spec
        this.pos++;
      }
    }

    return { type: TokenType.HexString, value: hex, offset };
  }

  // ─── Name object: /Name ──────────────────────────────────────────────────

  private readName(offset: number): Token {
    this.pos++; // skip '/'
    let name = '';

    while (this.pos < this.length) {
      const ch = this.data[this.pos];
      if (isWhitespace(ch) || isDelimiter(ch)) break;

      // Handle #xx hex escapes in names (PDF 1.2+)
      if (ch === HASH && this.pos + 2 < this.length) {
        const h1 = this.data[this.pos + 1];
        const h2 = this.data[this.pos + 2];
        if (isHexDigit(h1) && isHexDigit(h2)) {
          const hex = String.fromCharCode(h1) + String.fromCharCode(h2);
          name += String.fromCharCode(parseInt(hex, 16));
          this.pos += 3;
          continue;
        }
      }

      name += String.fromCharCode(ch);
      this.pos++;
    }

    return { type: TokenType.Name, value: name, offset };
  }

  // ─── Number (integer or real) ─────────────────────────────────────────────

  private readNumber(offset: number): Token {
    let numStr = '';
    let isReal = false;
    const startPos = this.pos;

    // Optional sign
    if (this.data[this.pos] === PLUS || this.data[this.pos] === MINUS) {
      numStr += String.fromCharCode(this.data[this.pos]);
      this.pos++;
    }

    // Check if we actually have digits after sign
    if (this.pos < this.length && !isDigit(this.data[this.pos]) && this.data[this.pos] !== DOT) {
      // Not a number — rewind and read as keyword
      this.pos = startPos;
      return this.readKeyword(offset);
    }

    // Integer part
    while (this.pos < this.length && isDigit(this.data[this.pos])) {
      numStr += String.fromCharCode(this.data[this.pos]);
      this.pos++;
    }

    // Decimal point
    if (this.pos < this.length && this.data[this.pos] === DOT) {
      isReal = true;
      numStr += '.';
      this.pos++;

      // Fractional part
      while (this.pos < this.length && isDigit(this.data[this.pos])) {
        numStr += String.fromCharCode(this.data[this.pos]);
        this.pos++;
      }
    }

    // Edge case: just "." or "+." — not a valid number
    if (numStr === '.' || numStr === '+.' || numStr === '-.') {
      this.pos = startPos;
      return this.readKeyword(offset);
    }

    const num = isReal ? parseFloat(numStr) : parseInt(numStr, 10);
    return {
      type: isReal ? TokenType.Real : TokenType.Integer,
      value: num,
      offset,
    };
  }

  // ─── Keyword / boolean / null ─────────────────────────────────────────────

  private readKeyword(offset: number): Token {
    let word = '';

    while (this.pos < this.length) {
      const ch = this.data[this.pos];
      if (isWhitespace(ch) || isDelimiter(ch)) break;
      word += String.fromCharCode(ch);
      this.pos++;
    }

    // A stray delimiter with no token of its own (")", "{", "}"): consume it so
    // callers always make progress on damaged data instead of looping forever.
    if (word === '' && this.pos < this.length) {
      word = String.fromCharCode(this.data[this.pos]);
      this.pos++;
    }

    if (word === 'true') return { type: TokenType.Boolean, value: true, offset };
    if (word === 'false') return { type: TokenType.Boolean, value: false, offset };
    if (word === 'null') return { type: TokenType.Null, value: null, offset };

    return { type: TokenType.Keyword, value: word, offset };
  }

  // ─── Utility methods for the parser ───────────────────────────────────────

  /**
   * Read raw bytes from the current position.
   * Used for reading stream data after the 'stream' keyword.
   */
  readBytes(count: number): Uint8Array {
    const end = Math.min(this.pos + count, this.length);
    const bytes = this.data.slice(this.pos, end);
    this.pos = end;
    return bytes;
  }

  /**
   * Skip past the EOL after the 'stream' keyword.
   * Per PDF spec: "stream" keyword is followed by a single EOL (CR, LF, or CRLF).
   */
  skipStreamEOL(): void {
    if (this.pos < this.length && this.data[this.pos] === CR) {
      this.pos++;
      if (this.pos < this.length && this.data[this.pos] === LF) {
        this.pos++;
      }
    } else if (this.pos < this.length && this.data[this.pos] === LF) {
      this.pos++;
    }
  }

  /**
   * Search backwards from `startPos` for a string pattern.
   * Returns the byte offset where the pattern starts, or -1.
   */
  searchBackward(pattern: string, startPos?: number): number {
    const start = startPos ?? this.length - 1;
    const patternBytes = new Uint8Array(pattern.length);
    for (let i = 0; i < pattern.length; i++) {
      patternBytes[i] = pattern.charCodeAt(i);
    }

    outer:
    for (let i = start; i >= 0; i--) {
      for (let j = 0; j < patternBytes.length; j++) {
        if (i + j >= this.length || this.data[i + j] !== patternBytes[j]) {
          continue outer;
        }
      }
      return i;
    }
    return -1;
  }

  /**
   * Search forward from current position for a string pattern.
   * Returns the byte offset where the pattern starts, or -1.
   */
  searchForward(pattern: string, startPos?: number): number {
    const start = startPos ?? this.pos;
    const patternBytes = new Uint8Array(pattern.length);
    for (let i = 0; i < pattern.length; i++) {
      patternBytes[i] = pattern.charCodeAt(i);
    }

    const limit = this.length - patternBytes.length;
    outer:
    for (let i = start; i <= limit; i++) {
      for (let j = 0; j < patternBytes.length; j++) {
        if (this.data[i + j] !== patternBytes[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  /**
   * Read a line of text (up to EOL) from current position.
   * Useful for reading the PDF header line.
   */
  readLine(): string {
    let line = '';
    while (this.pos < this.length) {
      const ch = this.data[this.pos];
      if (ch === CR) {
        this.pos++;
        if (this.pos < this.length && this.data[this.pos] === LF) this.pos++;
        break;
      }
      if (ch === LF) {
        this.pos++;
        break;
      }
      line += String.fromCharCode(ch);
      this.pos++;
    }
    return line;
  }

  /**
   * Read a chunk of ASCII text for debug/inspection purposes.
   */
  peekString(maxLen: number = 40): string {
    let s = '';
    const end = Math.min(this.pos + maxLen, this.length);
    for (let i = this.pos; i < end; i++) {
      const ch = this.data[i];
      s += (ch >= 0x20 && ch <= 0x7e) ? String.fromCharCode(ch) : '.';
    }
    return s;
  }
}
