import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { exitCodeForError } from '../../../src/utils/errors';
import { cli, vaultBytes, withSecretsProfiles } from './cli';

async function envFile(text: string): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'agentio-secrets-env-')), '.env');
  await writeFile(path, text);
  return path;
}

async function revealed(): Promise<Record<string, string>> {
  return JSON.parse((await cli(['secrets', 'list', '--reveal', '--json'])).stdout).values;
}

describe('import', () => {
  withSecretsProfiles(() => ({ app: { values: { KEEP: 'k', OLD: 'before' } } }));

  test('adds new keys, replaces existing ones, keeps the others, and counts each once', async () => {
    const res = await cli(['secrets', 'import', await envFile('OLD=after\nNEW=n\nNEW=n2\n')]);
    expect(res.code).toBe(0);
    expect(res.stderr).toContain('1 added, 1 replaced');
    expect(res.stdout).toBe('');
    expect(await revealed()).toEqual({ KEEP: 'k', OLD: 'after', NEW: 'n2' });
  });

  test('a malformed line writes nothing, and the error never shows a value', async () => {
    const before = await vaultBytes();
    const res = await cli(['secrets', 'import', await envFile('GOOD=s3cr3t\nBAD LINE\n')]);
    expect(res.code).toBe(exitCodeForError('INVALID_PARAMS'));
    expect(res.stderr).toContain('line 2');
    expect(res.stderr).not.toContain('s3cr3t');
    expect(await vaultBytes()).toBe(before);
  });

  test('a missing file is NOT_FOUND', async () => {
    const res = await cli(['secrets', 'import', '/nonexistent/agentio/.env']);
    expect(res.code).toBe(exitCodeForError('NOT_FOUND'));
  });

  test('a directory is refused, not read', async () => {
    const res = await cli(['secrets', 'import', tmpdir()]);
    expect(res.code).not.toBe(0);
  });
});

describe('import on a read-only profile', () => {
  withSecretsProfiles(() => ({ ro: { readOnly: true } }));

  test('is refused and writes nothing', async () => {
    const before = await vaultBytes();
    const res = await cli(['secrets', 'import', await envFile('A=1\n')]);
    expect(res.code).toBe(exitCodeForError('PERMISSION_DENIED'));
    expect(await vaultBytes()).toBe(before);
  });
});
