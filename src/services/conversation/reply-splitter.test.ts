import { describe, expect, test } from 'bun:test';
import { splitReply } from './reply-splitter';

describe('splitReply', () => {
  test('returns input unchanged when under limit', () => {
    expect(splitReply('hello', 4096)).toEqual(['hello']);
  });

  test('empty input returns empty array', () => {
    expect(splitReply('', 4096)).toEqual([]);
    expect(splitReply('   ', 4096)).toEqual([]);
  });

  test('splits at paragraph boundary when possible', () => {
    const a = 'A'.repeat(2000);
    const b = 'B'.repeat(2000);
    const text = `${a}\n\n${b}`;
    const parts = splitReply(text, 3000);
    expect(parts.length).toBe(2);
    expect(parts[0]).toBe(a);
    expect(parts[1]).toBe(b);
  });

  test('splits at sentence boundary when no paragraph break', () => {
    const a = 'A'.repeat(1500) + '.';
    const b = ' ' + 'B'.repeat(1500) + '.';
    const text = a + b;
    const parts = splitReply(text, 1600);
    expect(parts.length).toBe(2);
    expect(parts[0].endsWith('.')).toBe(true);
  });

  test('hard-splits at limit when no boundary found', () => {
    const text = 'X'.repeat(5000);
    const parts = splitReply(text, 1000);
    expect(parts.length).toBe(5);
    expect(parts.every((p) => p.length <= 1000)).toBe(true);
    expect(parts.join('')).toBe(text);
  });

  test('preserves all content across splits', () => {
    const text = 'a'.repeat(300) + '\n\n' + 'b'.repeat(300) + '\n\n' + 'c'.repeat(300);
    const parts = splitReply(text, 400);
    expect(parts.join('')).toBe(text.replace(/\n\n/g, ''));
  });
});
