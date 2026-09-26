import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { networkInterfaces, tmpdir } from 'os';
import { join } from 'path';
import { encryptVault } from '../../src/vault/crypto';
import { resolveDaemonAddress } from '../../src/daemon/daemon';
import { daemonRecordPath, daemonUrlFor, forgetDaemon, localDaemonUrl, recordDaemon } from '../../src/daemon/client';
import { CliError } from '../../src/utils/errors';

const PASSPHRASE = 'daemon-test-passphrase-1';

let tempHome = '';
const realHome = process.env.HOME;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'agentio-daemon-test-'));
  await mkdir(join(tempHome, '.config', 'agentio'), { recursive: true, mode: 0o700 });
  process.env.HOME = tempHome;
});

afterEach(async () => {
  process.env.HOME = realHome;
  await rm(tempHome, { recursive: true, force: true }).catch(() => {});
});

function invalid(fn: () => unknown): CliError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe('INVALID_PARAMS');
    return error as CliError;
  }
  throw new Error('expected INVALID_PARAMS');
}

describe('resolveDaemonAddress', () => {
  test('defaults to every interface on 7890, as the container image expects', () => {
    expect(resolveDaemonAddress({}, {})).toEqual({ host: '0.0.0.0', port: 7890 });
  });

  test('empty environment variables count as unset', () => {
    expect(resolveDaemonAddress({}, { AGENTIO_DAEMON_HOST: '', AGENTIO_DAEMON_PORT: '' })).toEqual({ host: '0.0.0.0', port: 7890 });
  });

  test('options win over environment variables, which win over defaults', () => {
    const env = { AGENTIO_DAEMON_HOST: '10.0.0.5', AGENTIO_DAEMON_PORT: '9000' };
    expect(resolveDaemonAddress({}, env)).toEqual({ host: '10.0.0.5', port: 9000 });
    expect(resolveDaemonAddress({ host: '127.0.0.1', port: '0' }, env)).toEqual({ host: '127.0.0.1', port: 0 });
  });

  test('ports outside 0-65535 or not plain digits are refused', () => {
    for (const port of ['65536', '-1', 'abc', '80.5', '1e3', '0x50', '', '123456']) {
      invalid(() => resolveDaemonAddress({ port }, {}));
    }
    expect(invalid(() => resolveDaemonAddress({}, { AGENTIO_DAEMON_PORT: 'http' })).message).toBe('Invalid daemon port: http');
  });

  test('a blank host is refused rather than binding somewhere unexpected', () => {
    invalid(() => resolveDaemonAddress({ host: '   ' }, {}));
  });
});

describe('daemonUrlFor', () => {
  test('a wildcard bind is reached on loopback; a named host as itself', () => {
    expect(daemonUrlFor('0.0.0.0', 7890)).toBe('http://127.0.0.1:7890');
    expect(daemonUrlFor('::', 7890)).toBe('http://127.0.0.1:7890');
    expect(daemonUrlFor('localhost', 80)).toBe('http://localhost:80');
    expect(daemonUrlFor('::1', 5000)).toBe('http://[::1]:5000');
  });
});

describe('daemon record', () => {
  test('without a record the default address is used', () => {
    expect(localDaemonUrl()).toBe('http://127.0.0.1:7890');
  });

  test('a record whose process is alive is used', async () => {
    await recordDaemon({ url: 'http://127.0.0.1:5555', pid: process.pid });
    expect(localDaemonUrl()).toBe('http://127.0.0.1:5555');
  });

  test('a record left by a dead process is ignored', async () => {
    const dead = Bun.spawnSync(['true']).pid;
    await recordDaemon({ url: 'http://127.0.0.1:5555', pid: dead });
    expect(localDaemonUrl()).toBe('http://127.0.0.1:7890');
  });

  test('a garbled record is ignored', async () => {
    for (const content of ['not json', '{"url":5,"pid":1}', '{"url":"http://x","pid":"1"}', 'null']) {
      await writeFile(daemonRecordPath(), content);
      expect(localDaemonUrl()).toBe('http://127.0.0.1:7890');
    }
  });

  test("a daemon removes only its own record, never a newer daemon's", async () => {
    await recordDaemon({ url: 'http://127.0.0.1:5555', pid: process.pid });
    forgetDaemon(process.pid + 1);
    expect(existsSync(daemonRecordPath())).toBe(true);
    forgetDaemon(process.pid);
    expect(existsSync(daemonRecordPath())).toBe(false);
  });
});

describe('agentio daemon start --json', () => {
  const clean = { AGENTIO_PASSPHRASE: '', AGENTIO_TOKEN: '', AGENTIO_DAEMON_HOST: '', AGENTIO_DAEMON_PORT: '' };

  async function seedVault(): Promise<void> {
    const vault = join(tempHome, '.config', 'agentio', 'vault.enc');
    const contents = { version: 1, config: { profiles: {} }, credentials: {} };
    await writeFile(vault, await encryptVault(JSON.stringify(contents), PASSPHRASE), { mode: 0o600 });
    await writeFile(join(tempHome, '.config', 'agentio', 'vault.path'), vault);
  }

  function spawnCli(args: string[], env: Record<string, string> = {}) {
    return Bun.spawn(['bun', 'run', 'src/index.ts', ...args], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, HOME: tempHome, ...clean, ...env },
    });
  }

  async function runCli(args: string[], env: Record<string, string> = {}) {
    const proc = spawnCli(args, env);
    const exitCode = await proc.exited;
    return { exitCode, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() };
  }

  /** Read stdout up to the first complete line. */
  async function firstLine(stream: ReadableStream<Uint8Array>): Promise<{ line: string; reader: ReadableStreamDefaultReader<Uint8Array> }> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const deadline = Date.now() + 15_000;
    while (!buffer.includes('\n')) {
      if (Date.now() > deadline) throw new Error(`no line on stdout, got: ${buffer}`);
      const { value, done } = await reader.read();
      if (done) throw new Error(`stdout closed before a line, got: ${buffer}`);
      buffer += decoder.decode(value);
    }
    expect(buffer.endsWith('\n')).toBe(true);
    return { line: buffer.trimEnd(), reader };
  }

  test('on loopback and a free port: reports the real URL, is found by status, and cleans up on stop', async () => {
    await seedVault();
    const proc = spawnCli(['daemon', 'start', '--host', '127.0.0.1', '--port', '0', '--json']);
    try {
      const { line, reader } = await firstLine(proc.stdout);
      const listening = JSON.parse(line);
      expect(listening).toMatchObject({ v: 1, event: 'listening', locked: true });
      const url = new URL(listening.url);
      expect(url.hostname).toBe('127.0.0.1');
      expect(Number(url.port)).toBeGreaterThan(0);
      expect(Number(url.port)).not.toBe(7890);

      expect((await fetch(`${listening.url}/health`)).status).toBe(200);

      // Not reachable from another interface of this machine.
      const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
      if (lan) {
        const reached = await fetch(`http://${lan.address}:${url.port}/health`, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false);
        expect(reached).toBe(false);
      }

      const status = await runCli(['daemon', 'status', '--json']);
      expect(status.exitCode).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({ v: 1, event: 'daemon', running: true, url: listening.url, locked: true });

      proc.kill('SIGTERM');
      expect(await proc.exited).toBe(0);
      let rest = '';
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) rest += new TextDecoder().decode(chunk.value);
      // Nothing but JSON ever reached stdout: the log went to stderr.
      expect(rest).toBe('{"v":1,"event":"stopped"}\n');
      expect(await new Response(proc.stderr).text()).toContain('Daemon ready');
      expect(existsSync(daemonRecordPath())).toBe(false);

      const after = await runCli(['daemon', 'status', '--json']);
      expect(JSON.parse(after.stdout)).toEqual({ v: 1, event: 'daemon', running: false, url: 'http://127.0.0.1:7890' });
    } finally {
      proc.kill('SIGKILL');
    }
  }, 30_000);

  test('AGENTIO_PASSPHRASE unlocks it, and the environment variables set the address', async () => {
    await seedVault();
    const proc = spawnCli(['daemon', 'start', '--json'], {
      AGENTIO_PASSPHRASE: PASSPHRASE,
      AGENTIO_DAEMON_HOST: '127.0.0.1',
      AGENTIO_DAEMON_PORT: '0',
    });
    try {
      const { line, reader } = await firstLine(proc.stdout);
      const listening = JSON.parse(line);
      expect(listening.locked).toBe(false);
      expect(listening.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(listening.url).not.toBe('http://127.0.0.1:7890');

      // An unlocked daemon starts the keepalive loop, which logs; none of it may reach stdout.
      proc.kill('SIGTERM');
      await proc.exited;
      let rest = '';
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) rest += new TextDecoder().decode(chunk.value);
      expect(rest).toBe('{"v":1,"event":"stopped"}\n');
      expect(await new Response(proc.stderr).text()).toContain('Token keepalive');
    } finally {
      proc.kill('SIGKILL');
      await proc.exited;
    }
  }, 30_000);

  test('a port already in use is a JSON CONFIG_ERROR and leaves no record', async () => {
    await seedVault();
    const blocker = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('taken') });
    try {
      const res = await runCli(['daemon', 'start', '--host', '127.0.0.1', '--port', String(blocker.port), '--json']);
      expect(res.exitCode).toBe(3);
      expect(res.stdout.trimEnd().split('\n')).toHaveLength(1);
      const error = JSON.parse(res.stdout);
      expect(error).toMatchObject({ v: 1, event: 'error', code: 'CONFIG_ERROR' });
      expect(error.message).toContain(`127.0.0.1:${blocker.port}`);
      expect(existsSync(daemonRecordPath())).toBe(false);
    } finally {
      blocker.stop(true);
    }
  }, 30_000);

  test('an invalid port is refused before the vault is touched', async () => {
    await seedVault();
    const res = await runCli(['daemon', 'start', '--port', '99999', '--json'], { AGENTIO_PASSPHRASE: 'wrong-passphrase' });
    expect(res.exitCode).toBe(1);
    expect(JSON.parse(res.stdout)).toMatchObject({ event: 'error', code: 'INVALID_PARAMS', message: 'Invalid daemon port: 99999' });
  });

  test('a wrong AGENTIO_PASSPHRASE is a JSON error, not a listening event', async () => {
    await seedVault();
    const res = await runCli(['daemon', 'start', '--host', '127.0.0.1', '--port', '0', '--json'], { AGENTIO_PASSPHRASE: 'wrong-passphrase' });
    expect(res.exitCode).toBe(2);
    expect(res.stdout.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(res.stdout)).toMatchObject({ v: 1, event: 'error', code: 'AUTH_FAILED' });
  });

  test('daemon status works without a vault', async () => {
    const res = await runCli(['daemon', 'status', '--json']);
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ v: 1, event: 'daemon', running: false, url: 'http://127.0.0.1:7890' });
  });
});
