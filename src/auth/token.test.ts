import { describe, expect, test } from 'bun:test';
import { decodeToken, encodeToken, TOKEN_PREFIX } from './token';

describe('composite token', () => {
  const parts = { url: 'https://vault.example.com', kid: 'a1b2c3d4', secret: 's3cr3t-s3cr3t' };

  test('round-trips and keeps the metadata readable', () => {
    const token = encodeToken(parts);
    expect(token.startsWith(`${TOKEN_PREFIX}.`)).toBe(true);
    expect(token.endsWith(`.${parts.secret}`)).toBe(true);
    const meta = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    expect(meta).toEqual({ v: 1, url: parts.url, kid: parts.kid });
    expect(decodeToken(token)).toEqual(parts);
  });

  test('tolerates surrounding whitespace from a paste', () => {
    expect(decodeToken(`  ${encodeToken(parts)}\n`)).toEqual(parts);
  });

  test.each([
    ['empty', ''],
    ['wrong prefix', 'agio2.eyJ2IjoxfQ.x'],
    ['missing secret', `${TOKEN_PREFIX}.eyJ2IjoxfQ`],
    ['extra part', `${encodeToken(parts)}.extra`],
    ['bad base64 json', `${TOKEN_PREFIX}.!!!.x`],
    ['wrong version', `${TOKEN_PREFIX}.${Buffer.from('{"v":2,"url":"u","kid":"k"}').toString('base64url')}.x`],
    ['missing kid', `${TOKEN_PREFIX}.${Buffer.from('{"v":1,"url":"u"}').toString('base64url')}.x`],
  ])('rejects a malformed token (%s)', (_label, token) => {
    expect(() => decodeToken(token)).toThrow(expect.objectContaining({ code: 'CONFIG_ERROR' }));
  });
});
