/**
 * Password-protected PKCS#12 import (BE-504). Fixtures are throwaway keys made
 * with OpenSSL 3: `openssl pkcs12 -export` (PBES2/AES-256) and `-legacy`
 * (Triple DES / RC2); password "p12-secret".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importPkcs12 } from '../../signatures/certificates/pkcs12';
import { Pkcs12PasswordError } from '../../signatures/certificates/pkcs12-decrypt';

const fx = (name: string) => new Uint8Array(readFileSync(join(__dirname, 'fixtures', name)));

describe('PKCS#12 import', () => {
  it('decrypts the certificate and private key with the right password', async () => {
    const bundle = await importPkcs12(fx('test-aes.p12'), 'p12-secret');
    expect(bundle.leaf?.subject.commonName).toBe('Bloom P12 Test Signer');
    expect(bundle.key).toBeTruthy();
  });

  it('asks for a password when none is given', async () => {
    await expect(importPkcs12(fx('test-aes.p12'), '')).rejects.toBeInstanceOf(Pkcs12PasswordError);
  });

  it('reports a wrong password', async () => {
    await expect(importPkcs12(fx('test-aes.p12'), 'nope')).rejects.toThrow(/Wrong password/);
  });

  it('explains that legacy-encrypted files need re-exporting', async () => {
    await expect(importPkcs12(fx('test-legacy.p12'), 'p12-secret')).rejects.toThrow(/legacy encryption/);
  });
});
