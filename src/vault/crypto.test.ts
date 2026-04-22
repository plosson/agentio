import { describe, expect, test } from 'bun:test';
import { encryptVault, decryptVault, CURRENT_VERSION } from './crypto';

describe('vault crypto', () => {
  test('encrypt/decrypt round-trip', () => {
    const plaintext = JSON.stringify({ version: CURRENT_VERSION, config: { profiles: {} }, credentials: {} });
    const passphrase = 'correct horse battery staple';
    const encrypted = encryptVault(plaintext, passphrase);
    const decrypted = decryptVault(encrypted, passphrase);
    expect(decrypted).toBe(plaintext);
  });

  test('encryption output is non-deterministic (random salt + iv)', () => {
    const plaintext = 'hello';
    const passphrase = 'pw';
    const a = encryptVault(plaintext, passphrase);
    const b = encryptVault(plaintext, passphrase);
    expect(a).not.toBe(b);
  });

  test('on-disk layout is base64(salt(32) || iv(16) || ciphertext || tag(16))', () => {
    const encrypted = encryptVault('x', 'pw');
    const buf = Buffer.from(encrypted, 'base64');
    // salt(32) + iv(16) + at least 1 byte ciphertext + tag(16) = min 65 bytes
    expect(buf.length).toBeGreaterThanOrEqual(65);
  });

  test('wrong passphrase throws', () => {
    const encrypted = encryptVault('secret', 'right');
    expect(() => decryptVault(encrypted, 'wrong')).toThrow();
  });

  test('tampered ciphertext throws (GCM auth tag)', () => {
    const encrypted = encryptVault('secret', 'pw');
    const buf = Buffer.from(encrypted, 'base64');
    // Flip a byte in the ciphertext region (after salt(32)+iv(16), before tag(16))
    buf[50] ^= 0x01;
    const tampered = buf.toString('base64');
    expect(() => decryptVault(tampered, 'pw')).toThrow();
  });

  test('malformed input throws', () => {
    expect(() => decryptVault('not-valid-base64-!!!', 'pw')).toThrow();
    expect(() => decryptVault('YWJj', 'pw')).toThrow(); // too short
  });
});
