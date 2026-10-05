import { describe, expect, test } from 'bun:test';
import { exitCodeForError } from '../../../src/utils/errors';
import { cli, vaultBytes, withSecretsProfiles } from './cli';

const INVALID = exitCodeForError('INVALID_PARAMS');
const NOT_FOUND = exitCodeForError('NOT_FOUND');

async function revealed(profile: string): Promise<Record<string, string>> {
  const res = await cli(['secrets', 'list', '--profile', profile, '--reveal', '--json']);
  expect(res.code).toBe(0);
  return JSON.parse(res.stdout).values;
}

describe('profile add', () => {
  withSecretsProfiles(() => ({}));

  test('creates an empty profile under the given name', async () => {
    const res = await cli(['secrets', 'profile', 'add', '--profile', 'smtp']);
    expect(res.code).toBe(0);
    expect(await revealed('smtp')).toEqual({});
  });

  test('commands on a profile that does not exist fail', async () => {
    expect((await cli(['secrets', 'get', 'A', '--profile', 'nope'])).code).toBe(exitCodeForError('PROFILE_NOT_FOUND'));
  });
});

describe('one profile', () => {
  withSecretsProfiles(() => ({ smtp: { values: { HOST: 'mail.example.com' } } }));

  test('set then get, with --profile optional when only one profile exists', async () => {
    expect((await cli(['secrets', 'set', 'PASSWORD', 'pw'])).code).toBe(0);
    const res = await cli(['secrets', 'get', 'PASSWORD']);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('pw');
  });

  test('set reports added, then replaced, on stderr only', async () => {
    const first = await cli(['secrets', 'set', 'A', '1']);
    expect(first.stderr).toContain('Added');
    expect(first.stdout).toBe('');
    expect((await cli(['secrets', 'set', 'A', '2'])).stderr).toContain('Replaced');
    expect((await cli(['secrets', 'get', 'A'])).stdout).toBe('2');
  });

  test('a value on stdin loses one trailing newline and keeps the inner ones', async () => {
    expect((await cli(['secrets', 'set', 'KEY'], '-----BEGIN-----\nabc\n-----END-----\n')).code).toBe(0);
    expect((await cli(['secrets', 'get', 'KEY'])).stdout).toBe('-----BEGIN-----\nabc\n-----END-----');
    expect((await cli(['secrets', 'set', 'WIN'], 'pw\r\n')).code).toBe(0);
    expect((await cli(['secrets', 'get', 'WIN'])).stdout).toBe('pw');
  });

  test('no value and nothing on stdin is refused', async () => {
    const res = await cli(['secrets', 'set', 'A']);
    expect(res.code).toBe(INVALID);
    expect(res.stderr).toContain('No value');
    expect((await cli(['secrets', 'set', 'A'], '\n')).code).toBe(INVALID);
  });

  test('an invalid key is refused before anything is written', async () => {
    const before = await vaultBytes();
    for (const key of ['1A', 'A-B', 'A B', '']) {
      expect((await cli(['secrets', 'set', key, 'v'])).code).toBe(INVALID);
    }
    expect(await vaultBytes()).toBe(before);
  });

  test('keys that collide with Object.prototype are ordinary keys', async () => {
    for (const key of ['__proto__', 'constructor', 'toString']) {
      expect((await cli(['secrets', 'set', key, `v-${key}`])).code).toBe(0);
    }
    expect((await cli(['secrets', 'get', '__proto__'])).stdout).toBe('v-__proto__');
    expect(await revealed('smtp')).toEqual({ HOST: 'mail.example.com', ['__proto__']: 'v-__proto__', constructor: 'v-constructor', toString: 'v-toString' });
    expect((await cli(['secrets', 'get', 'hasOwnProperty'])).code).toBe(NOT_FOUND);
  });

  test('a value that looks like an option is stored as given', async () => {
    expect((await cli(['secrets', 'set', 'A', '--', '--not-an-option'])).code).toBe(0);
    expect((await cli(['secrets', 'get', 'A'])).stdout).toBe('--not-an-option');
  });

  test('get of a missing key is NOT_FOUND and lists the keys, never the values', async () => {
    const res = await cli(['secrets', 'get', 'NOPE']);
    expect(res.code).toBe(NOT_FOUND);
    expect(res.stderr).toContain('HOST');
    expect(res.stderr).not.toContain('mail.example.com');
    expect(res.stdout).toBe('');
  });

  test('list shows names only unless --reveal', async () => {
    await cli(['secrets', 'set', 'A', 'alpha']);
    const plain = await cli(['secrets', 'list']);
    expect(plain.stdout).toBe('A\nHOST\n');
    const json = (await cli(['secrets', 'list', '--json'])).stdout;
    expect(json).not.toContain('alpha');
    expect(JSON.parse(json)).toEqual({ keys: ['A', 'HOST'] });
    expect((await cli(['secrets', 'list', '--reveal'])).stdout).toBe('A=alpha\nHOST=mail.example.com\n');
  });

  test('unset removes one key; a missing key is NOT_FOUND and writes nothing', async () => {
    expect((await cli(['secrets', 'unset', 'HOST'])).code).toBe(0);
    expect(await revealed('smtp')).toEqual({});
    const before = await vaultBytes();
    expect((await cli(['secrets', 'unset', 'HOST'])).code).toBe(NOT_FOUND);
    expect(await vaultBytes()).toBe(before);
  });
});

describe('a read-only profile', () => {
  withSecretsProfiles(() => ({ ro: { readOnly: true, values: { A: 'a' } } }));

  test('set and unset are refused and the vault is unchanged', async () => {
    const before = await vaultBytes();
    for (const args of [['set', 'B', 'b'], ['unset', 'A']]) {
      const res = await cli(['secrets', ...args]);
      expect(res.code).toBe(exitCodeForError('PERMISSION_DENIED'));
      expect(res.stderr).toContain('read-only');
    }
    expect(await vaultBytes()).toBe(before);
  });

  test('a refused set does not wait for a value on stdin', async () => {
    expect((await cli(['secrets', 'set', 'B'], 'b')).code).toBe(exitCodeForError('PERMISSION_DENIED'));
  });

  test('get and list still work', async () => {
    expect((await cli(['secrets', 'get', 'A'])).stdout).toBe('a');
    expect((await cli(['secrets', 'list'])).stdout).toBe('A\n');
  });
});

describe('two profiles', () => {
  withSecretsProfiles(() => ({ smtp: { values: { A: 'smtp-a' } }, stripe: { values: { A: 'stripe-a' } } }));

  test('--profile is required, and each profile keeps its own values', async () => {
    expect((await cli(['secrets', 'get', 'A'])).code).not.toBe(0);
    expect((await cli(['secrets', 'get', 'A', '--profile', 'stripe'])).stdout).toBe('stripe-a');
    await cli(['secrets', 'set', 'A', 'new', '--profile', 'smtp']);
    expect((await cli(['secrets', 'get', 'A', '--profile', 'stripe'])).stdout).toBe('stripe-a');
  });
});
