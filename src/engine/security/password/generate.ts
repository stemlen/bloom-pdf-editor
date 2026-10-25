const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_!@#%';

/** Cryptographically random password (default 20 chars, ~118 bits). */
export function generateStrongPassword(length = 20): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  // 256 is not a multiple of the alphabet size; reject biased bytes.
  const limit = 256 - (256 % PASSWORD_ALPHABET.length);
  let out = '';
  while (out.length < length) {
    for (const b of bytes) {
      if (b < limit && out.length < length) out += PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length];
    }
    globalThis.crypto.getRandomValues(bytes);
  }
  return out;
}
