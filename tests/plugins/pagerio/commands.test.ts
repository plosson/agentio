import { beforeEach, describe, expect, test } from 'bun:test';
import { withTempVault } from '../../helpers/vault';
import { exitCodeForError } from '../../../src/utils/errors';
import type { PagerioCredentials } from '../../../src/plugins/pagerio/types';
import { PAGER_URL, TOKEN } from './fake-pager';

/**
 * The CLI as an agent runs it, in a separate process. Every case here must
 * stop before any request: the proxy points at a closed port, so a request
 * that gets out fails with NETWORK_ERROR instead of paging anyone.
 */

let vault: ReturnType<typeof withTempVault>;

function withProfiles(profiles: () => Record<string, { readOnly?: boolean }>): void {
  const own = withTempVault('agentio-pagerio-cli-', () => {
    const entries = Object.entries(profiles());
    return {
      config: { profiles: { pagerio: entries.map(([name, p]) => ({ name, ...(p.readOnly ? { readOnly: true } : {}) })) } } as never,
      credentials: {
        pagerio: Object.fromEntries(entries.map(([name]): [string, PagerioCredentials] => [name, { url: PAGER_URL }])),
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

  test('a blank message, title, details, link, group or idempotency key is refused', async () => {
    for (const args of [
      [' '],
      ['M', '-t', ' '],
      ['M', '--details', ''],
      ['M', '-l', ' '],
      ['M', '-g', '\t'],
      ['M', '--idempotency-key', ' '],
    ]) {
      const res = await cli(['pagerio', 'send', ...args]);
      expect(res.code).toBe(INVALID);
      expect(res.stderr).toContain('cannot be empty');
    }
  });

  test('a profile that does not exist is not replaced by the one that does', async () => {
    const res = await cli(['pagerio', 'send', 'M', '--profile', 'other']);
    expect(res.code).toBe(exitCodeForError('PROFILE_NOT_FOUND'));
  });

  test('a request that gets out names the host, never the pager URL', async () => {
    const res = await cli(['pagerio', 'send', 'M']);
    expect(res.code).toBe(exitCodeForError('NETWORK_ERROR'));
    expect(res.stderr).toContain('pagerio.chuut.com');
    expect(res.stderr + res.stdout).not.toContain(TOKEN);
  });
});

describe('a read-only profile', () => {
  withProfiles(() => ({ ro: { readOnly: true } }));

  test('send is refused before any request', async () => {
    const res = await cli(['pagerio', 'send', 'M']);
    expect(res.code).toBe(exitCodeForError('PERMISSION_DENIED'));
    expect(res.stderr).toContain('read-only');
    expect(res.stderr).not.toContain(TOKEN);
  });
});
