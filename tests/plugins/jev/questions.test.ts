import { describe, expect, test } from 'bun:test';
import { parseLevels, parseOptions, parseState, parseThreshold, requireQuestion } from '../../../src/plugins/jev/questions';

describe('parseThreshold', () => {
  test('numbers from 0 to 1 are accepted, ends included', () => {
    expect(parseThreshold('0')).toBe(0);
    expect(parseThreshold('1')).toBe(1);
    expect(parseThreshold(' 0.75 ')).toBe(0.75);
  });

  test('anything else is refused, never read as NaN', () => {
    for (const bad of ['', '  ', 'abc', '1.5', '-0.1', 'NaN', 'Infinity', '0.5x', '1e3']) {
      expect(() => parseThreshold(bad)).toThrow('--threshold');
    }
  });
});

describe('parseOptions', () => {
  test('key=description pairs keep everything after the first =', () => {
    expect(parseOptions(['billing=Charges, invoices', 'shipping=a=b'])).toEqual({ billing: 'Charges, invoices', shipping: 'a=b' });
  });

  test('fewer than two, a missing =, a blank key or description, and a duplicate key are refused', () => {
    expect(() => parseOptions([])).toThrow('at least two');
    expect(() => parseOptions(['only=one'])).toThrow('at least two');
    expect(() => parseOptions(['a=x', 'noequals'])).toThrow('key=description');
    expect(() => parseOptions(['a=x', ' =y'])).toThrow('key=description');
    expect(() => parseOptions(['a=x', 'b= '])).toThrow('key=description');
    expect(() => parseOptions(['a=x', 'a=y'])).toThrow('twice');
  });

  test('more than 255 options are refused', () => {
    const many = Array.from({ length: 256 }, (_, i) => `k${i}=d`);
    expect(() => parseOptions(many)).toThrow('255');
  });
});

describe('parseLevels', () => {
  test('two to ten levels, trimmed, in order', () => {
    expect(parseLevels([' Cosmetic', 'Blocking '])).toEqual(['Cosmetic', 'Blocking']);
  });

  test('fewer than two, more than ten, or a blank level are refused', () => {
    expect(() => parseLevels(['one'])).toThrow('2 to 10');
    expect(() => parseLevels(Array.from({ length: 11 }, (_, i) => `l${i}`))).toThrow('2 to 10');
    expect(() => parseLevels(['a', '  '])).toThrow('blank');
  });
});

describe('parseState', () => {
  test('a JSON object or array is sent as JSON', () => {
    expect(parseState(' {"a":1} ')).toEqual({ a: 1 });
    expect(parseState('[1,2]')).toEqual([1, 2]);
  });

  test('everything else is text, including JSON scalars and broken JSON', () => {
    expect(parseState('"quoted"')).toBe('"quoted"');
    expect(parseState('42')).toBe('42');
    expect(parseState('{not json')).toBe('{not json');
    expect(parseState('héllo 👋')).toBe('héllo 👋');
  });

  test('blank input is refused', () => {
    expect(() => parseState(' \n ')).toThrow('No input');
  });
});

test('a blank question is refused', () => {
  expect(() => requireQuestion('  ')).toThrow('question');
  expect(requireQuestion(' Is it? ')).toBe('Is it?');
});
