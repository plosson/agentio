import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Subprocess } from 'bun';

/**
 * Integration tests for the agentio HTTP server daemon.
 *
 * Each test:
 *   1. mkdtemps an isolated HOME so the spawned daemon never touches the
 *      developer's real ~/.config/agentio.
 *   2. Picks a free port from the OS via Bun.serve({port: 0}).
 *   3. Spawns `bun run src/index.ts server start --foreground` in a
 *      subprocess with that HOME, parses stdout for the API key + ready
 *      line, then exercises the daemon over a real socket.
 *   4. Sends SIGTERM in afterEach and removes the temp HOME.
 *
 * The goal is to nail down behavior I asserted but didn't actually
 * verify in Phase 2: the source-priority chain for port/host/api-key,
 * persistence semantics, and adversarial start conditions.
 */

interface RunningServer {
  proc: Subprocess<'ignore', 'pipe', 'pipe'>;
  apiKey: string;
  /** Full stdout buffer captured up to the "Server ready" line. */
  startupLog: string;
}

let tempHome = '';
let active: RunningServer | null = null;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'agentio-server-test-'));
});

afterEach(async () => {
  if (active) {
    try {
      await shutdown(active.proc, 'SIGTERM');
    } catch {
      try {
        active.proc.kill('SIGKILL');
        await active.proc.exited;
      } catch {
        /* ignore */
      }
    }
    active = null;
  }
  if (tempHome) {
    await rm(tempHome, { recursive: true, force: true }).catch(() => {});
    tempHome = '';
  }
});

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

async function findFreePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = probe.port;
  probe.stop(true);
  if (typeof port !== 'number') {
    throw new Error('Bun.serve did not return a numeric port');
  }
  return port;
}

interface StartOpts {
  port?: number;
  extraArgs?: string[];
  extraEnv?: Record<string, string>;
  expectFailure?: boolean;
  /** Override HOME for this run (defaults to the per-test tempHome). */
  home?: string;
}

async function startServer(opts: StartOpts = {}): Promise<RunningServer> {
  const port = opts.port ?? (await findFreePort());
  const home = opts.home ?? tempHome;

  // Strip variables from the parent env that would otherwise pollute the
  // child's behavior. We want a hermetic run.
  const env: Record<string, string> = {
    ...process.env,
    HOME: home,
    AGENTIO_SERVER_PORT: '',
    AGENTIO_SERVER_HOST: '',
    AGENTIO_SERVER_API_KEY: '',
    ...(opts.extraEnv ?? {}),
  };
  // Bun's spawn treats empty-string env vars as set; delete the ones we
  // explicitly want unset (unless extraEnv re-set them).
  for (const k of [
    'AGENTIO_SERVER_PORT',
    'AGENTIO_SERVER_HOST',
    'AGENTIO_SERVER_API_KEY',
  ]) {
    if (!opts.extraEnv?.[k]) delete env[k];
  }

  const proc = Bun.spawn(
    [
      'bun',
      'run',
      'src/index.ts',
      'server',
      'start',
      '--foreground',
      '--port',
      String(port),
      ...(opts.extraArgs ?? []),
    ],
    { stdout: 'pipe', stderr: 'pipe', env }
  );

  if (opts.expectFailure) {
    return {
      proc: proc as Subprocess<'ignore', 'pipe', 'pipe'>,
      apiKey: '',
      startupLog: '',
    };
  }

  // Race: read stdout until "Server ready", or proc exits, or 10s timeout.
  const decoder = new TextDecoder();
  let buffer = '';
  const reader = proc.stdout.getReader();
  const deadline = Date.now() + 10_000;

  try {
    while (!buffer.includes('Server ready')) {
      if (Date.now() > deadline) {
        proc.kill('SIGKILL');
        throw new Error(`startup timeout. stdout so far:\n${buffer}`);
      }
      const readPromise = reader.read();
      const timeoutMs = Math.max(100, deadline - Date.now());
      const { done, value } = await Promise.race([
        readPromise,
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), timeoutMs)
        ),
      ]);
      if (done) {
        const stderrText = await new Response(proc.stderr).text();
        throw new Error(
          `child exited or timed out before ready. stdout:\n${buffer}\nstderr:\n${stderrText}`
        );
      }
      buffer += decoder.decode(value);
    }
  } finally {
    reader.releaseLock();
  }

  const apiKeyMatch = buffer.match(/API Key: (\S+)/);
  const apiKey = apiKeyMatch ? apiKeyMatch[1] : '';

  const running: RunningServer = {
    proc: proc as Subprocess<'ignore', 'pipe', 'pipe'>,
    apiKey,
    startupLog: buffer,
  };
  active = running;
  return running;
}

async function shutdown(
  proc: Subprocess<'ignore', 'pipe', 'pipe'>,
  signal: 'SIGTERM' | 'SIGINT' = 'SIGTERM'
): Promise<number> {
  proc.kill(signal);
  const result = await Promise.race([
    proc.exited.then((code) => ({ ok: true, code })),
    new Promise<{ ok: false }>((resolve) =>
      setTimeout(() => resolve({ ok: false }), 5000)
    ),
  ]);
  if (!result.ok) {
    proc.kill('SIGKILL');
    await proc.exited;
    throw new Error(`process did not exit on ${signal} within 5s`);
  }
  return result.code;
}

async function readPersistedConfig(home: string): Promise<{
  raw: string;
  parsed: { server?: { apiKey?: string; port?: number; host?: string } };
}> {
  const path = join(home, '.config', 'agentio', 'config.json');
  const raw = await readFile(path, 'utf8');
  return { raw, parsed: JSON.parse(raw) };
}

/* ------------------------------------------------------------------ */
/* tests                                                              */
/* ------------------------------------------------------------------ */

describe('first run — API key generation + persistence', () => {
  test('auto-generates an API key with srv_ prefix and ~33 base64url chars', async () => {
    const { apiKey, startupLog } = await startServer();
    expect(apiKey).toMatch(/^srv_[A-Za-z0-9_-]+$/);
    // 24 random bytes encoded as base64url = 32 chars (no padding)
    expect(apiKey.length).toBe(4 + 32);
    expect(startupLog).toContain('Generated new API key');
    expect(startupLog).toContain(`API Key: ${apiKey}`);
  });

  test('persists the generated key to config.server.apiKey', async () => {
    const { apiKey } = await startServer();
    const { parsed } = await readPersistedConfig(tempHome);
    expect(parsed.server?.apiKey).toBe(apiKey);
  });

  test('config file is created with mode 0600', async () => {
    await startServer();
    const path = join(tempHome, '.config', 'agentio', 'config.json');
    const st = await stat(path);
    // Mask out non-permission bits.
    const mode = st.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('config dir is auto-created when it did not exist', async () => {
    // tempHome was just mkdtemped — it definitely has no .config/agentio yet.
    await startServer();
    const dirStat = await stat(join(tempHome, '.config', 'agentio'));
    expect(dirStat.isDirectory()).toBe(true);
  });

  test('Listening line shows the actual bound host:port', async () => {
    const port = await findFreePort();
    const { startupLog } = await startServer({ port });
    expect(startupLog).toContain(`Listening on http://0.0.0.0:${port}`);
  });
});

describe('second run — persistence across restarts', () => {
  test('reuses the persisted API key on a fresh process', async () => {
    const first = await startServer();
    await shutdown(first.proc);
    active = null;

    const second = await startServer();
    expect(second.apiKey).toBe(first.apiKey);
    expect(second.startupLog).not.toContain('Generated new API key');
  });

  test('deleting apiKey from config and restarting generates a fresh one', async () => {
    const first = await startServer();
    await shutdown(first.proc);
    active = null;

    // Wipe just the apiKey field, keep the rest of the config.
    const cfgPath = join(tempHome, '.config', 'agentio', 'config.json');
    const raw = await readFile(cfgPath, 'utf8');
    const cfg = JSON.parse(raw);
    delete cfg.server.apiKey;
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2));

    const second = await startServer();
    expect(second.apiKey).not.toBe(first.apiKey);
    expect(second.apiKey).toMatch(/^srv_/);
    expect(second.startupLog).toContain('Generated new API key');
  });

  test('corrupted config.json does not crash; daemon resets and generates new key', async () => {
    // Pre-create a config dir with garbage.
    await mkdir(join(tempHome, '.config', 'agentio'), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      join(tempHome, '.config', 'agentio', 'config.json'),
      '{ this is not valid json',
      { mode: 0o600 }
    );

    const { apiKey, startupLog } = await startServer();
    expect(apiKey).toMatch(/^srv_/);
    expect(startupLog).toContain('Generated new API key');

    // The corrupted file should have been backed up.
    const backupStat = await stat(
      join(tempHome, '.config', 'agentio', 'config.json.backup')
    );
    expect(backupStat.isFile()).toBe(true);
  });
});

describe('source priority — CLI > env > config > default', () => {
  test('--api-key overrides stored key without persisting', async () => {
    // Seed: generate a stored key.
    const first = await startServer();
    const stored = first.apiKey;
    await shutdown(first.proc);
    active = null;

    // Run again with --api-key override.
    const second = await startServer({
      extraArgs: ['--api-key', 'srv_cli_override_value'],
    });
    expect(second.apiKey).toBe('srv_cli_override_value');

    // The persisted key MUST not have been overwritten.
    const { parsed } = await readPersistedConfig(tempHome);
    expect(parsed.server?.apiKey).toBe(stored);
  });

  test('AGENTIO_SERVER_API_KEY env overrides stored key without persisting', async () => {
    const first = await startServer();
    const stored = first.apiKey;
    await shutdown(first.proc);
    active = null;

    const second = await startServer({
      extraEnv: { AGENTIO_SERVER_API_KEY: 'srv_env_override_value' },
    });
    expect(second.apiKey).toBe('srv_env_override_value');

    const { parsed } = await readPersistedConfig(tempHome);
    expect(parsed.server?.apiKey).toBe(stored);
  });

  test('--api-key beats AGENTIO_SERVER_API_KEY env (CLI wins)', async () => {
    const { apiKey } = await startServer({
      extraArgs: ['--api-key', 'cli_wins'],
      extraEnv: { AGENTIO_SERVER_API_KEY: 'env_loses' },
    });
    expect(apiKey).toBe('cli_wins');
  });

  test('--port flag wins over default', async () => {
    const port = await findFreePort();
    const { startupLog } = await startServer({ port });
    expect(startupLog).toContain(`Listening on http://0.0.0.0:${port}`);
    expect(startupLog).not.toContain('Listening on http://0.0.0.0:9999');
  });

  test('--host 127.0.0.1 binds to loopback only', async () => {
    const port = await findFreePort();
    const { startupLog } = await startServer({
      port,
      extraArgs: ['--host', '127.0.0.1'],
    });
    expect(startupLog).toContain(`Listening on http://127.0.0.1:${port}`);
    // Verify it's actually reachable on loopback.
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
  });
});

describe('HTTP behavior over a real socket', () => {
  test('GET /health returns 200 {ok:true}', async () => {
    const port = await findFreePort();
    await startServer({ port });
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({ ok: true });
  });

  test('GET /.well-known/oauth-protected-resource returns RFC 9728 metadata', async () => {
    const port = await findFreePort();
    await startServer({ port });
    const res = await fetch(
      `http://127.0.0.1:${port}/.well-known/oauth-protected-resource`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.resource).toBe(`http://127.0.0.1:${port}/mcp`);
    expect(body.authorization_servers).toEqual([
      `http://127.0.0.1:${port}`,
    ]);
    expect(body.bearer_methods_supported).toEqual(['header']);
  });

  test('GET /.well-known/oauth-authorization-server returns RFC 8414 metadata', async () => {
    const port = await findFreePort();
    await startServer({ port });
    const res = await fetch(
      `http://127.0.0.1:${port}/.well-known/oauth-authorization-server`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.issuer).toBe(`http://127.0.0.1:${port}`);
    expect(body.authorization_endpoint).toBe(
      `http://127.0.0.1:${port}/authorize`
    );
    expect(body.token_endpoint).toBe(`http://127.0.0.1:${port}/token`);
    expect(body.registration_endpoint).toBe(
      `http://127.0.0.1:${port}/register`
    );
    expect(body.code_challenge_methods_supported).toEqual(['S256']);
    expect(body.grant_types_supported).toEqual(['authorization_code']);
  });

  test('POST to a metadata endpoint returns 404 (GET-only routing)', async () => {
    const port = await findFreePort();
    await startServer({ port });
    const res = await fetch(
      `http://127.0.0.1:${port}/.well-known/oauth-protected-resource`,
      { method: 'POST' }
    );
    expect(res.status).toBe(404);
  });

  test('GET /nonsense returns 404 {error:"not found"}', async () => {
    const port = await findFreePort();
    await startServer({ port });
    const res = await fetch(`http://127.0.0.1:${port}/nonsense`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  test('50 concurrent /health requests all return 200', async () => {
    const port = await findFreePort();
    await startServer({ port });
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        fetch(`http://127.0.0.1:${port}/health`)
      )
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    // Drain bodies so the test doesn't leak handles.
    await Promise.all(results.map((r) => r.text()));
  });

  test('mixed concurrent /health and 404 requests resolve correctly', async () => {
    const port = await findFreePort();
    await startServer({ port });
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        fetch(`http://127.0.0.1:${port}${i % 2 === 0 ? '/health' : '/nope'}`)
      )
    );
    const oks = results.filter((r) => r.status === 200).length;
    const fourofours = results.filter((r) => r.status === 404).length;
    expect(oks).toBe(20);
    expect(fourofours).toBe(20);
    await Promise.all(results.map((r) => r.text()));
  });

  test('POST /health (any method) returns 200', async () => {
    const port = await findFreePort();
    await startServer({ port });
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      method: 'POST',
      body: 'ignored',
    });
    expect(res.status).toBe(200);
  });
});

describe('lifecycle — signals + restart', () => {
  test('SIGTERM exits with code 0', async () => {
    const { proc } = await startServer();
    const code = await shutdown(proc, 'SIGTERM');
    expect(code).toBe(0);
    active = null;
  });

  test('SIGINT exits with code 0', async () => {
    const { proc } = await startServer();
    const code = await shutdown(proc, 'SIGINT');
    expect(code).toBe(0);
    active = null;
  });

  test('repeated SIGTERM is idempotent (shutdownRequested guard)', async () => {
    const { proc } = await startServer();
    proc.kill('SIGTERM');
    proc.kill('SIGTERM'); // Second one should be a no-op, not a crash.
    const code = await Promise.race([
      proc.exited,
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error('did not exit')), 5000)
      ),
    ]);
    expect(code).toBe(0);
    active = null;
  });
});

describe('adversarial start conditions', () => {
  test('binding to an already-occupied port fails non-zero', async () => {
    const port = await findFreePort();
    // Squat on the port with a local Bun.serve so the spawned daemon
    // can't grab it.
    const squatter = Bun.serve({ port, fetch: () => new Response('squat') });
    try {
      const proc = Bun.spawn(
        [
          'bun',
          'run',
          'src/index.ts',
          'server',
          'start',
          '--foreground',
          '--port',
          String(port),
        ],
        {
          stdout: 'pipe',
          stderr: 'pipe',
          env: { ...process.env, HOME: tempHome },
        }
      );

      // Wait up to 5s for it to fail.
      const result = await Promise.race([
        proc.exited.then((code) => ({ exited: true, code })),
        new Promise<{ exited: false }>((resolve) =>
          setTimeout(() => resolve({ exited: false }), 5000)
        ),
      ]);

      if (!result.exited) {
        proc.kill('SIGKILL');
        await proc.exited;
        throw new Error('daemon stayed up despite occupied port');
      }
      expect(result.code).not.toBe(0);
    } finally {
      squatter.stop(true);
    }
  });

  test('--port with non-numeric value crashes early (does not silently use default)', async () => {
    const proc = Bun.spawn(
      [
        'bun',
        'run',
        'src/index.ts',
        'server',
        'start',
        '--foreground',
        '--port',
        'not-a-number',
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, HOME: tempHome },
      }
    );

    const result = await Promise.race([
      proc.exited.then((code) => ({ exited: true, code })),
      new Promise<{ exited: false }>((resolve) =>
        setTimeout(() => resolve({ exited: false }), 5000)
      ),
    ]);

    if (!result.exited) {
      proc.kill('SIGKILL');
      await proc.exited;
      throw new Error('daemon stayed up despite NaN port');
    }
    // Either it crashed (non-zero) or somehow ignored the value. Lock in
    // crash behavior — silently substituting the default would be a footgun.
    expect(result.code).not.toBe(0);
  });

  test('--port with negative value crashes early', async () => {
    const proc = Bun.spawn(
      [
        'bun',
        'run',
        'src/index.ts',
        'server',
        'start',
        '--foreground',
        '--port',
        '-1',
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, HOME: tempHome },
      }
    );

    const result = await Promise.race([
      proc.exited.then((code) => ({ exited: true, code })),
      new Promise<{ exited: false }>((resolve) =>
        setTimeout(() => resolve({ exited: false }), 5000)
      ),
    ]);

    if (!result.exited) {
      proc.kill('SIGKILL');
      await proc.exited;
      throw new Error('daemon stayed up despite negative port');
    }
    expect(result.code).not.toBe(0);
  });

  test('--port 99999 (out of range) crashes early', async () => {
    const proc = Bun.spawn(
      [
        'bun',
        'run',
        'src/index.ts',
        'server',
        'start',
        '--foreground',
        '--port',
        '99999',
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, HOME: tempHome },
      }
    );

    const result = await Promise.race([
      proc.exited.then((code) => ({ exited: true, code })),
      new Promise<{ exited: false }>((resolve) =>
        setTimeout(() => resolve({ exited: false }), 5000)
      ),
    ]);

    if (!result.exited) {
      proc.kill('SIGKILL');
      await proc.exited;
      throw new Error('daemon stayed up despite out-of-range port');
    }
    expect(result.code).not.toBe(0);
  });
});
