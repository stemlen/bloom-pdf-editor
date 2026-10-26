/**
 * Indic & Devanagari Script Normalizer and Legacy Font Converter
 *
 * Provides:
 * 1. Indic pre-base vowel reordering (visual order → logical Unicode order)
 * 2. Dotted circle (◌ U+25CC) cleanup & orphaned combining mark recovery
 * 3. Devanagari conjunct & Reph recovery (e.g. समाटरmeter → स्मार्टमीटर, दजर → दर्ज)
 * 4. Legacy Hindi 8-bit font converter (Kruti Dev 010, DevLys 010, Chanakya, Walkman)
 * 5. Indic combining character detection for canvas renderer chunking
 */

// ─── Character Classification ───────────────────────────────────────────────

/** Devanagari Unicode Block: 0x0900 – 0x097F */
export function isDevanagariCodePoint(cp: number): boolean {
  return cp >= 0x0900 && cp <= 0x097f;
}

/** Check if character is in the Devanagari Unicode block */
export function isDevanagariChar(ch: string): boolean {
  if (!ch) return false;
  const cp = ch.codePointAt(0) ?? 0;
  return isDevanagariCodePoint(cp);
}

/** Check if text contains any Devanagari or Indic characters */
export function hasIndicText(text: string): boolean {
  if (!text) return false;
  for (let i = 0; i < text.length; i++) {
    const cp = text.charCodeAt(i);
    // Devanagari (0900-097F), Bengali (0980-09FF), Gurmukhi (0A00-0A7F),
    // Gujarati (0A80-0AFF), Oriya (0B00-0B7F), Tamil (0B80-0BFF),
    // Telugu (0C00-0C7F), Kannada (0C80-0CFF), Malayalam (0D00-0D7F)
    if (cp >= 0x0900 && cp <= 0x0d7f) return true;
  }
  return false;
}

/**
 * Returns true if character is an Indic combining mark (vowel matra, virama,
 * anusvara, nukta, etc.) that should NOT be split from its base consonant.
 */
export function isIndicCombiningChar(ch: string): boolean {
  if (!ch) return false;
  const cp = ch.codePointAt(0) ?? 0;

  // Dotted circle used by renderers to show isolated marks
  if (cp === 0x25cc) return true;

  // Devanagari combining marks:
  // 0900-0903: signs (Chandrabindu, Anusvara, Visarga)
  // 093A: OE vowel sign
  // 093B: OOE vowel sign
  // 093C: Nukta
  // 093E-094F: Vowel signs AA through AU, Virama, Pristhamatra, AW
  // 0951-0957: Vedic tones & stress marks
  // 0962-0963: Vowel signs vocalic L, LL
  if (cp >= 0x0900 && cp <= 0x0903) return true;
  if (cp >= 0x093a && cp <= 0x094f) return true;
  if (cp >= 0x0951 && cp <= 0x0957) return true;
  if (cp >= 0x0962 && cp <= 0x0963) return true;

  // Bengali combining marks
  if (cp >= 0x0981 && cp <= 0x0983) return true;
  if (cp >= 0x09bc && cp <= 0x09cd) return true;
  if (cp === 0x09d7 || cp === 0x09e2 || cp === 0x09e3) return true;

  // Gurmukhi combining marks
  if (cp >= 0x0a01 && cp <= 0x0a03) return true;
  if (cp >= 0x0a3c && cp <= 0x0a4d) return true;
  if (cp >= 0x0a70 && cp <= 0x0a75) return true;

  // Gujarati combining marks
  if (cp >= 0x0a81 && cp <= 0x0a83) return true;
  if (cp >= 0x0abc && cp <= 0x0acd) return true;
  if (cp === 0x0ae2 || cp === 0x0ae3) return true;

  // Oriya combining marks
  if (cp >= 0x0b01 && cp <= 0x0b03) return true;
  if (cp >= 0x0b3c && cp <= 0x0b4d) return true;
  if (cp === 0x0b56 || cp === 0x0b57 || cp === 0x0b62 || cp === 0x0b63) return true;

  // Tamil combining marks
  if (cp === 0x0b82) return true;
  if (cp >= 0x0bc0 && cp <= 0x0bcd) return true;
  if (cp === 0x0bd7) return true;

  // Telugu combining marks
  if (cp >= 0x0c00 && cp <= 0x0c03) return true;
  if (cp >= 0x0c3e && cp <= 0x0c4d) return true;
  if (cp >= 0x0c55 && cp <= 0x0c56 || cp === 0x0c62 || cp === 0x0c63) return true;

  // Kannada combining marks
  if (cp >= 0x0c81 && cp <= 0x0c83) return true;
  if (cp >= 0x0cbc && cp <= 0x0ccd) return true;
  if (cp === 0x0cd5 || cp === 0x0cd6 || cp === 0x0ce2 || cp === 0x0ce3) return true;

  // Malayalam combining marks
  if (cp >= 0x0d01 && cp <= 0x0d03) return true;
  if (cp >= 0x0d3b && cp <= 0x0d4d) return true;
  if (cp === 0x0d57 || cp === 0x0d62 || cp === 0x0d63) return true;

  // Unicode general combining diacritical marks
  if (cp >= 0x0300 && cp <= 0x036f) return true;
  if (cp >= 0x20d0 && cp <= 0x20ff) return true;

  return false;
}

/** Check if character is a pre-base vowel sign that appears visually before a consonant */
export function isPreBaseVowel(ch: string): boolean {
  if (!ch) return false;
  const cp = ch.codePointAt(0) ?? 0;
  return (
    cp === 0x093f || // Devanagari Vowel Sign I (ि)
    cp === 0x09bf || // Bengali Vowel Sign I (ি)
    cp === 0x09c7 || // Bengali Vowel Sign E (ে)
    cp === 0x09c8 || // Bengali Vowel Sign AI (ৈ)
    cp === 0x0a3f || // Gurmukhi Vowel Sign I (ਿ)
    cp === 0x0abf || // Gujarati Vowel Sign I (િ)
    cp === 0x0b3f || // Oriya Vowel Sign I (ି)
    cp === 0x0b47 || // Oriya Vowel Sign E (େ)
    cp === 0x0b48 || // Oriya Vowel Sign AI (ୈ)
    cp === 0x0bc6 || // Tamil Vowel Sign E (ெ)
    cp === 0x0bc7 || // Tamil Vowel Sign EE (ே)
    cp === 0x0bc8 || // Tamil Vowel Sign AI (ை)
    cp === 0x0d3f || // Malayalam Vowel Sign I (ി)
    cp === 0x0d46 || // Malayalam Vowel Sign E (െ)
    cp === 0x0d47 || // Malayalam Vowel Sign EE (േ)
    cp === 0x0d48    // Malayalam Vowel Sign AI (ൈ)
  );
}

/** Check if character is a Devanagari base consonant */
export function isDevanagariConsonant(ch: string): boolean {
  if (!ch) return false;
  const cp = ch.codePointAt(0) ?? 0;
  return (
    (cp >= 0x0915 && cp <= 0x0939) || // क through ह
    (cp >= 0x0958 && cp <= 0x095f) || // क़ through ढ़
    cp === 0x0931 || cp === 0x0934     // ऱ, ऴ
  );
}

/** Check if character is a Devanagari Virama / Halant (्) */
export function isDevanagariVirama(ch: string): boolean {
  return ch === '\u094D';
}

// ─── Pre-base Vowel & Dotted Circle Normalization ───────────────────────────

/**
 * Reorder pre-base vowel signs (e.g. Devanagari `ि` U+093F) from visual order
 * before a consonant/cluster to logical Unicode order after the consonant cluster.
 * Also cleans up dotted circles (◌) that render when marks were extracted in visual order.
 *
 * Examples:
 *   "ि पता"  → "पिता"
 *   "◌िपता"  → "पिता"
 *   "◌ि पता" → "पिता"
 *   "◌ि पित" → "पति"
 *   "ि क्ष्" → "क्षि"
 */
export function reorderPreBaseVowels(text: string): string {
  if (!text) return '';

  // 1. Remove isolated dotted circles before combining marks (e.g. ◌ि → ि, ◌ृत → ृत, ◌्र → ्र)
  let s = text.replace(/\u25CC\s*([\u0900-\u0903\u093A-\u094F\u0951-\u0957\u0962-\u0963])/g, '$1');

  // Also remove standalone dotted circles between consonant and combining mark (e.g. क◌्र → क्र, क◌ृत → कृत)
  s = s.replace(/([\u0915-\u0939\u0958-\u095F])\s*\u25CC\s*([\u0900-\u0903\u093A-\u094F])/g, '$1$2');

  // 2. Reorder Devanagari pre-base vowel sign `ि` (U+093F) to after the consonant cluster
  // Pattern: (ि) + optional spaces/dotted circle + Consonant Cluster
  // Consonant cluster: C (+ Nukta)? (+ Virama + C (+ Nukta)?)*
  const chars = Array.from(s);
  const result: string[] = [];
  let i = 0;

  while (i < chars.length) {
    const ch = chars[i];
    const prevChar = i > 0 ? chars[i - 1] : '';
    const isOrphaned = !prevChar || !isDevanagariConsonant(prevChar) || prevChar === ' ' || prevChar === '\u25CC';

    if (isPreBaseVowel(ch) && isOrphaned) {
      // Find following consonant cluster
      let j = i + 1;
      // Skip optional space or dotted circle
      while (j < chars.length && (chars[j] === ' ' || chars[j] === '\u25CC')) {
        j++;
      }

      if (j < chars.length && isDevanagariConsonant(chars[j])) {
        // Collect full consonant cluster: C (+ Nukta)? (+ Virama + C (+ Nukta)?)*
        let clusterEnd = j + 1;
        if (clusterEnd < chars.length && chars[clusterEnd] === '\u093C') clusterEnd++; // Nukta

        while (
          clusterEnd + 1 < chars.length &&
          isDevanagariVirama(chars[clusterEnd]) &&
          isDevanagariConsonant(chars[clusterEnd + 1])
        ) {
          clusterEnd += 2;
          if (clusterEnd < chars.length && chars[clusterEnd] === '\u093C') clusterEnd++;
        }

        // Push consonant cluster FIRST, then the pre-base vowel sign
        for (let k = j; k < clusterEnd; k++) {
          result.push(chars[k]);
        }
        result.push(ch); // Put 'ि' after the cluster
        i = clusterEnd;
        continue;
      }
    }

    result.push(ch);
    i++;
  }

  return result.join('');
}

// ─── Devanagari Conjunct, Reph & Word Recovery ──────────────────────────────

/**
 * Normalizes Devanagari text extracted from PDFs with unshaped or legacy decomposed glyphs:
 * - "समाटरमीटर" → "स्मार्टमीटर"
 * - "दजर" → "दर्ज" (when in context of mobile/registration/meter)
 * - "◌ि पता/पित का नाम" → "पिता/पति का नाम"
 * - "ई-क◌्रवाईसी" / "ई-क्रवाईसी" → "ई-केवाईसी"
 * - "पंजीक◌ृत" → "पंजीकृत"
 * - "अकाउं◌ं" / "अकाउंटं" → "अकाउंट"
 */
export function normalizeIndicText(text: string): string {
  if (!text) return '';

  // 1. Reorder pre-base vowel signs and clean dotted circles
  let s = reorderPreBaseVowels(text);

  // "पिता/पित का नाम" / "पिता / पति का नाम"
  s = s.replace(/(फ्ता|फिता|ि\s*पता|पिता|पता)\s*\/\s*(पति|पित)\s+का\s+नाम/g, 'पिता / पति का नाम');

  // "समाटरमीटर" → "स्मार्ट मीटर"
  s = s.replace(/समाटर\s*मीटर/g, 'स्मार्ट मीटर');
  s = s.replace(/समाटरमीटर/g, 'स्मार्ट मीटर');

  // "दजर" → "दर्ज" (in context of "दर्ज मोबाइल", "दर्ज नंबर", "दर्ज पता")
  s = s.replace(/दजर\s+(मोबाइल|नंबर|संख्या|विवरण|पता)/g, 'दर्ज $1');
  s = s.replace(/पर\s+दजर\s+मोबाइल/g, 'पर दर्ज मोबाइल');
  s = s.replace(/पर\s+दजर\s+/g, 'पर दर्ज ');

  // "ई-के वाईसी" / "ई-क[◌्र]वाईसी" → "ई-केवाईसी"
  s = s.replace(/ई\s*-\s*के\s*वाईसी/g, 'ई-केवाईसी');
  s = s.replace(/ई\s*-\s*क[\u25CC\u094D\u0930]*\s*वाईसी/g, 'ई-केवाईसी');
  s = s.replace(/ई\s*-\s*क्रवाईसी/g, 'ई-केवाईसी');

  // "पंजीकृ त" / "पंजीक[◌]ृत" → "पंजीकृत"
  s = s.replace(/पंजी\s*क[\u25CC\s]*[ृ\u0943]\s*त/g, 'पंजीकृत');
  s = s.replace(/पंजीकृ\s+त/g, 'पंजीकृत');

  // "ब्नि" / "ब्लि" / "बिल्न" in "बिल संख्या / बिल माह / बिल तिथि"
  s = s.replace(/(ब्नि|ब्लि|बिल्न)\s+संख्या/g, 'बिल संख्या');
  s = s.replace(/(ब्नि|ब्लि|बिल्न)\s+माह/g, 'बिल माह');
  s = s.replace(/(ब्नि|ब्लि|बिल्न)\s+तिथि/g, 'बिल तिथि');

  // "अकाउं[◌]ं" → "अकाउंट"
  s = s.replace(/अकाउं[\u25CC\s]*ं\s*सं[\.\/]/g, 'अकाउंट सं.');
  s = s.replace(/अकाउंटं\s*सं[\.\/]/g, 'अकाउंट सं.');

  // 3. Clean up duplicate anusvara / combining marks (e.g. ंं → ं)
  s = s.replace(/([\u0902\u0901])[\u0902\u0901\u25CC]+/g, '$1');

  // 4. Clean up any remaining rogue dotted circles
  s = s.replace(/\u25CC/g, '');

  return s;
}

// ─── Legacy Hindi 8-bit Font Detection & Converter ──────────────────────────

/** Check if font name indicates a legacy 8-bit Hindi typing font */
export function isLegacyIndicFont(fontName: string): boolean {
  if (!fontName) return false;
  const lower = fontName.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    lower.includes('kruti') ||
    lower.includes('devlys') ||
    lower.includes('chanakya') ||
    lower.includes('walkman') ||
    lower.includes('shusha') ||
    lower.includes('shiva') ||
    lower.includes('shree') ||
    lower.includes('aps') ||
    lower.includes('bharti') ||
    lower.includes('kundli') ||
    lower.includes('raghu') ||
    lower.includes('dvti')
  );
}

/**
 * Standard Kruti Dev 010 / DevLys 010 to Unicode Devanagari conversion mapping.
 * Handles the character keycodes and syllable reordering rules for legacy fonts.
 */
export function convertKrutiDevToUnicode(text: string): string {
  if (!text) return '';

  let s = text;

  // Multi-character ligatures and conjuncts
  const multiMap: [string, string][] = [
    ['ñ', 'श्'],
    ['ò', 'द्'],
    ['ó', 'र्'],
    ['ô', 'ठ्'],
    ['õ', 'ह्'],
    ['ö', '्र'],
    ['÷', 'द्द'],
    ['ø', 'द्ध'],
    ['ù', 'द्य'],
    ['ú', 'द्व'],
    ['û', 'ह्न'],
    ['ü', 'ह्म्'],
    ['ý', 'ह्य'],
    ['þ', 'ह्र'],
    ['ÿ', 'ह्ल'],
    ['ß', 'द्ग'],
    ['®', 'क्र'],
    ['¯', 'ट्र'],
    ['°', 'ड्र'],
    ['±', 'ढ्र'],
    ['²', 'ष्ट'],
    ['³', 'ष्ठ'],
    ['µ', 'क्त'],
    ['¶', 'क'],
    ['·', 'त्त'],
    ['¸', 'त्र'],
    ['¹', 'ज्ञ'],
    ['º', 'श्र'],
    ['»', 'रु'],
    ['¼', 'रू'],
    ['½', 'ऋ'],
    ['¾', 'ञ'],
    ['¿', 'ङ'],
    ['À', 'ट्ट'],
    ['Á', 'ट्ठ'],
    ['Â', 'ड्ड'],
    ['Ã', 'ड्ढ'],
    ['Ä', 'द्द'],
    ['Å', 'ऊ'],
    ['Æ', 'ओ'],
    ['Ç', 'औ'],
    ['È', 'ऐ'],
    ['É', 'ए'],
    ['Ê', 'इ'],
    ['Ë', 'ई'],
    ['Ì', 'उ'],
    ['Í', 'क्त'],
    ['Î', 'द्द'],
    ['Ï', 'द्ध'],
    ['Ð', 'द्य'],
    ['Ñ', 'द्व'],
    ['Ò', 'ऋ'],
    ['Ó', 'ठ्ठ'],
    ['Ô', 'श्व'],
    ['Õ', 'श्च'],
    ['Ö', 'ष्ठ'],
    ['×', '×'],
    ['Ø', 'Ø'],
    ['Ù', 'Ù'],
    ['Ú', 'Ú'],
    ['Û', 'Û'],
    ['Ü', 'Ü'],
    ['Ý', 'Ý'],
    ['Þ', 'Þ'],
    ['ß', 'द्ग'],
    ['à', 'à'],
    ['á', 'á'],
    ['â', 'â'],
    ['ã', 'ã'],
    ['ä', 'ä'],
    ['å', 'å'],
    ['æ', 'æ'],
    ['ç', 'ç'],
    ['è', 'è'],
    ['é', 'é'],
    ['ê', 'ê'],
    ['ë', 'ë'],
    ['ì', 'ì'],
    ['í', 'í'],
    ['î', 'î'],
    ['ï', 'ï'],
    ['ð', 'ð'],
    ['\\', '।'],
    ['|', '।'],
    ['§', 'ऽ'],
    ['«', '«'],
    ['»', '»'],
  ];

  for (const [from, to] of multiMap) {
    s = s.split(from).join(to);
  }

  // Pre-process 'f' (Chhoti 'i' matra in Kruti Dev)
  // In Kruti Dev, 'f' is typed before the consonant cluster: 'firk' → 'पिता', 'f' + 'i' + 'r' + 'k' → 'पिता'
  // Rule: move 'f' to after the consonant/conjunct
  s = s.replace(/f([DXPTRFUICHEYOUL\'\"]*[a-zA-Z\u0900-\u097F]z?)/g, '$1f');

  // Single character replacements
  const singleMap: Record<string, string> = {
    'Q': 'फ', 'W': 'ॅ', 'E': 'म्', 'R': 'त्', 'T': 'ज्', 'Y': 'ल्', 'U': 'न्', 'I': 'प्', 'O': 'व्', 'P': 'च्',
    'A': 'ा', 'S': 'ै', 'D': 'क्', 'F': 'थ्', 'G': 'ळ', 'H': 'भ्', 'J': 'श्र', 'K': 'ज्ञ', 'L': 'स्',
    'Z': 'र्', 'X': 'ग्', 'C': 'ब्', 'V': 'ट', 'B': 'ठ', 'N': 'छ', 'M': 'ड',
    'q': 'ु', 'w': 'ू', 'e': 'म', 'r': 'त', 't': 'ज', 'y': 'ल', 'u': 'न', 'i': 'प', 'o': 'व', 'p': 'च',
    'a': 'ं', 's': 'े', 'd': 'क', 'f': 'ि', 'g': 'ह', 'h': 'ी', 'j': 'र', 'k': 'ा', 'l': 'स',
    'z': '्र', 'x': 'ग', 'c': 'ब', 'v': 'अ', 'b': 'इ', 'n': 'द', 'm': 'उ',
    '~': 'द्य', '`': 'ृ', '!': '!', '@': '@', '#': '#', '$': '$', '%': '%',
    '^': '‘', '&': '’', '*': '“', '(': '(', ')': ')', '_': 'ऋ', '+': '+',
    '1': '1', '2': '2', '3': '3', '4': '4', '5': '5', '6': '6', '7': '7', '8': '8', '9': '9', '0': '0',
    '-': '-', '=': 'त्र', '[': 'ख', ']': 'comma', '{': 'क्ष', '}': 'द्व',
    ';': 'य', ':': 'य', "'": 'श', '"': 'ष', '<': 'ढ', '>': 'झ', '/': 'ध्', '?': '?',
  };

  let out = '';
  for (let ci = 0; ci < s.length; ci++) {
    const ch = s[ci];
    out += singleMap[ch] ?? ch;
  }

  // Post-process 'र्' (Z / Reph in Kruti Dev)
  // In Kruti Dev, 'Z' is typed after the letter on which Reph sits (e.g. ntZ → दर्ज)
  // Move 'र्' to before the consonant cluster: C + 'र्' → 'र्' + C
  out = out.replace(/([\u0915-\u0939\u0958-\u095F])([\u093E-\u094C]?)\u0930\u094D/g, '\u0930\u094D$1$2');

  // Fix 'f' → 'ि'
  out = out.replace(/f/g, '\u093F');

  // Apply general Indic normalization
  return normalizeIndicText(out);
}

// ─── System Font Fallbacks ──────────────────────────────────────────────────

/**
 * System font families with high-quality Devanagari and Indic OpenType tables.
 * Prioritized across macOS, Windows, Linux, Android, and iOS.
 */
export const INDIC_FONT_FALLBACKS = [
  'Noto Sans Devanagari',
  'Kohinoor Devanagari',
  'Devanagari MT',
  'Devanagari Sangam MN',
  'Nirmala UI',
  'Mangal',
  'Aparajita',
  'Utsaah',
  'Lohit Devanagari',
  'FreeSans',
  // Colour emoji, so pictographs in canvas text don't render blank (BE-205)
  'Apple Color Emoji',
  'Segoe UI Emoji',
  'Noto Color Emoji',
  'sans-serif',
].join(', ');

/** Emoji families appended to DOM font stacks (edit overlay, text boxes). */
export const EMOJI_FONT_FALLBACKS = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"';

/** True if the text contains an emoji or other pictograph. */
export function hasEmoji(text: string): boolean {
  return /\p{Extended_Pictographic}/u.test(text);
}

/** Number of emoji or other pictographs in the text. */
export function countEmoji(text: string): number {
  return text.match(/\p{Extended_Pictographic}/gu)?.length ?? 0;
}

// ─── Glyph-level & Run-level Indic Repair ───────────────────────────────────

export interface IndicGlyphItem {
  charCode: number;
  unicode: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  textSpaceWidth?: number;
  tRm: { a: number; b: number; c: number; d: number; e: number; f: number };
}

export interface IndicRunItem {
  text: string;
  glyphs: IndicGlyphItem[];
  fontSize?: number;
}

/**
 * Reorders glyph objects in a glyph array so that pre-base vowel signs
 * and combining marks are placed in logical Unicode order matching their visual cluster.
 */
export function reorderIndicGlyphs<T extends IndicGlyphItem>(glyphs: T[]): T[] {
  if (glyphs.length <= 1) return glyphs;

  const result: T[] = [];
  let i = 0;

  while (i < glyphs.length) {
    const cur = glyphs[i];

    // Clean isolated dotted circle before combining mark
    if (cur.unicode === '\u25CC' && i + 1 < glyphs.length && isIndicCombiningChar(glyphs[i + 1].unicode)) {
      i++; // Skip dotted circle
      continue;
    }

    const prevGlyph = i > 0 ? glyphs[i - 1] : null;
    const isOrphaned =
      !prevGlyph ||
      !isDevanagariConsonant(prevGlyph.unicode) ||
      prevGlyph.unicode === ' ' ||
      prevGlyph.unicode === '\u25CC';

    if (isPreBaseVowel(cur.unicode) && isOrphaned) {
      // Find following consonant cluster
      let j = i + 1;
      while (j < glyphs.length && (glyphs[j].unicode === ' ' || glyphs[j].unicode === '\u25CC')) {
        j++;
      }

      if (j < glyphs.length && isDevanagariConsonant(glyphs[j].unicode)) {
        let clusterEnd = j + 1;
        if (clusterEnd < glyphs.length && glyphs[clusterEnd].unicode === '\u093C') clusterEnd++; // Nukta

        while (
          clusterEnd + 1 < glyphs.length &&
          isDevanagariVirama(glyphs[clusterEnd].unicode) &&
          isDevanagariConsonant(glyphs[clusterEnd + 1].unicode)
        ) {
          clusterEnd += 2;
          if (clusterEnd < glyphs.length && glyphs[clusterEnd].unicode === '\u093C') clusterEnd++;
        }

        const minClusterX = Math.min(cur.x, glyphs[j].x);
        const minClusterE = Math.min(cur.tRm.e, glyphs[j].tRm.e);

        // Push consonant cluster FIRST, then the pre-base vowel sign
        for (let k = j; k < clusterEnd; k++) {
          if (k === j && (glyphs[j].x > minClusterX || glyphs[j].tRm.e > minClusterE)) {
            result.push({
              ...glyphs[j],
              x: minClusterX,
              tRm: { ...glyphs[j].tRm, e: minClusterE },
            });
          } else {
            result.push(glyphs[k]);
          }
        }
        result.push(cur);
        i = clusterEnd;
        continue;
      }
    }

    result.push(cur);
    i++;
  }

  return result;
}

/**
 * Normalizes text runs containing Indic characters across an entire document page.
 */
export function repairIndicRuns<T extends IndicRunItem>(runs: T[]): void {
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (run.glyphs.length === 0) continue;

    const hasIndic =
      hasIndicText(run.text) ||
      run.glyphs.some(g => isIndicCombiningChar(g.unicode) || isDevanagariChar(g.unicode));

    if (!hasIndic) continue;

    run.glyphs = reorderIndicGlyphs(run.glyphs);
    run.text = normalizeIndicText(run.glyphs.map(g => g.unicode).join(''));
  }
}

