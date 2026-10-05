import { describe, expect, test } from 'bun:test';
import { CliError } from '../../../src/utils/errors';
import { missingKeyError, toCredentials, validateKey, valuesOf } from '../../../src/plugins/secrets/store';

function codeOf(fn: () => void): string | undefined {
  try { fn(); } catch (error) { return error instanceof CliError ? error.code : 'not a CliError'; }
  return undefined;
}

describe('validateKey', () => {
  test('accepts every name an environment variable can have', () => {
    for (const key of ['A', '_', 'smtp_password', 'X1', '__proto__', 'constructor']) {
      expect(codeOf(() => validateKey(key))).toBeUndefined();
    }
  });

  test('refuses names a shell cannot export', () => {
    for (const key of ['', ' ', '1A', 'A-B', 'A.B', 'A B', 'A=B', 'É', 'A\n', '$A']) {
      expect(codeOf(() => validateKey(key))).toBe('INVALID_PARAMS');
    }
  });
});

describe('valuesOf', () => {
  test('anything that is not a map of strings reads as no secrets, not a crash', () => {
    for (const credentials of [null, undefined, {}, { values: null }, { values: [] }, { values: 'x' }, 'x', 42]) {
      expect(valuesOf(credentials).size).toBe(0);
    }
  });

  test('drops entries whose value is not a string', () => {
    const values = valuesOf({ values: { A: 'a', B: 1, C: null, D: { x: 1 } } });
    expect([...values]).toEqual([['A', 'a']]);
  });

  test('keeps keys that collide with Object.prototype', () => {
    const stored = JSON.parse('{"values":{"__proto__":"p","constructor":"c","toString":"t"}}');
    const values = valuesOf(stored);
    expect(values.get('__proto__')).toBe('p');
    expect(values.get('constructor')).toBe('c');
    expect(values.get('toString')).toBe('t');
  });

  test('an object prototype key is not a secret when it was never stored', () => {
    expect(valuesOf({ values: {} }).has('constructor')).toBe(false);
  });
});

describe('toCredentials', () => {
  test('survives a JSON round trip, __proto__ included', () => {
    const values = new Map([['__proto__', 'p'], ['A', 'line1\nline2']]);
    const back = valuesOf(JSON.parse(JSON.stringify(toCredentials(values))));
    expect([...back]).toEqual([...values]);
  });
});

describe('missingKeyError', () => {
  test('names the key and lists the ones that exist, sorted', () => {
    const error = missingKeyError('smtp', 'NOPE', new Map([['B', '1'], ['A', '2']]));
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toContain('NOPE');
    expect(error.message).toContain('smtp');
    expect(error.suggestion).toContain('A, B');
    expect(error.suggestion).not.toContain('1');
  });

  test('says the profile is empty when it is', () => {
    expect(missingKeyError('smtp', 'X', new Map()).suggestion).toContain('no secrets');
  });
});
