import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * `agentio login --json` against a fake hub whose answers each test scripts,
 * so every outcome (approved, denied, expired, errors) is reached in
 * milliseconds. The real hub's device flow is covered in tests/auth/device-login.test.ts.
 */

type PollAnswer = { status: number; body: unknown };

let tempHome = '';
let binDir = '';
let browserMarker = '';

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'agentio-login-json-test-'));
  await mkdir(join(tempHome, '.config', 'agentio'), { recursive: true, mode: 0o700 });
  // A fake browser opener that leaves a marker, so a test sees whether one was launched.
  binDir = join(tempHome, 'bin');
  browserMarker = join(tempHome, 'browser-opened');
  await mkdir(binDir);
  for (const opener of ['open', 'xdg-open']) {
    const path = join(binDir, opener);
    await writeFile(path, `#!/bin/sh\necho "$1" > "${browserMarker}"\n`);
    await chmod(path, 0o755);
  }
});

afterEach(async () => {
  await rm(tempHome, { recursive: true, force: true }).catch(() => {});
});

const KEY = { id: 'a1b2c3d4', name: 'laptop', allowedProfiles: '*', readOnly: false, canManageProfiles: true, createdAt: '2026-09-26T00:00:00Z', extra: 'hub-only' };

/** A hub that hands out code BCDF-2345 and answers each poll with the next scripted answer, the last one repeating. */
function fakeHub(polls: PollAnswer[], start: Record<string, unknown> = {}) {
  let n = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      if (path === '/v1/device') {
        return Response.json({ userCode: 'BCDF-2345', deviceCode: 'dev-1', expiresIn: 600, interval: 0.01, ...start });
      }
      if (path === '/v1/device/token') {
        const answer = polls[Math.min(n++, polls.length - 1)];
        return Response.json(answer.body, { status: answer.status });
      }
      return Response.json({ error: 'Not found' }, { status: 404 });
    },
  });
  return { server, url: `http://127.0.0.1:${server.port}` };
}

async function runCli(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(['bun', 'run', 'src/index.ts', ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, HOME: tempHome, AGENTIO_TOKEN: '', PATH: `${binDir}:${process.env.PATH}`, ...env },
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  // Under --json, every line on stdout is one JSON object with the format version.
  const events = args.includes('--json') ? stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  for (const event of events) expect(event.v).toBe(1);
  return { exitCode, stdout, stderr, events };
}

const tokenPath = () => join(tempHome, '.config', 'agentio', 'token');

describe('agentio login --json', () => {
  test('approved: a code event, then an approved event; the token is stored and no browser opens', async () => {
    const { server, url } = fakeHub([
      { status: 200, body: { status: 'pending' } },
      { status: 200, body: { status: 'approved', token: 'agio1.fake-token', key: KEY } },
    ]);
    try {
      const res = await runCli(['login', url, '--json']);
      expect(res.exitCode).toBe(0);
      expect(res.events).toEqual([
        { v: 1, event: 'code', userCode: 'BCDF-2345', verifyUrl: `${url}/ui#authorize=BCDF-2345`, expiresIn: 600 },
        {
          v: 1,
          event: 'approved',
          url,
          // Only the documented key fields, not whatever else the hub sends.
          key: { id: 'a1b2c3d4', name: 'laptop', allowedProfiles: '*', readOnly: false, canManageProfiles: true },
          tokenPath: tokenPath(),
        },
      ]);
      expect((await readFile(tokenPath(), 'utf8')).trim()).toBe('agio1.fake-token');
      expect(res.stdout).not.toContain('agio1.fake-token');
      expect(existsSync(browserMarker)).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test('the fake opener works: without --json the browser is opened', async () => {
    const { server, url } = fakeHub([{ status: 200, body: { status: 'approved', token: 'agio1.fake-token', key: KEY } }]);
    try {
      const res = await runCli(['login', url]);
      expect(res.exitCode).toBe(0);
      // Give the detached opener a moment to write its marker.
      for (let i = 0; i < 50 && !existsSync(browserMarker); i++) await Bun.sleep(20);
      expect((await readFile(browserMarker, 'utf8')).trim()).toBe(`${url}/ui#authorize=BCDF-2345`);
    } finally {
      server.stop(true);
    }
  });

  test('denied: the final event is denied, with the auth exit code and no token', async () => {
    const { server, url } = fakeHub([{ status: 200, body: { status: 'denied' } }]);
    try {
      const res = await runCli(['login', url, '--json']);
      expect(res.exitCode).toBe(2);
      expect(res.events.map((e) => e.event)).toEqual(['code', 'denied']);
      expect(res.events[1].message).toBe('The hub owner denied this login');
      expect(existsSync(tokenPath())).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test('expired: nobody decides before the code runs out', async () => {
    const { server, url } = fakeHub([{ status: 200, body: { status: 'pending' } }], { expiresIn: 0.3 });
    try {
      const res = await runCli(['login', url, '--json']);
      expect(res.exitCode).toBe(2);
      expect(res.events.map((e) => e.event)).toEqual(['code', 'expired']);
      expect(res.events[1].suggestion).toContain('agentio login');
      expect(existsSync(tokenPath())).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test('expired: the hub forgot the code, for example after a restart', async () => {
    const { server, url } = fakeHub([{ status: 404, body: { error: 'Unknown device code', code: 'NOT_FOUND' } }]);
    try {
      const res = await runCli(['login', url, '--json']);
      expect(res.exitCode).toBe(2);
      expect(res.events.map((e) => e.event)).toEqual(['code', 'expired']);
    } finally {
      server.stop(true);
    }
  });

  test('a hub that fails while polling ends with an error event', async () => {
    const { server, url } = fakeHub([{ status: 500, body: { error: 'boom' } }]);
    try {
      const res = await runCli(['login', url, '--json']);
      expect(res.exitCode).toBe(5);
      expect(res.events.map((e) => e.event)).toEqual(['code', 'error']);
      expect(res.events[1].code).toBe('API_ERROR');
    } finally {
      server.stop(true);
    }
  });

  test('an unreachable hub is a single network error event', async () => {
    const res = await runCli(['login', 'http://127.0.0.1:1', '--json']);
    expect(res.exitCode).toBe(4);
    expect(res.events).toHaveLength(1);
    expect(res.events[0]).toMatchObject({ event: 'error', code: 'NETWORK_ERROR' });
  });

  test('a server that is not a hub is a single config error event', async () => {
    const plain = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('nope', { status: 404 }) });
    try {
      const res = await runCli(['login', `http://127.0.0.1:${plain.port}`, '--json']);
      expect(res.exitCode).toBe(3);
      expect(res.events).toHaveLength(1);
      expect(res.events[0]).toMatchObject({ event: 'error', code: 'CONFIG_ERROR' });
    } finally {
      plain.stop(true);
    }
  });

  test('an invalid hub URL is refused before any request', async () => {
    const res = await runCli(['login', 'ftp://hub', '--json']);
    expect(res.exitCode).toBe(1);
    expect(res.events).toHaveLength(1);
    expect(res.events[0]).toMatchObject({ event: 'error', code: 'INVALID_PARAMS' });
  });

  test('AGENTIO_TOKEN in the environment is refused as a JSON error', async () => {
    const res = await runCli(['login', 'http://127.0.0.1:1', '--json'], { AGENTIO_TOKEN: 'agio1.xx' });
    expect(res.exitCode).toBe(3);
    expect(res.events).toEqual([
      {
        v: 1,
        event: 'error',
        code: 'CONFIG_ERROR',
        message: 'AGENTIO_TOKEN is set, so a stored login would be ignored',
        suggestion: 'Unset AGENTIO_TOKEN first, or keep using it',
      },
    ]);
  });
});
