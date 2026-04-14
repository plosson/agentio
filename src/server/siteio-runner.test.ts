import { describe, expect, test } from 'bun:test';

import {
  createSiteioRunner,
  type SpawnFn,
  type SpawnOptions,
  type SpawnedProcess,
} from './siteio-runner';

/**
 * Unit tests for the siteio subprocess wrapper. Every test injects a
 * mock `spawn` that records the argv it was called with and returns
 * stubbed output. The real `siteio` binary is never invoked.
 */

interface MockCall {
  cmd: string[];
  env?: Record<string, string>;
}

interface MockSpawnOptions {
  /** Sequence of responses, one per call, consumed in order. */
  responses: SpawnedProcess[];
  /** Optional: make spawn itself throw (e.g. ENOENT). */
  throwOn?: (opts: SpawnOptions) => Error | null;
}

function makeMockSpawn(opts: MockSpawnOptions): {
  spawn: SpawnFn;
  calls: MockCall[];
} {
  const calls: MockCall[] = [];
  let idx = 0;
  const spawn: SpawnFn = async (o) => {
    calls.push({ cmd: [...o.cmd], env: o.env });
    const err = opts.throwOn?.(o);
    if (err) throw err;
    if (idx >= opts.responses.length) {
      throw new Error(
        `mock spawn ran out of responses at call #${idx + 1}; cmd=${o.cmd.join(' ')}`
      );
    }
    return opts.responses[idx++];
  };
  return { spawn, calls };
}

const OK: SpawnedProcess = { exitCode: 0, stdout: '', stderr: '' };
const FAIL_1 = (stderr: string): SpawnedProcess => ({
  exitCode: 1,
  stdout: '',
  stderr,
});

/* ------------------------------------------------------------------ */
/* isInstalled                                                         */
/* ------------------------------------------------------------------ */

describe('isInstalled', () => {
  test('siteio --version exits 0 → true', async () => {
    const { spawn, calls } = makeMockSpawn({ responses: [OK] });
    const runner = createSiteioRunner(spawn);
    expect(await runner.isInstalled()).toBe(true);
    expect(calls[0].cmd).toEqual(['siteio', '--version']);
  });

  test('siteio --version exits non-zero → false', async () => {
    const { spawn } = makeMockSpawn({ responses: [FAIL_1('nope')] });
    const runner = createSiteioRunner(spawn);
    expect(await runner.isInstalled()).toBe(false);
  });

  test('spawn throws (ENOENT — binary missing) → false', async () => {
    const { spawn } = makeMockSpawn({
      responses: [],
      throwOn: () => new Error('ENOENT'),
    });
    const runner = createSiteioRunner(spawn);
    expect(await runner.isInstalled()).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* isLoggedIn                                                          */
/* ------------------------------------------------------------------ */

describe('isLoggedIn', () => {
  test('siteio status exits 0 → true', async () => {
    const { spawn, calls } = makeMockSpawn({ responses: [OK] });
    const runner = createSiteioRunner(spawn);
    expect(await runner.isLoggedIn()).toBe(true);
    expect(calls[0].cmd).toEqual(['siteio', 'status']);
  });

  test('siteio status exits non-zero → false', async () => {
    const { spawn } = makeMockSpawn({
      responses: [FAIL_1('not logged in')],
    });
    const runner = createSiteioRunner(spawn);
    expect(await runner.isLoggedIn()).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* findApp                                                             */
/* ------------------------------------------------------------------ */

describe('findApp', () => {
  test('returns the matching app when present (array JSON)', async () => {
    const { spawn, calls } = makeMockSpawn({
      responses: [
        {
          exitCode: 0,
          stdout: JSON.stringify([
            { name: 'other', url: 'https://other.example.com' },
            { name: 'mcp', url: 'https://mcp.example.com' },
          ]),
          stderr: '',
        },
      ],
    });
    const runner = createSiteioRunner(spawn);
    const app = await runner.findApp('mcp');
    expect(app).not.toBeNull();
    expect(app!.name).toBe('mcp');
    expect(app!.url).toBe('https://mcp.example.com');
    expect(calls[0].cmd).toEqual([
      'siteio',
      'apps',
      'list',
      '--json',
    ]);
  });

  test('returns null when no app matches', async () => {
    const { spawn } = makeMockSpawn({
      responses: [
        {
          exitCode: 0,
          stdout: JSON.stringify([{ name: 'other' }]),
          stderr: '',
        },
      ],
    });
    const runner = createSiteioRunner(spawn);
    expect(await runner.findApp('mcp')).toBeNull();
  });

  test('returns null when the list is empty', async () => {
    const { spawn } = makeMockSpawn({
      responses: [{ exitCode: 0, stdout: '[]', stderr: '' }],
    });
    const runner = createSiteioRunner(spawn);
    expect(await runner.findApp('mcp')).toBeNull();
  });

  test('accepts {apps: [...]} wrapper shape', async () => {
    const { spawn } = makeMockSpawn({
      responses: [
        {
          exitCode: 0,
          stdout: JSON.stringify({ apps: [{ name: 'mcp' }] }),
          stderr: '',
        },
      ],
    });
    const runner = createSiteioRunner(spawn);
    const app = await runner.findApp('mcp');
    expect(app).not.toBeNull();
    expect(app!.name).toBe('mcp');
  });

  test('accepts {success, data: [...]} wrapper shape (real siteio CLI)', async () => {
    const { spawn } = makeMockSpawn({
      responses: [
        {
          exitCode: 0,
          stdout: JSON.stringify({
            success: true,
            data: [{ name: 'mcp', url: 'https://mcp.x.siteio.me' }],
          }),
          stderr: '',
        },
      ],
    });
    const runner = createSiteioRunner(spawn);
    const app = await runner.findApp('mcp');
    expect(app).not.toBeNull();
    expect(app!.name).toBe('mcp');
    expect(app!.url).toBe('https://mcp.x.siteio.me');
  });

  test('{success, data: []} empty list returns null', async () => {
    const { spawn } = makeMockSpawn({
      responses: [
        {
          exitCode: 0,
          stdout: JSON.stringify({ success: true, data: [] }),
          stderr: '',
        },
      ],
    });
    const runner = createSiteioRunner(spawn);
    expect(await runner.findApp('mcp')).toBeNull();
  });

  test('strips progress-line prefix before JSON (real siteio CLI quirk)', async () => {
    const { spawn } = makeMockSpawn({
      responses: [
        {
          exitCode: 0,
          stdout:
            '- Fetching apps\n' +
            JSON.stringify({ success: true, data: [{ name: 'mcp' }] }),
          stderr: '',
        },
      ],
    });
    const runner = createSiteioRunner(spawn);
    const app = await runner.findApp('mcp');
    expect(app).not.toBeNull();
    expect(app!.name).toBe('mcp');
  });

  test('throws when siteio exits non-zero', async () => {
    const { spawn } = makeMockSpawn({
      responses: [FAIL_1('api error')],
    });
    const runner = createSiteioRunner(spawn);
    await expect(runner.findApp('mcp')).rejects.toThrow(/failed/);
  });

  test('throws on unparseable JSON', async () => {
    const { spawn } = makeMockSpawn({
      responses: [{ exitCode: 0, stdout: 'not json', stderr: '' }],
    });
    const runner = createSiteioRunner(spawn);
    await expect(runner.findApp('mcp')).rejects.toThrow(/unparseable/);
  });

  test('throws when the JSON is a shape we do not understand', async () => {
    const { spawn } = makeMockSpawn({
      responses: [
        { exitCode: 0, stdout: JSON.stringify({ hello: 'world' }), stderr: '' },
      ],
    });
    const runner = createSiteioRunner(spawn);
    await expect(runner.findApp('mcp')).rejects.toThrow(/expected an array/);
  });
});

/* ------------------------------------------------------------------ */
/* createApp                                                           */
/* ------------------------------------------------------------------ */

describe('createApp — inline mode', () => {
  test('emits exact argv: siteio apps create <name> -f <path> -p <port>', async () => {
    const { spawn, calls } = makeMockSpawn({ responses: [OK] });
    const runner = createSiteioRunner(spawn);
    await runner.createApp({
      name: 'mcp',
      dockerfilePath: '/tmp/Dockerfile.abc123',
      port: 9999,
    });
    expect(calls[0].cmd).toEqual([
      'siteio',
      'apps',
      'create',
      'mcp',
      '-f',
      '/tmp/Dockerfile.abc123',
      '-p',
      '9999',
    ]);
  });

  test('throws on non-zero exit with a descriptive error', async () => {
    const { spawn } = makeMockSpawn({
      responses: [FAIL_1('app already exists')],
    });
    const runner = createSiteioRunner(spawn);
    await expect(
      runner.createApp({
        name: 'mcp',
        dockerfilePath: '/tmp/Dockerfile',
        port: 9999,
      })
    ).rejects.toThrow(/create mcp/);
  });
});

describe('createApp — git mode', () => {
  test('emits: siteio apps create <name> -g <url> --branch <b> --dockerfile <path> -p <port>', async () => {
    const { spawn, calls } = makeMockSpawn({ responses: [OK] });
    const runner = createSiteioRunner(spawn);
    await runner.createApp({
      name: 'mcp',
      port: 9999,
      git: {
        repoUrl: 'https://github.com/plosson/agentio.git',
        branch: 'http-mcp-server-phase-1',
        dockerfilePath: 'docker/Dockerfile.teleport',
      },
    });
    expect(calls[0].cmd).toEqual([
      'siteio',
      'apps',
      'create',
      'mcp',
      '-g',
      'https://github.com/plosson/agentio.git',
      '--branch',
      'http-mcp-server-phase-1',
      '--dockerfile',
      'docker/Dockerfile.teleport',
      '-p',
      '9999',
    ]);
  });

  test('passes port at the END so siteio parses flags in a stable order', async () => {
    const { spawn, calls } = makeMockSpawn({ responses: [OK] });
    const runner = createSiteioRunner(spawn);
    await runner.createApp({
      name: 'x',
      port: 1234,
      git: {
        repoUrl: 'https://git.example.com/r.git',
        branch: 'main',
        dockerfilePath: 'D',
      },
    });
    expect(calls[0].cmd.slice(-2)).toEqual(['-p', '1234']);
  });

  test('throws on non-zero exit', async () => {
    const { spawn } = makeMockSpawn({
      responses: [FAIL_1('clone failed: not found')],
    });
    const runner = createSiteioRunner(spawn);
    await expect(
      runner.createApp({
        name: 'mcp',
        port: 9999,
        git: {
          repoUrl: 'https://example.com/missing.git',
          branch: 'main',
          dockerfilePath: 'D',
        },
      })
    ).rejects.toThrow(/create mcp/);
  });
});

describe('createApp — mode exclusivity', () => {
  test('neither dockerfilePath nor git → throws', async () => {
    const { spawn } = makeMockSpawn({ responses: [] });
    const runner = createSiteioRunner(spawn);
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runner.createApp({ name: 'mcp', port: 9999 } as any)
    ).rejects.toThrow(/exactly one of/);
  });

  test('both dockerfilePath AND git → throws', async () => {
    const { spawn } = makeMockSpawn({ responses: [] });
    const runner = createSiteioRunner(spawn);
    await expect(
      runner.createApp({
        name: 'mcp',
        port: 9999,
        dockerfilePath: '/tmp/D',
        git: {
          repoUrl: 'https://x/r.git',
          branch: 'main',
          dockerfilePath: 'D',
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
    ).rejects.toThrow(/exactly one of/);
  });
});

/* ------------------------------------------------------------------ */
/* setEnv                                                              */
/* ------------------------------------------------------------------ */

describe('setEnv', () => {
  test('emits one -e flag per env var in insertion order', async () => {
    const { spawn, calls } = makeMockSpawn({ responses: [OK] });
    const runner = createSiteioRunner(spawn);
    await runner.setEnv({
      name: 'mcp',
      envVars: {
        AGENTIO_KEY: 'abc123',
        AGENTIO_CONFIG: 'base64payload',
        AGENTIO_SERVER_API_KEY: 'srv_xyz',
      },
    });
    expect(calls[0].cmd).toEqual([
      'siteio',
      'apps',
      'set',
      'mcp',
      '-e',
      'AGENTIO_KEY=abc123',
      '-e',
      'AGENTIO_CONFIG=base64payload',
      '-e',
      'AGENTIO_SERVER_API_KEY=srv_xyz',
    ]);
  });

  test('passes values containing `=` verbatim (siteio splits on first `=`)', async () => {
    const { spawn, calls } = makeMockSpawn({ responses: [OK] });
    const runner = createSiteioRunner(spawn);
    await runner.setEnv({
      name: 'mcp',
      envVars: {
        AGENTIO_CONFIG: 'base64==padding==values',
      },
    });
    expect(calls[0].cmd).toContain('AGENTIO_CONFIG=base64==padding==values');
  });

  test('passes values containing newlines verbatim', async () => {
    const { spawn, calls } = makeMockSpawn({ responses: [OK] });
    const runner = createSiteioRunner(spawn);
    await runner.setEnv({
      name: 'mcp',
      envVars: { X: 'line1\nline2' },
    });
    expect(calls[0].cmd).toContain('X=line1\nline2');
  });

  test('throws on non-zero exit', async () => {
    const { spawn } = makeMockSpawn({
      responses: [FAIL_1('validation failed')],
    });
    const runner = createSiteioRunner(spawn);
    await expect(
      runner.setEnv({ name: 'mcp', envVars: { FOO: 'bar' } })
    ).rejects.toThrow(/set env on mcp/);
  });
});

/* ------------------------------------------------------------------ */
/* deploy                                                              */
/* ------------------------------------------------------------------ */

describe('deploy', () => {
  test('minimal call: just the app name', async () => {
    const { spawn, calls } = makeMockSpawn({ responses: [OK] });
    const runner = createSiteioRunner(spawn);
    await runner.deploy({ name: 'mcp' });
    expect(calls[0].cmd).toEqual(['siteio', 'apps', 'deploy', 'mcp']);
  });

  test('with dockerfilePath appends -f <path>', async () => {
    const { spawn, calls } = makeMockSpawn({ responses: [OK] });
    const runner = createSiteioRunner(spawn);
    await runner.deploy({ name: 'mcp', dockerfilePath: '/tmp/D' });
    expect(calls[0].cmd).toEqual([
      'siteio',
      'apps',
      'deploy',
      'mcp',
      '-f',
      '/tmp/D',
    ]);
  });

  test('with noCache appends --no-cache', async () => {
    const { spawn, calls } = makeMockSpawn({ responses: [OK] });
    const runner = createSiteioRunner(spawn);
    await runner.deploy({ name: 'mcp', noCache: true });
    expect(calls[0].cmd).toEqual([
      'siteio',
      'apps',
      'deploy',
      'mcp',
      '--no-cache',
    ]);
  });

  test('with both dockerfilePath and noCache', async () => {
    const { spawn, calls } = makeMockSpawn({ responses: [OK] });
    const runner = createSiteioRunner(spawn);
    await runner.deploy({
      name: 'mcp',
      dockerfilePath: '/tmp/D',
      noCache: true,
    });
    expect(calls[0].cmd).toEqual([
      'siteio',
      'apps',
      'deploy',
      'mcp',
      '-f',
      '/tmp/D',
      '--no-cache',
    ]);
  });

  test('throws on non-zero exit', async () => {
    const { spawn } = makeMockSpawn({
      responses: [FAIL_1('build failed')],
    });
    const runner = createSiteioRunner(spawn);
    await expect(runner.deploy({ name: 'mcp' })).rejects.toThrow(
      /deploy mcp/
    );
  });
});

/* ------------------------------------------------------------------ */
/* restartApp                                                          */
/* ------------------------------------------------------------------ */

describe('restartApp', () => {
  test('emits exact argv: siteio apps restart <name>', async () => {
    const { spawn, calls } = makeMockSpawn({ responses: [OK] });
    const runner = createSiteioRunner(spawn);
    await runner.restartApp('mcp');
    expect(calls[0].cmd).toEqual(['siteio', 'apps', 'restart', 'mcp']);
  });

  test('throws on non-zero exit with descriptive error', async () => {
    const { spawn } = makeMockSpawn({
      responses: [FAIL_1('container failed to restart')],
    });
    const runner = createSiteioRunner(spawn);
    await expect(runner.restartApp('mcp')).rejects.toThrow(/restart mcp/);
  });
});

/* ------------------------------------------------------------------ */
/* appInfo                                                             */
/* ------------------------------------------------------------------ */

describe('appInfo', () => {
  test('returns parsed JSON on success', async () => {
    const { spawn, calls } = makeMockSpawn({
      responses: [
        {
          exitCode: 0,
          stdout: JSON.stringify({
            name: 'mcp',
            url: 'https://mcp.example.com',
          }),
          stderr: '',
        },
      ],
    });
    const runner = createSiteioRunner(spawn);
    const info = await runner.appInfo('mcp');
    expect(info).not.toBeNull();
    expect(info!.name).toBe('mcp');
    expect(info!.url).toBe('https://mcp.example.com');
    expect(calls[0].cmd).toEqual([
      'siteio',
      'apps',
      'info',
      'mcp',
      '--json',
    ]);
  });

  test('returns null on non-zero exit (app not found)', async () => {
    const { spawn } = makeMockSpawn({
      responses: [FAIL_1('not found')],
    });
    const runner = createSiteioRunner(spawn);
    expect(await runner.appInfo('mcp')).toBeNull();
  });

  test('returns null on unparseable JSON (graceful)', async () => {
    const { spawn } = makeMockSpawn({
      responses: [{ exitCode: 0, stdout: 'hello', stderr: '' }],
    });
    const runner = createSiteioRunner(spawn);
    expect(await runner.appInfo('mcp')).toBeNull();
  });

  test('unwraps {success, data: {...}} shape (real siteio CLI)', async () => {
    const { spawn } = makeMockSpawn({
      responses: [
        {
          exitCode: 0,
          stdout: JSON.stringify({
            success: true,
            data: { name: 'mcp', url: 'https://mcp.x.siteio.me' },
          }),
          stderr: '',
        },
      ],
    });
    const runner = createSiteioRunner(spawn);
    const info = await runner.appInfo('mcp');
    expect(info).not.toBeNull();
    expect(info!.name).toBe('mcp');
    expect(info!.url).toBe('https://mcp.x.siteio.me');
  });

  test('strips progress-line prefix from appInfo JSON', async () => {
    const { spawn } = makeMockSpawn({
      responses: [
        {
          exitCode: 0,
          stdout:
            '- Fetching app info\n' +
            JSON.stringify({
              success: true,
              data: { name: 'mcp', url: 'https://mcp.x.siteio.me' },
            }),
          stderr: '',
        },
      ],
    });
    const runner = createSiteioRunner(spawn);
    const info = await runner.appInfo('mcp');
    expect(info).not.toBeNull();
    expect(info!.url).toBe('https://mcp.x.siteio.me');
  });
});
