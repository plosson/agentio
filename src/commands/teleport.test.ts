import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  DATA_VOLUME_PATH,
  generateServerApiKey,
  hasDataVolumeMount,
  normalizeGitUrl,
  runTeleport,
  TELEPORT_DOCKERFILE_PATH,
  validateAppName,
  volumeNameFor,
  type TeleportDeps,
} from './teleport';
import type { SiteioRunner, SiteioApp } from '../server/siteio-runner';
import type { Config } from '../types/config';

/**
 * Unit tests for `agentio teleport`. Every test injects a fake
 * SiteioRunner + fake config/export/temp-file functions, so siteio is
 * never actually invoked and no files are written anywhere.
 *
 * The tests exercise the orchestration logic: preflight checks, the
 * exact sequence of runner calls, env var assembly, dry-run behavior,
 * dockerfile-only behavior, and cleanup of the temp file on both
 * success and failure.
 */

/* ------------------------------------------------------------------ */
/* fake runner                                                         */
/* ------------------------------------------------------------------ */

interface RunnerCall {
  method: string;
  args: unknown;
}

interface FakeRunnerOptions {
  installed?: boolean;
  loggedIn?: boolean;
  existingApp?: SiteioApp | null;
  deployedApp?: SiteioApp | null;
  /** Stdout returned by logsApp. Default: empty string. */
  logsStdout?: string;
  failOn?:
    | 'isInstalled'
    | 'isLoggedIn'
    | 'findApp'
    | 'createApp'
    | 'setApp'
    | 'deploy'
    | 'restartApp'
    | 'appInfo';
}

function makeFakeRunner(opts: FakeRunnerOptions = {}): {
  runner: SiteioRunner;
  calls: RunnerCall[];
} {
  const calls: RunnerCall[] = [];

  const shouldFail = (method: FakeRunnerOptions['failOn']): boolean =>
    opts.failOn === method;

  const runner: SiteioRunner = {
    async isInstalled() {
      calls.push({ method: 'isInstalled', args: null });
      if (shouldFail('isInstalled')) throw new Error('spawn failure');
      return opts.installed ?? true;
    },
    async isLoggedIn() {
      calls.push({ method: 'isLoggedIn', args: null });
      if (shouldFail('isLoggedIn')) throw new Error('spawn failure');
      return opts.loggedIn ?? true;
    },
    async findApp(name) {
      calls.push({ method: 'findApp', args: { name } });
      if (shouldFail('findApp')) throw new Error('list failed');
      return opts.existingApp ?? null;
    },
    async createApp(args) {
      calls.push({ method: 'createApp', args });
      if (shouldFail('createApp')) throw new Error('create failed');
    },
    async setApp(args) {
      calls.push({ method: 'setApp', args });
      if (shouldFail('setApp')) throw new Error('set failed');
    },
    async deploy(args) {
      calls.push({ method: 'deploy', args });
      if (shouldFail('deploy')) throw new Error('deploy failed');
    },
    async restartApp(name) {
      calls.push({ method: 'restartApp', args: { name } });
      if (shouldFail('restartApp')) throw new Error('restart failed');
    },
    async appInfo(name) {
      calls.push({ method: 'appInfo', args: { name } });
      if (shouldFail('appInfo')) return null;
      // Use `in` check so an explicit null passes through as null
      // instead of being coalesced into the default.
      if ('deployedApp' in opts) return opts.deployedApp ?? null;
      return { name, url: `https://${name}.siteio.example.com` };
    },
    async logsApp(name, logOpts) {
      calls.push({ method: 'logsApp', args: { name, opts: logOpts ?? null } });
      return opts.logsStdout ?? '';
    },
  };

  return { runner, calls };
}

/* ------------------------------------------------------------------ */
/* fake deps                                                           */
/* ------------------------------------------------------------------ */

interface FakeDepsOptions extends FakeRunnerOptions {
  profiles?: Config['profiles'];
  exportKey?: string;
  exportConfig?: string;
  fixedServerApiKey?: string;
  dockerfile?: string;
  /** Value returned by detectGitOriginUrl. Default: null. */
  gitOriginUrl?: string | null;
  /**
   * Sequence of HTTP status codes (or nulls) `probeHealth` should return
   * across successive polls. When exhausted, falls back to the default
   * (a healthy 200). Pass [] to simulate an unreachable container.
   */
  healthProbeResponses?: Array<number | null>;
}

interface FakeDeps extends TeleportDeps {
  calls: RunnerCall[];
  log: (msg: string) => void;
  warn: (msg: string) => void;
  logLines: string[];
  warnLines: string[];
  tempFileWrites: { path: string; content: string }[];
  tempFileDeletes: string[];
  healthProbeUrls: string[];
  sleepCalls: number[];
}

function makeDeps(opts: FakeDepsOptions = {}): FakeDeps {
  const { runner, calls } = makeFakeRunner(opts);
  const logLines: string[] = [];
  const warnLines: string[] = [];
  const tempFileWrites: { path: string; content: string }[] = [];
  const tempFileDeletes: string[] = [];
  const healthProbeUrls: string[] = [];
  const sleepCalls: number[] = [];

  let tempCounter = 0;
  let healthProbeIdx = 0;

  const deps: FakeDeps = {
    calls,
    logLines,
    warnLines,
    tempFileWrites,
    tempFileDeletes,
    healthProbeUrls,
    sleepCalls,
    runner,
    loadConfig: async () =>
      ({
        profiles:
          opts.profiles ?? ({ rss: [{ name: 'default' }] } as Config['profiles']),
      }) as Config,
    generateExportData: async () => ({
      key: opts.exportKey ?? 'f'.repeat(64),
      config: opts.exportConfig ?? 'fake_encrypted_blob==',
    }),
    generateServerApiKey: () =>
      opts.fixedServerApiKey ?? 'srv_testkey123456789012345678901234',
    generateDockerfile: () =>
      opts.dockerfile ?? '# fake dockerfile\nFROM scratch\n',
    writeTempFile: async (content) => {
      const path = `/tmp/fake-teleport-${tempCounter++}/Dockerfile`;
      tempFileWrites.push({ path, content });
      return path;
    },
    removeTempFile: async (path) => {
      tempFileDeletes.push(path);
    },
    detectGitOriginUrl: async () =>
      'gitOriginUrl' in opts ? (opts.gitOriginUrl ?? null) : null,
    probeHealth: async (url) => {
      healthProbeUrls.push(url);
      // Default behavior: 200 on the first probe so happy-path tests
      // don't have to configure anything. Callers exercising timeouts
      // pass `healthProbeResponses: []` or an explicit list.
      if (opts.healthProbeResponses == null) return 200;
      const list = opts.healthProbeResponses;
      if (healthProbeIdx < list.length) {
        return list[healthProbeIdx++] ?? null;
      }
      return null;
    },
    // Sleep is a no-op in tests — we don't want real time to pass.
    // The loop inside waitForHealth is bounded by Date.now() ≥ deadline,
    // so we also need the deadline to be reachable; see the test that
    // exercises a timeout, which shrinks the timeoutMs explicitly.
    sleep: async (ms) => {
      sleepCalls.push(ms);
    },
    log: (msg) => logLines.push(msg),
    warn: (msg) => warnLines.push(msg),
  };

  return deps;
}

/* ------------------------------------------------------------------ */
/* validateAppName                                                     */
/* ------------------------------------------------------------------ */

describe('validateAppName', () => {
  test.each([
    ['mcp'],
    ['m'],
    ['my-app'],
    ['app-1'],
    ['abc-def-ghi'],
    ['a0123456789'],
  ])('accepts valid name "%s"', (name) => {
    expect(() => validateAppName(name)).not.toThrow();
  });

  test.each([
    ['UPPERCASE'],
    ['CamelCase'],
    ['1starts-with-digit'],
    ['-starts-with-hyphen'],
    ['has_underscore'],
    ['has spaces'],
    ['has.dot'],
    ['has/slash'],
    [''],
    ['a'.repeat(64)], // one over max
  ])('rejects invalid name "%s"', (name) => {
    expect(() => validateAppName(name)).toThrow();
  });

  test('accepts name at max length (63)', () => {
    expect(() => validateAppName('a' + '1'.repeat(62))).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* generateServerApiKey                                                */
/* ------------------------------------------------------------------ */

describe('generateServerApiKey', () => {
  test('produces srv_ prefix + 32-char base64url body', () => {
    const k = generateServerApiKey();
    expect(k).toMatch(/^srv_[A-Za-z0-9_-]+$/);
    expect(k.length).toBe(4 + 32); // 24 bytes base64url = 32 chars
  });

  test('two calls produce distinct keys', () => {
    expect(generateServerApiKey()).not.toBe(generateServerApiKey());
  });
});

/* ------------------------------------------------------------------ */
/* runTeleport — happy path                                            */
/* ------------------------------------------------------------------ */

describe('runTeleport — happy path', () => {
  test('executes preflight → create → set → deploy → info in order', async () => {
    const deps = makeDeps();
    const result = await runTeleport({ name: 'mcp' }, deps);

    const methods = deps.calls.map((c) => c.method);
    expect(methods).toEqual([
      'isInstalled',
      'isLoggedIn',
      'findApp',
      'createApp',
      'setApp',
      'deploy',
      'appInfo',
    ]);

    expect(result.name).toBe('mcp');
    expect(result.url).toBe('https://mcp.siteio.example.com');
    expect(result.serverApiKey).toMatch(/^srv_/);
    expect(result.claudeMcpAddCommand).toContain('claude mcp add');
    expect(result.claudeMcpAddCommand).toContain('mcp.siteio.example.com/mcp');
  });

  test('createApp is called with the temp Dockerfile path + port 9999', async () => {
    const deps = makeDeps();
    await runTeleport({ name: 'mcp' }, deps);
    const createCall = deps.calls.find((c) => c.method === 'createApp');
    expect(createCall).toBeDefined();
    const args = createCall!.args as {
      name: string;
      dockerfilePath: string;
      port: number;
    };
    expect(args.name).toBe('mcp');
    expect(args.dockerfilePath).toMatch(/Dockerfile$/);
    expect(args.port).toBe(9999);
  });

  test('setApp is called with AGENTIO_KEY + AGENTIO_CONFIG + AGENTIO_SERVER_API_KEY', async () => {
    const deps = makeDeps({
      exportKey: 'key_value_from_export',
      exportConfig: 'config_blob_from_export==',
      fixedServerApiKey: 'srv_fixed_test_key',
    });
    await runTeleport({ name: 'mcp' }, deps);
    const setCall = deps.calls.find((c) => c.method === 'setApp');
    const args = setCall!.args as {
      name: string;
      envVars: Record<string, string>;
    };
    expect(args.envVars.AGENTIO_KEY).toBe('key_value_from_export');
    expect(args.envVars.AGENTIO_CONFIG).toBe('config_blob_from_export==');
    expect(args.envVars.AGENTIO_SERVER_API_KEY).toBe('srv_fixed_test_key');
  });

  test('deploy is called with the Dockerfile path (so siteio rebuilds)', async () => {
    const deps = makeDeps();
    await runTeleport({ name: 'mcp' }, deps);
    const deployCall = deps.calls.find((c) => c.method === 'deploy');
    const args = deployCall!.args as {
      name: string;
      dockerfilePath?: string;
      noCache?: boolean;
    };
    expect(args.name).toBe('mcp');
    expect(args.dockerfilePath).toMatch(/Dockerfile$/);
    expect(args.noCache).toBeUndefined();
  });

  test('--no-cache flag propagates to siteio deploy', async () => {
    const deps = makeDeps();
    await runTeleport({ name: 'mcp', noCache: true }, deps);
    const deployCall = deps.calls.find((c) => c.method === 'deploy');
    const args = deployCall!.args as { noCache?: boolean };
    expect(args.noCache).toBe(true);
  });

  test('writes Dockerfile to temp file AND deletes it on success', async () => {
    const deps = makeDeps();
    await runTeleport({ name: 'mcp' }, deps);
    expect(deps.tempFileWrites).toHaveLength(1);
    expect(deps.tempFileWrites[0].content).toContain('FROM scratch');
    expect(deps.tempFileDeletes).toHaveLength(1);
    expect(deps.tempFileDeletes[0]).toBe(deps.tempFileWrites[0].path);
  });

  test('log output mentions the API key and the claude mcp add command', async () => {
    const deps = makeDeps({ fixedServerApiKey: 'srv_abcDEF123456789012345678901234' });
    await runTeleport({ name: 'mcp' }, deps);
    const joined = deps.logLines.join('\n');
    expect(joined).toContain('srv_abcDEF123456789012345678901234');
    expect(joined).toContain('claude mcp add');
  });
});

/* ------------------------------------------------------------------ */
/* runTeleport — preflight failures                                    */
/* ------------------------------------------------------------------ */

describe('runTeleport — preflight failures', () => {
  test('siteio not installed → CliError', async () => {
    const deps = makeDeps({ installed: false });
    await expect(runTeleport({ name: 'mcp' }, deps)).rejects.toThrow(
      /not installed/
    );
    // Must NOT have tried to run any subsequent siteio operations.
    const methods = deps.calls.map((c) => c.method);
    expect(methods).toEqual(['isInstalled']);
  });

  test('siteio not logged in → CliError', async () => {
    const deps = makeDeps({ loggedIn: false });
    await expect(runTeleport({ name: 'mcp' }, deps)).rejects.toThrow(
      /logged into siteio/
    );
    const methods = deps.calls.map((c) => c.method);
    expect(methods).toEqual(['isInstalled', 'isLoggedIn']);
  });

  test('no local profiles → CliError', async () => {
    const deps = makeDeps({ profiles: {} });
    await expect(runTeleport({ name: 'mcp' }, deps)).rejects.toThrow(
      /No agentio profiles/
    );
  });

  test('app already exists → rebuild in place (no create, key preserved)', async () => {
    const deps = makeDeps({
      existingApp: { name: 'mcp', url: 'https://mcp.existing.com' },
    });
    const result = await runTeleport({ name: 'mcp' }, deps);

    const methods = deps.calls.map((c) => c.method);
    // Rebuild MUST NOT create the app — it already exists.
    expect(methods).not.toContain('createApp');
    // But it MUST push env + redeploy so the image is rebuilt.
    expect(methods).toContain('setApp');
    expect(methods).toContain('deploy');

    // setApp on rebuild preserves AGENTIO_SERVER_API_KEY by omitting it
    // from the env map (siteio merges env vars).
    const setCall = deps.calls.find((c) => c.method === 'setApp');
    expect(setCall).toBeDefined();
    const envVars = (setCall!.args as { envVars?: Record<string, string> })
      .envVars;
    expect(envVars).toBeDefined();
    expect(Object.keys(envVars!).sort()).toEqual([
      'AGENTIO_CONFIG',
      'AGENTIO_KEY',
    ]);
    expect(envVars!.AGENTIO_SERVER_API_KEY).toBeUndefined();

    // Result signals a rebuild: no new server API key emitted.
    expect(result.serverApiKey).toBe('');

    // Log messages surface the rebuild intent, and the success banner
    // is distinct from a fresh deploy.
    const logs = deps.logLines.join('\n');
    expect(logs).toMatch(/rebuild/i);
    expect(logs).toContain('Rebuild complete!');
    expect(logs).not.toContain('Teleport complete!');
    // We do NOT print the onboarding snippet on rebuild — clients
    // already have their bearer.
    expect(logs).not.toContain('To add to Claude Code:');
  });
});

/* ------------------------------------------------------------------ */
/* runTeleport — temp file lifecycle                                   */
/* ------------------------------------------------------------------ */

describe('runTeleport — temp file lifecycle', () => {
  test('deletes the temp file even when createApp fails', async () => {
    const deps = makeDeps({ failOn: 'createApp' });
    await expect(runTeleport({ name: 'mcp' }, deps)).rejects.toThrow();
    expect(deps.tempFileDeletes).toHaveLength(1);
  });

  test('deletes the temp file even when setApp fails', async () => {
    const deps = makeDeps({ failOn: 'setApp' });
    await expect(runTeleport({ name: 'mcp' }, deps)).rejects.toThrow();
    expect(deps.tempFileDeletes).toHaveLength(1);
  });

  test('deletes the temp file even when deploy fails', async () => {
    const deps = makeDeps({ failOn: 'deploy' });
    await expect(runTeleport({ name: 'mcp' }, deps)).rejects.toThrow();
    expect(deps.tempFileDeletes).toHaveLength(1);
  });

  test('appInfo returning null still completes successfully with a warning', async () => {
    const deps = makeDeps({ deployedApp: null });
    const result = await runTeleport({ name: 'mcp' }, deps);
    expect(result.url).toBeUndefined();
    expect(result.claudeMcpAddCommand).toBeNull();
    const joined = deps.logLines.join('\n');
    expect(joined).toContain('siteio did not return a URL');
  });
});

/* ------------------------------------------------------------------ */
/* runTeleport — dockerfile-only                                       */
/* ------------------------------------------------------------------ */

describe('runTeleport — dockerfile-only', () => {
  let originalWrite: typeof process.stdout.write;
  let captured: string;

  beforeEach(() => {
    captured = '';
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      captured +=
        typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  test('writes Dockerfile to stdout with no siteio interaction', async () => {
    const deps = makeDeps({ dockerfile: '# generated dockerfile\n' });
    const result = await runTeleport(
      { name: 'mcp', dockerfileOnly: true },
      deps
    );
    expect(captured).toContain('# generated dockerfile');
    // Zero siteio calls.
    expect(deps.calls).toHaveLength(0);
    expect(result.url).toBeUndefined();
  });

  test('--output writes to the given path instead of stdout', async () => {
    const deps = makeDeps({ dockerfile: '# out file\n' });
    // Use the injected writeTempFile as a side-channel? No — the code
    // uses the real fs.writeFile for --output. We test this by pointing
    // at a temp directory.
    const { mkdtemp } = await import('fs/promises');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = await mkdtemp(join(tmpdir(), 'agentio-test-output-'));
    const outPath = join(dir, 'Dockerfile.out');

    await runTeleport(
      { name: 'mcp', dockerfileOnly: true, output: outPath },
      deps
    );

    const { readFile, rm } = await import('fs/promises');
    const written = await readFile(outPath, 'utf8');
    expect(written).toContain('# out file');
    expect(deps.calls).toHaveLength(0);
    await rm(dir, { recursive: true, force: true });
  });
});

/* ------------------------------------------------------------------ */
/* runTeleport — dry-run                                               */
/* ------------------------------------------------------------------ */

describe('runTeleport — dry-run', () => {
  test('runs preflight but skips create/set/deploy', async () => {
    const deps = makeDeps();
    await runTeleport({ name: 'mcp', dryRun: true }, deps);
    const methods = deps.calls.map((c) => c.method);
    expect(methods).toContain('isInstalled');
    expect(methods).toContain('isLoggedIn');
    expect(methods).toContain('findApp');
    expect(methods).not.toContain('createApp');
    expect(methods).not.toContain('setApp');
    expect(methods).not.toContain('deploy');
  });

  test('prints the Dockerfile and the siteio commands that would run', async () => {
    const deps = makeDeps({ dockerfile: '# dry-run dockerfile\n' });
    await runTeleport({ name: 'mcp', dryRun: true }, deps);
    const joined = deps.logLines.join('\n');
    expect(joined).toContain('# dry-run dockerfile');
    expect(joined).toContain('siteio apps create mcp');
    expect(joined).toContain('siteio apps set mcp');
    expect(joined).toContain('siteio apps deploy mcp');
  });

  test('dry-run does not write a temp file OR call siteio', async () => {
    const deps = makeDeps();
    await runTeleport({ name: 'mcp', dryRun: true }, deps);
    expect(deps.tempFileWrites).toHaveLength(0);
    expect(deps.tempFileDeletes).toHaveLength(0);
  });

  test('dry-run with --no-cache shows the flag in the reported command', async () => {
    const deps = makeDeps();
    await runTeleport(
      { name: 'mcp', dryRun: true, noCache: true },
      deps
    );
    const joined = deps.logLines.join('\n');
    expect(joined).toContain('deploy mcp --no-cache');
  });

  test('dry-run redacts the AGENTIO_KEY value in printed output', async () => {
    const deps = makeDeps({
      exportKey: 'REAL_SECRET_KEY_SHOULD_NOT_APPEAR_ANYWHERE',
    });
    await runTeleport({ name: 'mcp', dryRun: true }, deps);
    const joined = deps.logLines.join('\n');
    expect(joined).not.toContain('REAL_SECRET_KEY_SHOULD_NOT_APPEAR_ANYWHERE');
    expect(joined).toContain('redacted');
  });
});

/* ------------------------------------------------------------------ */
/* runTeleport — name validation                                       */
/* ------------------------------------------------------------------ */

describe('runTeleport — name validation', () => {
  test('invalid name → throws before any siteio call', async () => {
    const deps = makeDeps();
    await expect(
      runTeleport({ name: 'MCP_INVALID' }, deps)
    ).rejects.toThrow(/Invalid app name/);
    expect(deps.calls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* normalizeGitUrl                                                     */
/* ------------------------------------------------------------------ */

describe('normalizeGitUrl', () => {
  test('SSH → HTTPS (github)', () => {
    expect(normalizeGitUrl('git@github.com:plosson/agentio.git')).toBe(
      'https://github.com/plosson/agentio.git'
    );
  });

  test('SSH without .git suffix still emits .git', () => {
    expect(normalizeGitUrl('git@github.com:plosson/agentio')).toBe(
      'https://github.com/plosson/agentio.git'
    );
  });

  test('SSH with multi-level path (gitlab-style)', () => {
    expect(
      normalizeGitUrl('git@gitlab.example.com:group/sub/repo.git')
    ).toBe('https://gitlab.example.com/group/sub/repo.git');
  });

  test('HTTPS URL passes through unchanged', () => {
    expect(
      normalizeGitUrl('https://github.com/plosson/agentio.git')
    ).toBe('https://github.com/plosson/agentio.git');
  });

  test('HTTP URL passes through unchanged', () => {
    expect(normalizeGitUrl('http://gitea.local/x/y.git')).toBe(
      'http://gitea.local/x/y.git'
    );
  });

  test('trims surrounding whitespace', () => {
    expect(
      normalizeGitUrl('  git@github.com:plosson/agentio.git\n')
    ).toBe('https://github.com/plosson/agentio.git');
  });

  test('unknown shape passes through unchanged (siteio will error)', () => {
    expect(normalizeGitUrl('not-a-url')).toBe('not-a-url');
  });
});

/* ------------------------------------------------------------------ */
/* runTeleport — git mode                                              */
/* ------------------------------------------------------------------ */

describe('runTeleport — git mode', () => {
  test('happy path: calls createApp with git args, never writes a temp file', async () => {
    const deps = makeDeps({
      gitOriginUrl: 'https://github.com/plosson/agentio.git',
    });
    const result = await runTeleport(
      {
        name: 'mcp',
        gitBranch: 'http-mcp-server-phase-1',
      },
      deps
    );

    expect(result.url).toBe('https://mcp.siteio.example.com');
    expect(result.serverApiKey).toMatch(/^srv_/);

    const createCall = deps.calls.find((c) => c.method === 'createApp');
    expect(createCall).toBeDefined();
    const args = createCall!.args as {
      name: string;
      port: number;
      dockerfilePath?: string;
      git?: { repoUrl: string; branch: string; dockerfilePath: string };
    };
    expect(args.name).toBe('mcp');
    expect(args.port).toBe(9999);
    expect(args.dockerfilePath).toBeUndefined();
    expect(args.git).toBeDefined();
    expect(args.git!.repoUrl).toBe(
      'https://github.com/plosson/agentio.git'
    );
    expect(args.git!.branch).toBe('http-mcp-server-phase-1');
    expect(args.git!.dockerfilePath).toBe(TELEPORT_DOCKERFILE_PATH);

    // No temp file written OR deleted.
    expect(deps.tempFileWrites).toHaveLength(0);
    expect(deps.tempFileDeletes).toHaveLength(0);
  });

  test('SSH origin URL is auto-normalized to HTTPS', async () => {
    const deps = makeDeps({
      gitOriginUrl: 'git@github.com:plosson/agentio.git',
    });
    await runTeleport(
      { name: 'mcp', gitBranch: 'main' },
      deps
    );
    const createCall = deps.calls.find((c) => c.method === 'createApp');
    const args = createCall!.args as {
      git?: { repoUrl: string };
    };
    expect(args.git!.repoUrl).toBe(
      'https://github.com/plosson/agentio.git'
    );
  });

  test('--git-url overrides detection', async () => {
    const deps = makeDeps({
      gitOriginUrl: 'https://github.com/plosson/agentio.git',
    });
    await runTeleport(
      {
        name: 'mcp',
        gitBranch: 'main',
        gitUrl: 'https://gitea.example.com/owner/fork.git',
      },
      deps
    );
    const createCall = deps.calls.find((c) => c.method === 'createApp');
    const args = createCall!.args as { git?: { repoUrl: string } };
    expect(args.git!.repoUrl).toBe(
      'https://gitea.example.com/owner/fork.git'
    );
  });

  test('--git-url SSH value is normalized to HTTPS', async () => {
    const deps = makeDeps();
    await runTeleport(
      {
        name: 'mcp',
        gitBranch: 'main',
        gitUrl: 'git@gitea.example.com:owner/fork.git',
      },
      deps
    );
    const createCall = deps.calls.find((c) => c.method === 'createApp');
    const args = createCall!.args as { git?: { repoUrl: string } };
    expect(args.git!.repoUrl).toBe(
      'https://gitea.example.com/owner/fork.git'
    );
  });

  test('no detectable origin and no --git-url → CliError, zero siteio calls past preflight', async () => {
    const deps = makeDeps({ gitOriginUrl: null });
    await expect(
      runTeleport({ name: 'mcp', gitBranch: 'main' }, deps)
    ).rejects.toThrow(/Could not detect git origin URL/);
    // Preflight ran (isInstalled/isLoggedIn/findApp) but create should
    // NOT have been attempted.
    const methods = deps.calls.map((c) => c.method);
    expect(methods).not.toContain('createApp');
  });

  test('deploy is called WITHOUT dockerfilePath in git mode', async () => {
    const deps = makeDeps({
      gitOriginUrl: 'https://github.com/x/y.git',
    });
    await runTeleport(
      { name: 'mcp', gitBranch: 'main' },
      deps
    );
    const deployCall = deps.calls.find((c) => c.method === 'deploy');
    const args = deployCall!.args as {
      name: string;
      dockerfilePath?: string;
    };
    expect(args.name).toBe('mcp');
    expect(args.dockerfilePath).toBeUndefined();
  });

  test('--no-cache still propagates in git mode', async () => {
    const deps = makeDeps({
      gitOriginUrl: 'https://github.com/x/y.git',
    });
    await runTeleport(
      { name: 'mcp', gitBranch: 'main', noCache: true },
      deps
    );
    const deployCall = deps.calls.find((c) => c.method === 'deploy');
    const args = deployCall!.args as { noCache?: boolean };
    expect(args.noCache).toBe(true);
  });

  test('startup log announces git mode with resolved URL + branch', async () => {
    const deps = makeDeps({
      gitOriginUrl: 'git@github.com:plosson/agentio.git',
    });
    await runTeleport(
      { name: 'mcp', gitBranch: 'feat-x' },
      deps
    );
    const joined = deps.logLines.join('\n');
    expect(joined).toContain('Git mode');
    expect(joined).toContain('https://github.com/plosson/agentio.git');
    expect(joined).toContain('feat-x');
  });

  test('dry-run in git mode shows siteio create -g command, no Dockerfile body', async () => {
    const deps = makeDeps({
      gitOriginUrl: 'https://github.com/plosson/agentio.git',
      dockerfile: '# should not appear in git-mode dry-run\n',
    });
    await runTeleport(
      { name: 'mcp', gitBranch: 'main', dryRun: true },
      deps
    );
    const joined = deps.logLines.join('\n');
    expect(joined).toContain('siteio apps create mcp -g');
    expect(joined).toContain('--branch main');
    expect(joined).toContain(`--dockerfile ${TELEPORT_DOCKERFILE_PATH}`);
    // Must NOT dump the inline Dockerfile body — it's not relevant.
    expect(joined).not.toContain('should not appear in git-mode dry-run');
    // Must not hit siteio for real.
    const methods = deps.calls.map((c) => c.method);
    expect(methods).not.toContain('createApp');
    expect(methods).not.toContain('deploy');
  });

  test('failed createApp in git mode: no temp file cleanup needed', async () => {
    const deps = makeDeps({
      gitOriginUrl: 'https://github.com/x/y.git',
      failOn: 'createApp',
    });
    await expect(
      runTeleport({ name: 'mcp', gitBranch: 'main' }, deps)
    ).rejects.toThrow();
    expect(deps.tempFileWrites).toHaveLength(0);
    expect(deps.tempFileDeletes).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* runTeleport — sync mode                                             */
/* ------------------------------------------------------------------ */

describe('runTeleport — sync mode (--sync)', () => {
  test('happy path: preflight → findApp → appInfo → setApp → restartApp', async () => {
    const deps = makeDeps({
      existingApp: { name: 'mcp' },
      deployedApp: {
        name: 'mcp',
        url: 'https://mcp.x.com',
        // Existing /data volume — no backfill needed.
        volumes: [{ name: 'agentio-data-mcp', mountPath: '/data' }],
      },
    });
    const result = await runTeleport(
      { name: 'mcp', sync: true },
      deps
    );

    const methods = deps.calls.map((c) => c.method);
    expect(methods).toEqual([
      'isInstalled',
      'isLoggedIn',
      'findApp',
      'appInfo',
      'setApp',
      'restartApp',
    ]);
    expect(result.url).toBe('https://mcp.x.com');
  });

  test('refuses to sync against a non-existent app', async () => {
    const deps = makeDeps({ existingApp: null });
    await expect(
      runTeleport({ name: 'mcp', sync: true }, deps)
    ).rejects.toThrow(/No siteio app named "mcp" to sync to/);
    // Did not attempt to set env or restart.
    const methods = deps.calls.map((c) => c.method);
    expect(methods).not.toContain('setApp');
    expect(methods).not.toContain('restartApp');
  });

  test('setApp passes ONLY AGENTIO_KEY + AGENTIO_CONFIG (NOT AGENTIO_SERVER_API_KEY)', async () => {
    const deps = makeDeps({
      existingApp: { name: 'mcp' },
      exportKey: 'rotated_key',
      exportConfig: 'rotated_config==',
    });
    await runTeleport({ name: 'mcp', sync: true }, deps);
    const setCall = deps.calls.find((c) => c.method === 'setApp');
    const args = setCall!.args as {
      name: string;
      envVars: Record<string, string>;
    };
    expect(Object.keys(args.envVars).sort()).toEqual([
      'AGENTIO_CONFIG',
      'AGENTIO_KEY',
    ]);
    expect(args.envVars.AGENTIO_KEY).toBe('rotated_key');
    expect(args.envVars.AGENTIO_CONFIG).toBe('rotated_config==');
    expect(args.envVars.AGENTIO_SERVER_API_KEY).toBeUndefined();
  });

  test('restartApp is called with the app name', async () => {
    const deps = makeDeps({ existingApp: { name: 'mcp' } });
    await runTeleport({ name: 'mcp', sync: true }, deps);
    const restartCall = deps.calls.find((c) => c.method === 'restartApp');
    expect(restartCall).toBeDefined();
    expect(restartCall!.args).toEqual({ name: 'mcp' });
  });

  test('does NOT generate a Dockerfile or write a temp file', async () => {
    const deps = makeDeps({ existingApp: { name: 'mcp' } });
    await runTeleport({ name: 'mcp', sync: true }, deps);
    expect(deps.tempFileWrites).toHaveLength(0);
    expect(deps.tempFileDeletes).toHaveLength(0);
  });

  test('does NOT call createApp or deploy', async () => {
    const deps = makeDeps({ existingApp: { name: 'mcp' } });
    await runTeleport({ name: 'mcp', sync: true }, deps);
    const methods = deps.calls.map((c) => c.method);
    expect(methods).not.toContain('createApp');
    expect(methods).not.toContain('deploy');
  });

  test('output for backfill case mentions one-time bearer invalidation', async () => {
    const deps = makeDeps({
      existingApp: { name: 'mcp' },
      // No volumes on the deployedApp → backfill triggers.
      deployedApp: { name: 'mcp', url: 'https://mcp.x.com', volumes: [] },
    });
    await runTeleport({ name: 'mcp', sync: true }, deps);
    const joined = deps.logLines.join('\n');
    expect(joined).toContain('Sync complete');
    expect(joined).toContain('volume backfill');
    expect(joined.toLowerCase()).toContain('re-paste');
    expect(joined).toContain('persist');
  });

  test('output for already-mounted case promises bearer survival', async () => {
    const deps = makeDeps({
      existingApp: { name: 'mcp' },
      deployedApp: {
        name: 'mcp',
        url: 'https://mcp.x.com',
        volumes: [{ name: 'agentio-data-mcp', mountPath: '/data' }],
      },
    });
    await runTeleport({ name: 'mcp', sync: true }, deps);
    const joined = deps.logLines.join('\n');
    expect(joined).toContain('Sync complete');
    expect(joined).toContain('persistent volume');
    expect(joined).toContain('keep their existing bearer');
  });

  test('preserves the same operator API key (no fresh generation in sync)', async () => {
    const deps = makeDeps({
      existingApp: { name: 'mcp' },
      fixedServerApiKey: 'srv_should_not_appear',
    });
    const result = await runTeleport(
      { name: 'mcp', sync: true },
      deps
    );
    // Sync result has no serverApiKey since we didn't generate one.
    expect(result.serverApiKey).toBe('');
  });
});

/* ------------------------------------------------------------------ */
/* runTeleport — sync mode dry-run                                     */
/* ------------------------------------------------------------------ */

describe('runTeleport — sync dry-run', () => {
  test('shows the apps set + apps restart commands without executing', async () => {
    const deps = makeDeps({
      existingApp: { name: 'mcp' },
      exportConfig: 'X'.repeat(1000),
    });
    await runTeleport(
      { name: 'mcp', sync: true, dryRun: true },
      deps
    );
    const joined = deps.logLines.join('\n');
    expect(joined).toContain('siteio apps set mcp');
    expect(joined).toContain('siteio apps restart mcp');
    expect(joined).toContain('AGENTIO_KEY=<redacted>');
    expect(joined).toContain('AGENTIO_CONFIG=<1000 chars>');
    // Did NOT actually call setApp / restartApp.
    const methods = deps.calls.map((c) => c.method);
    expect(methods).not.toContain('setApp');
    expect(methods).not.toContain('restartApp');
  });

  test('preflight + findApp still run in dry-run', async () => {
    const deps = makeDeps({ existingApp: { name: 'mcp' } });
    await runTeleport(
      { name: 'mcp', sync: true, dryRun: true },
      deps
    );
    const methods = deps.calls.map((c) => c.method);
    expect(methods).toContain('isInstalled');
    expect(methods).toContain('isLoggedIn');
    expect(methods).toContain('findApp');
  });

  test('dry-run still bails if app does not exist', async () => {
    const deps = makeDeps({ existingApp: null });
    await expect(
      runTeleport({ name: 'mcp', sync: true, dryRun: true }, deps)
    ).rejects.toThrow(/No siteio app named/);
  });
});

/* ------------------------------------------------------------------ */
/* runTeleport — sync mutual exclusion                                 */
/* ------------------------------------------------------------------ */

describe('runTeleport — --sync mutual exclusion', () => {
  test('--sync + --dockerfile-only → CliError', async () => {
    const deps = makeDeps({ existingApp: { name: 'mcp' } });
    await expect(
      runTeleport(
        { name: 'mcp', sync: true, dockerfileOnly: true },
        deps
      )
    ).rejects.toThrow(/--sync cannot be combined with --dockerfile-only/);
    // Did not even hit preflight.
    expect(deps.calls).toHaveLength(0);
  });

  test('--sync + --git-branch → CliError', async () => {
    const deps = makeDeps({ existingApp: { name: 'mcp' } });
    await expect(
      runTeleport(
        { name: 'mcp', sync: true, gitBranch: 'main' },
        deps
      )
    ).rejects.toThrow(/--sync cannot be combined with --git-branch/);
  });

  test('--sync + --no-cache → CliError', async () => {
    const deps = makeDeps({ existingApp: { name: 'mcp' } });
    await expect(
      runTeleport({ name: 'mcp', sync: true, noCache: true }, deps)
    ).rejects.toThrow(/--sync cannot be combined with --no-cache/);
  });

  test('--sync + --output → CliError', async () => {
    const deps = makeDeps({ existingApp: { name: 'mcp' } });
    await expect(
      runTeleport(
        { name: 'mcp', sync: true, output: '/tmp/x' },
        deps
      )
    ).rejects.toThrow(/--sync cannot be combined with --output/);
  });
});

/* ------------------------------------------------------------------ */
/* volume helpers                                                     */
/* ------------------------------------------------------------------ */

describe('volumeNameFor', () => {
  test('namespaces by app name', () => {
    expect(volumeNameFor('mcp')).toBe('agentio-data-mcp');
    expect(volumeNameFor('mcp-prod')).toBe('agentio-data-mcp-prod');
  });
});

describe('hasDataVolumeMount', () => {
  test('null / non-object → false', () => {
    expect(hasDataVolumeMount(null)).toBe(false);
    expect(hasDataVolumeMount(undefined)).toBe(false);
    expect(hasDataVolumeMount('string')).toBe(false);
  });

  test('no volumes field → false', () => {
    expect(hasDataVolumeMount({ name: 'x' })).toBe(false);
  });

  test('empty volumes array → false', () => {
    expect(hasDataVolumeMount({ volumes: [] })).toBe(false);
  });

  test('object form with mountPath /data → true', () => {
    expect(
      hasDataVolumeMount({
        volumes: [{ name: 'agentio-data-mcp', mountPath: '/data' }],
      })
    ).toBe(true);
  });

  test('object form with path /data → true (alternate field name)', () => {
    expect(
      hasDataVolumeMount({
        volumes: [{ name: 'agentio-data-mcp', path: '/data' }],
      })
    ).toBe(true);
  });

  test('object form with /other mount → false', () => {
    expect(
      hasDataVolumeMount({
        volumes: [{ name: 'cache', mountPath: '/cache' }],
      })
    ).toBe(false);
  });

  test('string form name:/data → true', () => {
    expect(
      hasDataVolumeMount({ volumes: ['agentio-data-mcp:/data'] })
    ).toBe(true);
  });

  test('mixed array with at least one /data → true', () => {
    expect(
      hasDataVolumeMount({
        volumes: [
          { name: 'cache', mountPath: '/cache' },
          { name: 'data', mountPath: '/data' },
        ],
      })
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* persistent volume on initial teleport (inline + git mode)           */
/* ------------------------------------------------------------------ */

describe('runTeleport — initial deploy attaches persistent volume', () => {
  test('inline mode: setApp call includes volume agentio-data-<name>:/data', async () => {
    const deps = makeDeps();
    await runTeleport({ name: 'mcp' }, deps);
    const setCall = deps.calls.find((c) => c.method === 'setApp');
    const args = setCall!.args as {
      envVars?: Record<string, string>;
      volumes?: Record<string, string>;
    };
    expect(args.volumes).toBeDefined();
    expect(args.volumes!['agentio-data-mcp']).toBe(DATA_VOLUME_PATH);
  });

  test('git mode: setApp call includes the volume too', async () => {
    const deps = makeDeps({
      gitOriginUrl: 'https://github.com/x/y.git',
    });
    await runTeleport(
      { name: 'mcp', gitBranch: 'main' },
      deps
    );
    const setCall = deps.calls.find((c) => c.method === 'setApp');
    const args = setCall!.args as { volumes?: Record<string, string> };
    expect(args.volumes!['agentio-data-mcp']).toBe(DATA_VOLUME_PATH);
  });

  test('volume name follows the per-app convention', async () => {
    const deps = makeDeps();
    await runTeleport({ name: 'my-prod-deploy' }, deps);
    const setCall = deps.calls.find((c) => c.method === 'setApp');
    const args = setCall!.args as { volumes?: Record<string, string> };
    expect(Object.keys(args.volumes!)).toEqual(['agentio-data-my-prod-deploy']);
  });
});

/* ------------------------------------------------------------------ */
/* sync backfills the volume only when missing                         */
/* ------------------------------------------------------------------ */

describe('runTeleport — sync volume backfill', () => {
  test('app already has /data mount → setApp omits volumes', async () => {
    const deps = makeDeps({
      existingApp: { name: 'mcp' },
      deployedApp: {
        name: 'mcp',
        url: 'https://mcp.x.com',
        volumes: [{ name: 'agentio-data-mcp', mountPath: '/data' }],
      },
    });
    await runTeleport({ name: 'mcp', sync: true }, deps);
    const setCall = deps.calls.find((c) => c.method === 'setApp');
    const args = setCall!.args as {
      envVars?: Record<string, string>;
      volumes?: Record<string, string>;
    };
    expect(args.volumes).toBeUndefined();
    expect(args.envVars).toBeDefined();
  });

  test('app has NO /data mount → setApp includes volumes (backfill)', async () => {
    const deps = makeDeps({
      existingApp: { name: 'mcp' },
      deployedApp: { name: 'mcp', url: 'https://mcp.x.com', volumes: [] },
    });
    await runTeleport({ name: 'mcp', sync: true }, deps);
    const setCall = deps.calls.find((c) => c.method === 'setApp');
    const args = setCall!.args as { volumes?: Record<string, string> };
    expect(args.volumes!['agentio-data-mcp']).toBe(DATA_VOLUME_PATH);
  });

  test('app has /other mount but no /data → setApp includes /data volume', async () => {
    const deps = makeDeps({
      existingApp: { name: 'mcp' },
      deployedApp: {
        name: 'mcp',
        url: 'https://mcp.x.com',
        volumes: [{ name: 'something-else', mountPath: '/cache' }],
      },
    });
    await runTeleport({ name: 'mcp', sync: true }, deps);
    const setCall = deps.calls.find((c) => c.method === 'setApp');
    const args = setCall!.args as { volumes?: Record<string, string> };
    expect(args.volumes!['agentio-data-mcp']).toBe(DATA_VOLUME_PATH);
  });

  test('appInfo returns null → treated as needs-backfill (defensive)', async () => {
    const deps = makeDeps({
      existingApp: { name: 'mcp' },
      deployedApp: null,
    });
    await runTeleport({ name: 'mcp', sync: true }, deps);
    const setCall = deps.calls.find((c) => c.method === 'setApp');
    const args = setCall!.args as { volumes?: Record<string, string> };
    expect(args.volumes!['agentio-data-mcp']).toBe(DATA_VOLUME_PATH);
  });

  test('dry-run shows the -v flag when backfill is needed', async () => {
    const deps = makeDeps({
      existingApp: { name: 'mcp' },
      deployedApp: { name: 'mcp', volumes: [] },
    });
    await runTeleport(
      { name: 'mcp', sync: true, dryRun: true },
      deps
    );
    const joined = deps.logLines.join('\n');
    expect(joined).toContain('-v agentio-data-mcp:/data');
  });

  test('dry-run does NOT show -v when volume already present', async () => {
    const deps = makeDeps({
      existingApp: { name: 'mcp' },
      deployedApp: {
        name: 'mcp',
        volumes: [{ name: 'agentio-data-mcp', mountPath: '/data' }],
      },
    });
    await runTeleport(
      { name: 'mcp', sync: true, dryRun: true },
      deps
    );
    const joined = deps.logLines.join('\n');
    expect(joined).not.toContain('-v agentio-data-mcp');
  });
});

/* ------------------------------------------------------------------ */
/* runTeleport — sync failure cleanup                                  */
/* ------------------------------------------------------------------ */

describe('runTeleport — sync failure paths', () => {
  test('setApp fails → restartApp NOT called', async () => {
    const deps = makeDeps({
      existingApp: { name: 'mcp' },
      failOn: 'setApp',
    });
    await expect(
      runTeleport({ name: 'mcp', sync: true }, deps)
    ).rejects.toThrow();
    const methods = deps.calls.map((c) => c.method);
    expect(methods).not.toContain('restartApp');
  });

  test('restartApp fails → error propagates', async () => {
    const deps = makeDeps({
      existingApp: { name: 'mcp' },
      failOn: 'restartApp',
    });
    await expect(
      runTeleport({ name: 'mcp', sync: true }, deps)
    ).rejects.toThrow(/restart failed/);
    // setApp ran (we got past it before restartApp blew up).
    const methods = deps.calls.map((c) => c.method);
    expect(methods).toContain('setApp');
  });
});

/* ------------------------------------------------------------------ */
/* waitForHealth (direct)                                             */
/* ------------------------------------------------------------------ */

describe('waitForHealth', () => {
  test('returns true on first 200 without sleeping', async () => {
    const { waitForHealth } = await import('./teleport');
    const probed: string[] = [];
    const sleeps: number[] = [];
    const logs: string[] = [];
    const ok = await waitForHealth(
      'https://mcp.example.com',
      {
        probeHealth: async (u) => {
          probed.push(u);
          return 200;
        },
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        log: (m) => logs.push(m),
      },
      { timeoutMs: 1000, intervalMs: 100 }
    );
    expect(ok).toBe(true);
    expect(probed).toEqual(['https://mcp.example.com/health']);
    expect(sleeps).toEqual([]); // no sleep after a first-attempt success
    expect(logs.join('\n')).toMatch(/responded 200 after 1 attempt/);
  });

  test('returns true when 200 arrives after a few not-ready probes', async () => {
    const { waitForHealth } = await import('./teleport');
    const sequence: Array<number | null> = [null, 503, null, 200];
    let idx = 0;
    const sleeps: number[] = [];
    const ok = await waitForHealth(
      'https://mcp.example.com/',
      {
        probeHealth: async () => sequence[idx++] ?? null,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        log: () => {},
      },
      { timeoutMs: 10_000, intervalMs: 100 }
    );
    expect(ok).toBe(true);
    expect(sleeps).toEqual([100, 100, 100]); // 3 sleeps before the 4th probe hit 200
  });

  test('returns false when probe never hits 200 within the budget', async () => {
    const { waitForHealth } = await import('./teleport');
    let probeCount = 0;
    const sleeps: number[] = [];
    const ok = await waitForHealth(
      'https://mcp.example.com',
      {
        probeHealth: async () => {
          probeCount++;
          return null;
        },
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        log: () => {},
      },
      { timeoutMs: 500, intervalMs: 100 }
    );
    expect(ok).toBe(false);
    // timeout/interval = 5 attempts, 4 sleeps between them.
    expect(probeCount).toBe(5);
    expect(sleeps.length).toBe(4);
  });

  test('strips trailing slash(es) from url before appending /health', async () => {
    const { waitForHealth } = await import('./teleport');
    const probed: string[] = [];
    await waitForHealth(
      'https://mcp.example.com///',
      {
        probeHealth: async (u) => {
          probed.push(u);
          return 200;
        },
        sleep: async () => {},
        log: () => {},
      },
      { timeoutMs: 1000, intervalMs: 100 }
    );
    expect(probed[0]).toBe('https://mcp.example.com/health');
  });
});

/* ------------------------------------------------------------------ */
/* runTeleport — health-check surfacing                               */
/* ------------------------------------------------------------------ */

describe('runTeleport — health check on deploy', () => {
  test('happy path probes /health at the deployed URL and does not fetch logs', async () => {
    const deps = makeDeps();
    await runTeleport({ name: 'mcp' }, deps);
    expect(deps.healthProbeUrls[0]).toBe('https://mcp.siteio.example.com/health');
    expect(deps.calls.map((c) => c.method)).not.toContain('logsApp');
  });

  test('health never returns 200 → fetches logs, surfaces them via warn, throws CliError', async () => {
    const deps = makeDeps({
      healthProbeResponses: [], // always null → timeout path
      logsStdout: 'Error: EACCES: permission denied, mkdir /data/.config\n',
    });
    await expect(runTeleport({ name: 'mcp' }, deps)).rejects.toThrow(
      /\/health never returned 200/
    );
    // logs were fetched with the expected tail size
    const logsCall = deps.calls.find((c) => c.method === 'logsApp');
    expect(logsCall).toBeDefined();
    expect((logsCall!.args as { opts: { tail: number } }).opts.tail).toBeGreaterThan(0);
    // The log tail was surfaced to the user on stderr (deps.warn)
    expect(deps.warnLines.join('\n')).toContain('EACCES: permission denied');
  });

  test('empty log stdout still produces a clear warning (no "undefined" output)', async () => {
    const deps = makeDeps({
      healthProbeResponses: [],
      logsStdout: '',
    });
    await expect(runTeleport({ name: 'mcp' }, deps)).rejects.toThrow();
    expect(deps.warnLines.join('\n')).toContain('(no logs returned by siteio)');
  });

  test('siteio did not return a URL → health check is skipped with a warning, no throw', async () => {
    const deps = makeDeps({ deployedApp: { name: 'mcp' } }); // no url field
    const result = await runTeleport({ name: 'mcp' }, deps);
    expect(result.url).toBeUndefined();
    expect(deps.healthProbeUrls).toEqual([]);
    expect(deps.warnLines.join('\n')).toContain('Skipping health check');
  });

  test('appInfo lacks url but findApp has it → falls back, still runs health check', async () => {
    // Mirrors real siteio behavior: `apps info --json` omits the
    // generated subdomain URL even though `apps list --json` surfaces
    // it. We fall back to findApp (which wraps `apps list`) so the
    // health check can still run.
    const deps = makeDeps({
      deployedApp: { name: 'mcp' }, // info: no url
      // existingApp is read by findApp on re-call — setting it supplies
      // the fallback URL.
      existingApp: { name: 'mcp', url: 'https://mcp.siteio.example.com' },
    });
    // But runTeleport's "create" path REFUSES if existingApp is found,
    // so we need to bypass that. Trick: set existingApp to null at call
    // time; we can't really do that here without extending the fixture.
    // Instead, emulate via a custom runner.
    let findAppCalls = 0;
    const deployInfo: SiteioApp = { name: 'mcp' }; // info returns no url
    const fallbackInfo: SiteioApp = {
      name: 'mcp',
      url: 'https://mcp.siteio.example.com',
    };
    deps.runner.findApp = async () => {
      findAppCalls++;
      // First call (preflight — "does app already exist?") must return null
      // so runTeleport proceeds with create. Second call (post-deploy URL
      // fallback) returns the populated URL.
      return findAppCalls === 1 ? null : fallbackInfo;
    };
    deps.runner.appInfo = async () => deployInfo;
    await runTeleport({ name: 'mcp' }, deps);
    expect(findAppCalls).toBe(2);
    expect(deps.healthProbeUrls[0]).toBe('https://mcp.siteio.example.com/health');
  });
});

describe('runTeleport — health check on --sync', () => {
  test('sync happy path probes /health after restart', async () => {
    const deps = makeDeps({
      existingApp: { name: 'mcp', url: 'https://mcp.siteio.example.com' },
      deployedApp: {
        name: 'mcp',
        url: 'https://mcp.siteio.example.com',
        volumes: [`agentio-data-mcp:${DATA_VOLUME_PATH}`],
      },
    });
    await runTeleport({ name: 'mcp', sync: true }, deps);
    expect(deps.healthProbeUrls[0]).toBe('https://mcp.siteio.example.com/health');
    // No log fetch on a happy sync.
    expect(deps.calls.map((c) => c.method)).not.toContain('logsApp');
  });

  test('sync health times out → logs fetched + thrown', async () => {
    const deps = makeDeps({
      existingApp: { name: 'mcp', url: 'https://mcp.siteio.example.com' },
      deployedApp: {
        name: 'mcp',
        url: 'https://mcp.siteio.example.com',
        volumes: [`agentio-data-mcp:${DATA_VOLUME_PATH}`],
      },
      healthProbeResponses: [],
      logsStdout: 'boom\n',
    });
    await expect(
      runTeleport({ name: 'mcp', sync: true }, deps)
    ).rejects.toThrow(/\/health never returned 200/);
    expect(deps.calls.map((c) => c.method)).toContain('logsApp');
    expect(deps.warnLines.join('\n')).toContain('boom');
  });
});
