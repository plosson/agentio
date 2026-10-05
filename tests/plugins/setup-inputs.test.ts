import { describe, expect, test } from 'bun:test';
import { checkAnswer, parseAnswer, readInputs } from '../../src/plugins/setup-inputs';
import type { InputSpec, SetupNeeds } from '../../src/plugin-sdk';
import { CliError } from '../../src/utils/errors';

const url: InputSpec = { id: 'url', label: 'Server URL', kind: 'url' };
const key: InputSpec = { id: 'apiKey', label: 'API key', kind: 'secret' };
const site: InputSpec = { id: 'site', label: 'Jira site', kind: 'choice', choices: [{ value: 'a1', label: 'Acme' }, { value: 'b2', label: 'Beta' }] };
const channel: InputSpec = { id: 'channel', label: 'Channel', kind: 'text', required: false };
const needs: SetupNeeds = { inputs: [url, key], auth: 'none' };

function code(f: () => unknown): string {
  try { f(); } catch (e) { expect(e).toBeInstanceOf(CliError); return (e as CliError).code + ': ' + (e as CliError).message; }
  throw new Error('expected a CliError');
}

describe('checkAnswer', () => {
  test('trims, and keeps an answer of the right kind', () => {
    expect(checkAnswer(url, '  https://mac.example.ts.net ')).toBe('https://mac.example.ts.net');
    expect(checkAnswer(key, ' k ')).toBe('k');
    expect(checkAnswer(site, 'b2')).toBe('b2');
    expect(checkAnswer({ id: 'e', label: 'Email', kind: 'email' }, 'a@b.co')).toBe('a@b.co');
  });
  test('refuses what is not text, missing, or of the wrong kind', () => {
    expect(code(() => checkAnswer(key, 42))).toBe('INVALID_PARAMS: API key must be text');
    expect(code(() => checkAnswer(key, null))).toBe('INVALID_PARAMS: API key must be text');
    expect(code(() => checkAnswer(key, '   '))).toBe('INVALID_PARAMS: API key is required');
    expect(code(() => checkAnswer(url, 'ftp://mac'))).toBe('INVALID_PARAMS: Server URL must be an http or https address');
    expect(code(() => checkAnswer(url, 'mac-mini'))).toBe('INVALID_PARAMS: Server URL must be an http or https address');
    expect(code(() => checkAnswer({ id: 'e', label: 'Email', kind: 'email' }, 'nope'))).toBe('INVALID_PARAMS: Email must be an email address');
    expect(code(() => checkAnswer(site, 'Acme'))).toBe('INVALID_PARAMS: Jira site must be one of: a1, b2');
  });
  test('an optional value may be empty', () => {
    expect(checkAnswer(channel, '  ')).toBe('');
  });
});

describe('readInputs: the --input line', () => {
  test('keeps known values, checked', () => {
    expect(readInputs('{"url":"https://m.example","apiKey":" k "}', needs)).toEqual({ url: 'https://m.example', apiKey: 'k' });
    expect(readInputs('{}', needs)).toEqual({});
  });
  test('refuses a missing, malformed or non-object line', () => {
    for (const line of [null, '', 'not json', '[]', 'null', '"x"', '42']) {
      expect(code(() => readInputs(line, needs))).toBe('INVALID_PARAMS: Expected the setup values as one JSON object on the first line of stdin');
    }
  });
  test('refuses an unknown id, and a value of the wrong type, before anything runs', () => {
    expect(code(() => readInputs('{"url":"https://m.example","token":"x"}', needs))).toBe('INVALID_PARAMS: Unknown setup value "token"');
    expect(code(() => readInputs('{"apiKey":42}', needs))).toBe('INVALID_PARAMS: API key must be text');
    expect(code(() => readInputs('{"__proto__":{"x":1}}', needs))).toBe('INVALID_PARAMS: Unknown setup value "__proto__"');
  });
});

describe('parseAnswer: one answer line', () => {
  test('takes the value for the id asked', () => {
    expect(parseAnswer('{"id":"site","value":"a1"}', site)).toBe('a1');
  });
  test('refuses a closed stdin, another id, a malformed line or a bad value', () => {
    expect(code(() => parseAnswer(null, site))).toBe('INVALID_PARAMS: No answer for "Jira site"');
    expect(code(() => parseAnswer('{"id":"other","value":"a1"}', site))).toBe('INVALID_PARAMS: Expected an answer for "site", got "other"');
    expect(code(() => parseAnswer('{"value":"a1"}', site))).toBe('INVALID_PARAMS: Expected an answer for "site", got nothing');
    expect(code(() => parseAnswer('a1', site))).toBe('INVALID_PARAMS: Expected an answer for "site" as {"id","value"}');
    expect(code(() => parseAnswer('{"id":"site","value":"zz"}', site))).toBe('INVALID_PARAMS: Jira site must be one of: a1, b2');
  });
});
