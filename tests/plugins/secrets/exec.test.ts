import { describe, expect, test } from 'bun:test';
import { exitCodeForError } from '../../../src/utils/errors';
import { cli, withSecretsProfiles } from './cli';

describe('exec', () => {
  withSecretsProfiles(() => ({
    app: { values: { API_TOKEN: 'tok', MULTI: 'l1\nl2', SHARED: 'from-profile', ['__proto__']: 'proto' } },
  }));

  test('the command sees the secrets as environment variables', async () => {
    const res = await cli(['secrets', 'exec', '--', 'sh', '-c', 'printf %s "$API_TOKEN"']);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('tok');
  });

  test('a value with newlines arrives byte for byte', async () => {
    expect((await cli(['secrets', 'exec', '--', 'sh', '-c', 'printf %s "$MULTI"'])).stdout).toBe('l1\nl2');
  });

  test('a key named __proto__ is exported like any other', async () => {
    expect((await cli(['secrets', 'exec', '--', 'sh', '-c', 'printenv __proto__'])).stdout).toBe('proto\n');
  });

  test('a profile value overrides the inherited environment, the rest is inherited', async () => {
    const res = await cli(['secrets', 'exec', '--', 'sh', '-c', 'printf "%s %s" "$SHARED" "$OTHER"'], undefined, { SHARED: 'from-parent', OTHER: 'inherited' });
    expect(res.stdout).toBe('from-profile inherited');
  });

  test('the child\'s arguments are passed as given, options included', async () => {
    const res = await cli(['secrets', 'exec', '--', 'sh', '-c', 'printf "%s|" "$@"', 'sh', '--profile', 'x', '-v']);
    expect(res.stdout).toBe('--profile|x|-v|');
  });

  test('a non-zero exit code is passed through', async () => {
    expect((await cli(['secrets', 'exec', '--', 'sh', '-c', 'exit 7'])).code).toBe(7);
  });

  test('a command killed by a signal exits 128 + the signal number', async () => {
    expect((await cli(['secrets', 'exec', '--', 'sh', '-c', 'kill -TERM $$'])).code).toBe(143);
  });

  test('no command is INVALID_PARAMS', async () => {
    expect((await cli(['secrets', 'exec'])).code).toBe(exitCodeForError('INVALID_PARAMS'));
    expect((await cli(['secrets', 'exec', '--'])).code).toBe(exitCodeForError('INVALID_PARAMS'));
  });

  test('a command that does not exist is NOT_FOUND and shows no value', async () => {
    const res = await cli(['secrets', 'exec', '--', 'agentio-no-such-command-xyz']);
    expect(res.code).toBe(exitCodeForError('NOT_FOUND'));
    expect(res.stderr).not.toContain('tok');
  });
});

describe('exec on a read-only profile', () => {
  withSecretsProfiles(() => ({ ro: { readOnly: true, values: { A: 'a' } } }));

  test('is allowed', async () => {
    expect((await cli(['secrets', 'exec', '--', 'sh', '-c', 'printf %s "$A"'])).stdout).toBe('a');
  });
});
