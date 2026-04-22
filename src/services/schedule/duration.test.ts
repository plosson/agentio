import { describe, expect, test } from 'bun:test';
import { parseDuration } from './duration';

describe('parseDuration', () => {
  test('parses minutes', () => {
    expect(parseDuration('30m')).toBe(30);
    expect(parseDuration('1m')).toBe(1);
  });
  test('parses hours', () => {
    expect(parseDuration('2h')).toBe(120);
  });
  test('parses compound', () => {
    expect(parseDuration('1h30m')).toBe(90);
    expect(parseDuration('2h5m')).toBe(125);
  });
  test('rejects invalid input', () => {
    expect(() => parseDuration('')).toThrow();
    expect(() => parseDuration('abc')).toThrow();
    expect(() => parseDuration('30')).toThrow();
    expect(() => parseDuration('0m')).toThrow();
    expect(() => parseDuration('0h0m')).toThrow();
  });
});
