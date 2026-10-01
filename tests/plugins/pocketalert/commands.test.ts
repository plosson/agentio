import { beforeEach, describe, expect, test } from 'bun:test';
import { withTempVault } from '../../helpers/vault';
import { exitCodeForError } from '../../../src/utils/errors';
import type { PocketAlertCredentials } from '../../../src/plugins/pocketalert/types';
import { KEY } from './fake-api';

/**
 * The CLI as an agent runs it, in a separate process. Every case here must
 * stop before any request: the proxy points at a closed port, so a request
 * that gets out fails with NETWORK_ERROR instead of reaching Pocket Alert.
 */

let vault: ReturnType<typeof withTempVault>;

function withProfiles(profiles: () => Record<string, { readOnly?: boolean }>): void {
  const own = withTempVault('agentio-pocketalert-cli-', () => {
    const entries = Object.entries(profiles());
    return {
      config: { profiles: { pocketalert: entries.map(([name, p]) => ({ name, ...(p.readOnly ? { readOnly: true } : {}) })) } } as never,
      credentials: {
        pocketalert: Object.fromEntries(entries.map(([name]): [string, PocketAlertCredentials] => [name, { apiKey: KEY }])),
      } as never,
    };
  });
  beforeEach(() => { vault = own; });
}

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', 'src/index.ts', ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...vault.env(), NO_COLOR: '1', HTTPS_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9' },
  });
  const code = await proc.exited;
  return { code, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() };
}

const INVALID = exitCodeForError('INVALID_PARAMS');

describe('one profile', () => {
  withProfiles(() => ({ main: {} }));

  test('a blank title, message, device or application is refused', async () => {
    for (const args of [
      ['-t', ' ', '-m', 'M'],
      ['-t', 'T', '-m', ''],
      ['-t', 'T', '-m', 'M', '-d', ' '],
      ['-t', 'T', '-m', 'M', '-a', ''],
    ]) {
      const res = await cli(['pocketalert', 'send', ...args]);
      expect(res.code).toBe(INVALID);
      expect(res.stderr).toContain('cannot be empty');
    }
  });

  test('a level out of range is refused', async () => {
    const res = await cli(['pocketalert', 'send', '-t', 'T', '-m', 'M', '--level', '3']);
    expect(res.code).toBe(INVALID);
    expect(res.stderr).toContain('-2 to 2');
  });

  test('a missing title or message is refused by the parser', async () => {
    expect((await cli(['pocketalert', 'send', '-m', 'M'])).code).not.toBe(0);
    expect((await cli(['pocketalert', 'send', '-t', 'T'])).code).not.toBe(0);
  });

  test('a profile that does not exist is not replaced by the one that does', async () => {
    const res = await cli(['pocketalert', 'send', '-t', 'T', '-m', 'M', '--profile', 'other']);
    expect(res.code).toBe(exitCodeForError('PROFILE_NOT_FOUND'));
  });
});

describe('a read-only profile', () => {
  withProfiles(() => ({ ro: { readOnly: true } }));

  test('send is refused before any request', async () => {
    const res = await cli(['pocketalert', 'send', '-t', 'T', '-m', 'M']);
    expect(res.code).toBe(exitCodeForError('PERMISSION_DENIED'));
    expect(res.stderr).toContain('read-only');
    expect(res.stderr).not.toContain(KEY);
  });
});
