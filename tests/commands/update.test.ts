import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { CliError } from '../../src/utils/errors';
import { checkForUpdate } from '../../src/commands/update';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** The releases/latest redirect answers with `tag`; the REST API is never reached. */
function redirectTo(tag: string): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes('api.github.com')) throw new Error('REST API must not be called');
    return new Response(null, { status: 302, headers: { location: `https://github.com/plosson/agentio/releases/tag/${tag}` } });
  }) as typeof fetch;
}

describe('checkForUpdate', () => {
  test('a newer release is an available update, with the v prefix removed', async () => {
    redirectTo('v3.3.0');
    const result = await checkForUpdate('3.2.2');
    expect({ current: result.current, latest: result.latest, updateAvailable: result.updateAvailable }).toEqual({
      current: '3.2.2',
      latest: '3.3.0',
      updateAvailable: true,
    });
  });

  test('versions compare as numbers, not as text', async () => {
    redirectTo('v3.10.0');
    expect((await checkForUpdate('3.9.9')).updateAvailable).toBe(true);
    redirectTo('v3.9.9');
    expect((await checkForUpdate('3.10.0')).updateAvailable).toBe(false);
  });

  test('the same version is not an update', async () => {
    redirectTo('v3.2.2');
    expect((await checkForUpdate('3.2.2')).updateAvailable).toBe(false);
  });

  test('a running version newer than the latest release is not an update', async () => {
    redirectTo('v1.0.0');
    const result = await checkForUpdate('3.2.2');
    expect(result.updateAvailable).toBe(false);
    expect(result.latest).toBe('1.0.0');
  });

  test('without a redirect it falls back to the REST API and reports its rate limit', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (!String(input).includes('api.github.com')) return new Response(null, { status: 200 });
      return new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
    }) as typeof fetch;
    const error = await checkForUpdate('3.2.2').catch((e) => e);
    expect(error).toBeInstanceOf(CliError);
    expect(error.code).toBe('RATE_LIMITED');
  });

  test('an unreachable GitHub is a NETWORK_ERROR, not a raw fetch failure', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('Unable to connect');
    }) as unknown as typeof fetch;
    const error = await checkForUpdate('3.2.2').catch((e) => e);
    expect(error).toBeInstanceOf(CliError);
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.message).toContain('Unable to connect');
  });
});

describe('agentio update --json', () => {
  let tempHome = '';

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'agentio-update-test-'));
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true }).catch(() => {});
  });

  async function runCli(args: string[], env: Record<string, string> = {}) {
    const proc = Bun.spawn(['bun', 'run', 'src/index.ts', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
      // A proxy on a closed port makes GitHub unreachable, so no test depends on the network.
      env: { ...process.env, HOME: tempHome, HTTPS_PROXY: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', ...env },
    });
    const exitCode = await proc.exited;
    return { exitCode, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() };
  }

  test('--json without --check is refused before anything is downloaded or asked', async () => {
    const res = await runCli(['update', '--json']);
    expect(res.exitCode).toBe(1);
    expect(JSON.parse(res.stdout)).toEqual({
      v: 1,
      event: 'error',
      code: 'INVALID_PARAMS',
      message: '--json works only with --check',
      suggestion: 'Run: agentio update --check --json',
    });
  });

  test('--json with --yes but without --check is still refused', async () => {
    const res = await runCli(['update', '--json', '--yes', '--force']);
    expect(res.exitCode).toBe(1);
    expect(JSON.parse(res.stdout).code).toBe('INVALID_PARAMS');
  });

  test('an unreachable GitHub is one JSON error line with the network exit code', async () => {
    const res = await runCli(['update', '--check', '--json']);
    expect(res.exitCode).toBe(4);
    expect(res.stdout.trimEnd().split('\n')).toHaveLength(1);
    const error = JSON.parse(res.stdout);
    expect(error.v).toBe(1);
    expect(error.event).toBe('error');
    expect(error.code).toBe('NETWORK_ERROR');
  });

  test('without --json an unreachable GitHub stays a text error', async () => {
    const res = await runCli(['update', '--check']);
    expect(res.exitCode).toBe(4);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('Error [NETWORK_ERROR]: Could not reach GitHub');
  });
});
