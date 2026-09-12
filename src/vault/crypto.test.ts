import { describe, expect, test } from 'bun:test';
import { encryptVault, decryptVault, CURRENT_VERSION } from './crypto';

describe('vault crypto', () => {
  test('encrypt/decrypt round-trip', async () => {
    const plaintext = JSON.stringify({ version: CURRENT_VERSION, config: { profiles: {} }, credentials: {} });
    const passphrase = 'correct horse battery staple';
    const encrypted = await encryptVault(plaintext, passphrase);
    expect(await decryptVault(encrypted, passphrase)).toBe(plaintext);
  });

  test('encryption output is non-deterministic (random salt + iv)', async () => {
    const a = await encryptVault('hello', 'pw');
    const b = await encryptVault('hello', 'pw');
    expect(a).not.toBe(b);
  });

  test('on-disk layout is base64(salt(32) || iv(16) || ciphertext || tag(16))', async () => {
    const buf = Buffer.from(await encryptVault('x', 'pw'), 'base64');
    // salt(32) + iv(16) + at least 1 byte ciphertext + tag(16) = min 65 bytes
    expect(buf.length).toBeGreaterThanOrEqual(65);
  });

  test('wrong passphrase throws', async () => {
    const encrypted = await encryptVault('secret', 'right');
    await expect(decryptVault(encrypted, 'wrong')).rejects.toThrow();
  });

  test('tampered ciphertext throws (GCM auth tag)', async () => {
    const buf = Buffer.from(await encryptVault('secret', 'pw'), 'base64');
    // Flip a byte in the ciphertext region (after salt(32)+iv(16), before tag(16))
    buf[50] ^= 0x01;
    await expect(decryptVault(buf.toString('base64'), 'pw')).rejects.toThrow();
  });

  test('malformed input throws', async () => {
    await expect(decryptVault('not-valid-base64-!!!', 'pw')).rejects.toThrow();
    await expect(decryptVault('YWJj', 'pw')).rejects.toThrow(); // too short
  });
});
