import { expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { createPkcePair } from '../../src/auth/pkce';

test('the challenge is the S256 of the verifier, and pairs never repeat', () => {
  const a = createPkcePair();
  const b = createPkcePair();
  expect(a.challenge).toBe(createHash('sha256').update(a.verifier).digest('base64url'));
  expect(a.verifier).not.toBe(b.verifier);
  expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
});
