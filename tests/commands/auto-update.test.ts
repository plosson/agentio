import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile, utimes, chmod } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { maybeAutoUpdate, type AutoUpdateDeps } from '../../src/commands/auto-update';
import { getCurrentVersion } from '../../src/commands/update';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };

let home = '';
let fetchCalls = 0;
let installs: string[] = [];
let relaunches = 0;
let exitCode: number | null = null;

const [major, minor, patch] = getCurrentVersion().split('.').map(Number);
const nextMinor = `v${major}.${minor + 1}.0`;
const nextMajor = `v${major + 1}.0.0`;

/** releases/latest redirects to `tag`; the asset HEAD probe succeeds. */
function releaseIs(tag: string): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    fetchCalls++;
    if (url.endsWith('/releases/latest')) {
      return new Response(null, { status: 302, headers: { location: `https://github.com/plosson/agentio/releases/tag/${tag}` } });
    }
    if (url.includes('/releases/download/')) return new Response(null, { status: 200 });
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

function deps(overrides: Partial<AutoUpdateDeps> = {}): AutoUpdateDeps {
  return {
    now: () => NOW,
    isCompiled: () => true,
    execPath: join(home, 'bin', 'agentio'),
    install: async (url) => {
      installs.push(url);
    },
    relaunch: async () => {
      relaunches++;
      return 7;
    },
    exit: ((code: number) => {
      exitCode = code;
    }) as AutoUpdateDeps['exit'],
    ...overrides,
  };
}

async function lastCheck(): Promise<number | null> {
  const file = join(home, 'update-check.json');
  return existsSync(file) ? JSON.parse(await readFile(file, 'utf8')).lastCheck : null;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agentio-auto-update-'));
  await Bun.write(join(home, 'bin', 'agentio'), '');
  process.env.AGENTIO_HOME = home;
  delete process.env.CI;
  delete process.env.AGENTIO_NO_AUTO_UPDATE;
  delete process.env.AGENTIO_AUTO_UPDATED;
  fetchCalls = 0;
  installs = [];
  relaunches = 0;
  exitCode = null;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  process.env = { ...savedEnv };
  await chmod(join(home, 'bin'), 0o755).catch(() => {});
  await rm(home, { recursive: true, force: true });
});

describe('maybeAutoUpdate', () => {
  test('a newer minor release is installed and the command reruns with the child exit code', async () => {
    releaseIs(nextMinor);
    await maybeAutoUpdate(['gmail', 'list'], deps());
    expect(installs).toHaveLength(1);
    expect(installs[0]).toContain(`/releases/download/${nextMinor}/`);
    expect(relaunches).toBe(1);
    expect(exitCode).toBe(7);
    expect(await lastCheck()).toBe(NOW);
  });

  test('a new major release is announced, never installed', async () => {
    releaseIs(nextMajor);
    await maybeAutoUpdate(['gmail', 'list'], deps());
    expect(installs).toHaveLength(0);
    expect(relaunches).toBe(0);
  });

  test('the same or an older release installs nothing', async () => {
    releaseIs(`v${major}.${minor}.${patch}`);
    await maybeAutoUpdate(['gmail', 'list'], deps());
    releaseIs(`v${major - 1}.99.99`);
    await maybeAutoUpdate(['gmail', 'list'], deps({ now: () => NOW + 2 * DAY }));
    expect(installs).toHaveLength(0);
    expect(relaunches).toBe(0);
  });

  test('a check less than 24h old does not touch the network', async () => {
    releaseIs(nextMinor);
    await writeFile(join(home, 'update-check.json'), JSON.stringify({ lastCheck: NOW - DAY + 1000 }));
    await maybeAutoUpdate(['gmail', 'list'], deps());
    expect(fetchCalls).toBe(0);
    expect(installs).toHaveLength(0);
  });

  test('a check exactly 24h old is due again', async () => {
    releaseIs(nextMinor);
    await writeFile(join(home, 'update-check.json'), JSON.stringify({ lastCheck: NOW - DAY }));
    await maybeAutoUpdate(['gmail', 'list'], deps());
    expect(installs).toHaveLength(1);
  });

  test('a last check in the future (wrong clock) does not block updates forever', async () => {
    releaseIs(nextMinor);
    await writeFile(join(home, 'update-check.json'), JSON.stringify({ lastCheck: NOW + 365 * DAY }));
    await maybeAutoUpdate(['gmail', 'list'], deps());
    expect(installs).toHaveLength(1);
    expect(await lastCheck()).toBe(NOW);
  });

  for (const [label, content] of [
    ['garbage', 'not json{'],
    ['a string timestamp', JSON.stringify({ lastCheck: String(NOW) })],
    ['null', 'null'],
  ]) {
    test(`a state file holding ${label} counts as never checked`, async () => {
      releaseIs(nextMinor);
      await writeFile(join(home, 'update-check.json'), content);
      await maybeAutoUpdate(['gmail', 'list'], deps());
      expect(installs).toHaveLength(1);
    });
  }

  test('an unreachable GitHub never fails the command, and is not retried on the next call', async () => {
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new TypeError('Unable to connect');
    }) as unknown as typeof fetch;
    await maybeAutoUpdate(['gmail', 'list'], deps());
    expect(await lastCheck()).toBe(NOW);
    const callsAfterFirst = fetchCalls;
    await maybeAutoUpdate(['gmail', 'list'], deps({ now: () => NOW + 1000 }));
    expect(fetchCalls).toBe(callsAfterFirst);
    expect(relaunches).toBe(0);
  });

  test('a GitHub that never answers gives up instead of hanging the command', async () => {
    globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch;
    const started = Date.now();
    await maybeAutoUpdate(['gmail', 'list'], deps());
    expect(Date.now() - started).toBeLessThan(5000);
    expect(installs).toHaveLength(0);
  }, 10000);

  test('a failed install runs the command on the current binary, without relaunching', async () => {
    releaseIs(nextMinor);
    await maybeAutoUpdate(['gmail', 'list'], deps({ install: async () => { throw new Error('disk full'); } }));
    expect(relaunches).toBe(0);
    expect(exitCode).toBeNull();
    expect(existsSync(join(home, 'update.lock'))).toBe(false);
  });

  test('a release with no binary for this platform installs nothing', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/releases/latest')) {
        return new Response(null, { status: 302, headers: { location: `https://github.com/plosson/agentio/releases/tag/${nextMinor}` } });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    await maybeAutoUpdate(['gmail', 'list'], deps());
    expect(installs).toHaveLength(0);
    expect(relaunches).toBe(0);
  });

  test('while another process holds a fresh lock, nothing is checked or installed', async () => {
    releaseIs(nextMinor);
    await writeFile(join(home, 'update.lock'), '12345');
    await maybeAutoUpdate(['gmail', 'list'], deps({ now: () => Date.now() }));
    expect(fetchCalls).toBe(0);
    expect(installs).toHaveLength(0);
    expect(existsSync(join(home, 'update.lock'))).toBe(true);
  });

  test('a stale lock left by a crashed process is taken over and released', async () => {
    releaseIs(nextMinor);
    const lock = join(home, 'update.lock');
    await writeFile(lock, '12345');
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(lock, old, old);
    await maybeAutoUpdate(['gmail', 'list'], deps({ now: () => Date.now() }));
    expect(installs).toHaveLength(1);
    expect(existsSync(lock)).toBe(false);
  });

  test('concurrent commands install the update only once', async () => {
    releaseIs(nextMinor);
    await Promise.all(Array.from({ length: 5 }, () => maybeAutoUpdate(['gmail', 'list'], deps())));
    expect(installs).toHaveLength(1);
  });

  for (const commandPath of [['update'], ['daemon', 'start'], ['daemon', 'status']]) {
    test(`\`${commandPath.join(' ')}\` never auto-updates`, async () => {
      releaseIs(nextMinor);
      await maybeAutoUpdate(commandPath, deps());
      expect(fetchCalls).toBe(0);
    });
  }

  for (const env of ['AGENTIO_NO_AUTO_UPDATE', 'CI', 'AGENTIO_AUTO_UPDATED']) {
    test(`${env} disables the automatic update`, async () => {
      releaseIs(nextMinor);
      process.env[env] = '1';
      await maybeAutoUpdate(['gmail', 'list'], deps());
      expect(fetchCalls).toBe(0);
    });
  }

  test('running from source never replaces the bun binary', async () => {
    releaseIs(nextMinor);
    await maybeAutoUpdate(['gmail', 'list'], deps({ isCompiled: () => false }));
    expect(fetchCalls).toBe(0);
  });

  test('a binary in a folder the user cannot write is left alone', async () => {
    if (process.getuid?.() === 0) return; // root writes everywhere
    releaseIs(nextMinor);
    await chmod(join(home, 'bin'), 0o555);
    await maybeAutoUpdate(['gmail', 'list'], deps());
    expect(fetchCalls).toBe(0);
  });
});
