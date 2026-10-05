import { describe, expect, test } from 'bun:test';
import { CliError } from '../../../src/utils/errors';
import { parseDotenv } from '../../../src/plugins/secrets/dotenv';

function failure(text: string): CliError {
  try { parseDotenv(text); } catch (error) { if (error instanceof CliError) return error; throw error; }
  throw new Error('expected parseDotenv to fail');
}

describe('parseDotenv', () => {
  test('plain, exported, blank and comment lines', () => {
    const values = parseDotenv('# comment\n\nA=1\nexport B=2\n   # indented comment\nC = 3 \n');
    expect([...values]).toEqual([['A', '1'], ['B', '2'], ['C', '3']]);
  });

  test('only the first = splits; the rest belong to the value', () => {
    expect(parseDotenv('URL=postgres://u:p@h/db?a=b=c').get('URL')).toBe('postgres://u:p@h/db?a=b=c');
  });

  test('an empty value is allowed', () => {
    expect(parseDotenv('EMPTY=\nQUOTED=""').get('EMPTY')).toBe('');
    expect(parseDotenv('QUOTED=""').get('QUOTED')).toBe('');
  });

  test('unquoted values end at " #", but a # inside a word stays', () => {
    const values = parseDotenv('A=abc # note\nB=abc#def');
    expect(values.get('A')).toBe('abc');
    expect(values.get('B')).toBe('abc#def');
  });

  test('double quotes keep spaces and #, and read \\n \\" \\\\', () => {
    const values = parseDotenv('A="  x # y  "\nB="l1\\nl2"\nC="say \\"hi\\""\nD="back\\\\slash"\nE="keep \\t"');
    expect(values.get('A')).toBe('  x # y  ');
    expect(values.get('B')).toBe('l1\nl2');
    expect(values.get('C')).toBe('say "hi"');
    expect(values.get('D')).toBe('back\\slash');
    expect(values.get('E')).toBe('keep \\t');
  });

  test('single quotes are literal', () => {
    expect(parseDotenv("A='$HOME \\n \"x\"'").get('A')).toBe('$HOME \\n "x"');
  });

  test('a comment after a closing quote is allowed', () => {
    expect(parseDotenv('A="x" # note').get('A')).toBe('x');
  });

  test('Windows line endings leave no \\r in keys or values', () => {
    const values = parseDotenv('A=1\r\nB="2"\r\n');
    expect([...values]).toEqual([['A', '1'], ['B', '2']]);
  });

  test('a duplicate key: the last one wins', () => {
    expect(parseDotenv('A=1\nA=2').get('A')).toBe('2');
  });

  test('a line without = fails with its line number', () => {
    const error = failure('A=1\n\nJUSTTEXT\nB=2');
    expect(error.code).toBe('INVALID_PARAMS');
    expect(error.message).toContain('line 3');
  });

  test('an invalid key fails with its line number', () => {
    const error = failure('A=1\nMY-KEY=2');
    expect(error.code).toBe('INVALID_PARAMS');
    expect(error.message).toContain('line 2');
    expect(error.message).toContain('MY-KEY');
  });

  test('an unterminated quote fails', () => {
    expect(failure('A="open').message).toContain('line 1');
    expect(failure("A='open").message).toContain('line 1');
  });

  test('text after a closing quote fails', () => {
    expect(failure('A="x"y').message).toContain('line 1');
  });

  test('a failure never echoes a value', () => {
    expect(failure('A="s3cr3t-value').message).not.toContain('s3cr3t');
  });

  test('an empty file is no secrets', () => {
    expect(parseDotenv('').size).toBe(0);
  });
});
