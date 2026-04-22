import { describe, expect, test } from 'bun:test';
import { parseWeekdays, weekdayNames } from './weekdays';

describe('parseWeekdays', () => {
  test('parses names (case-insensitive)', () => {
    expect(parseWeekdays('mon,wed,fri')).toEqual([1, 3, 5]);
    expect(parseWeekdays('Mon, Wed, Fri')).toEqual([1, 3, 5]);
    expect(parseWeekdays('sun')).toEqual([7]);
  });
  test('parses numbers 1..7', () => {
    expect(parseWeekdays('1,3,5')).toEqual([1, 3, 5]);
    expect(parseWeekdays('7')).toEqual([7]);
  });
  test('sorts and dedupes', () => {
    expect(parseWeekdays('fri,mon,mon')).toEqual([1, 5]);
  });
  test('rejects invalid', () => {
    expect(() => parseWeekdays('')).toThrow();
    expect(() => parseWeekdays('xyz')).toThrow();
    expect(() => parseWeekdays('0')).toThrow();
    expect(() => parseWeekdays('8')).toThrow();
  });
});

describe('weekdayNames', () => {
  test('returns canonical names', () => {
    expect(weekdayNames([1, 3, 5])).toBe('Mon, Wed, Fri');
  });
});
