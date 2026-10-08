import { describe, expect, test } from 'bun:test';
import { checkAnswer } from '../../src/plugins/setup-inputs';
import type { InputSpec } from '../../src/plugin-sdk';
import { CliError } from '../../src/utils/errors';

const url: InputSpec = { label: 'Server URL', kind: 'url' };
const key: InputSpec = { label: 'API key', kind: 'secret' };
const site: InputSpec = { label: 'Jira site', kind: 'choice', choices: [{ value: 'a1', label: 'Acme' }, { value: 'b2', label: 'Beta' }] };
const channel: InputSpec = { label: 'Channel', kind: 'text', required: false };

function code(f: () => unknown): string {
  try { f(); } catch (e) { expect(e).toBeInstanceOf(CliError); return (e as CliError).code + ': ' + (e as CliError).message; }
  throw new Error('expected a CliError');
}

describe('checkAnswer', () => {
  test('trims, and keeps an answer of the right kind', () => {
    expect(checkAnswer(url, '  https://mac.example.ts.net ')).toBe('https://mac.example.ts.net');
    expect(checkAnswer(url, 'kite.example.com')).toBe('https://kite.example.com');
    expect(checkAnswer(url, ' localhost:8080 ')).toBe('https://localhost:8080');
    expect(checkAnswer(url, 'http://x.test')).toBe('http://x.test');
    expect(checkAnswer(key, ' k ')).toBe('k');
    expect(checkAnswer(site, 'b2')).toBe('b2');
    expect(checkAnswer({ label: 'Email', kind: 'email' }, 'a@b.co')).toBe('a@b.co');
  });
  test('refuses what is not text, missing, or of the wrong kind', () => {
    expect(code(() => checkAnswer(key, 42))).toBe('INVALID_PARAMS: API key must be text');
    expect(code(() => checkAnswer(key, null))).toBe('INVALID_PARAMS: API key must be text');
    expect(code(() => checkAnswer(key, '   '))).toBe('INVALID_PARAMS: API key is required');
    expect(code(() => checkAnswer(url, 'ftp://mac'))).toBe('INVALID_PARAMS: Server URL must be an http or https address');
    for (const bad of ['https://', 'http:// spaces in host', 'mailto:a@b.c']) {
      expect(code(() => checkAnswer(url, bad))).toBe('INVALID_PARAMS: Server URL must be an http or https address');
    }
    expect(code(() => checkAnswer({ label: 'Email', kind: 'email' }, 'nope'))).toBe('INVALID_PARAMS: Email must be an email address');
    expect(code(() => checkAnswer(site, 'Acme'))).toBe('INVALID_PARAMS: Jira site must be one of: a1, b2');
  });
  test('an optional value may be empty', () => {
    expect(checkAnswer(channel, '  ')).toBe('');
  });
});

