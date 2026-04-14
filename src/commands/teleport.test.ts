import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  generateServerApiKey,
  normalizeGitUrl,
  runTeleport,
  TELEPORT_DOCKERFILE_PATH,
  validateAppName,
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
  failOn?:
    | 'isInstalled'
    | 'isLoggedIn'
    | 'findApp'
    | 'createApp'
    | 'setEnv'
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
    async setEnv(args) {
      calls.push({ method: 'setEnv', args });
      if (shouldFail('setEnv')) throw new Error('set failed');
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
}

interface FakeDeps extends TeleportDeps {
  calls: RunnerCall[];
  log: (msg: string) => void;
  warn: (msg: string) => void;
  logLines: string[];
  warnLines: string[];
  tempFileWrites: { path: string; content: string }[];
  tempFileDeletes: string[];
}

function makeDeps(opts: FakeDepsOptions = {}): FakeDeps {
  const { runner, calls } = makeFakeRunner(opts);
  const logLines: string[] = [];
  const warnLines: string[] = [];
  const tempFileWrites: { path: string; content: string }[] = [];
  const tempFileDeletes: string[] = [];

  let tempCounter = 0;

  const deps: FakeDeps = {
    calls,
    logLines,
    warnLines,
    tempFileWrites,
    tempFileDeletes,
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
      'setEnv',
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

  test('setEnv is called with AGENTIO_KEY + AGENTIO_CONFIG + AGENTIO_SERVER_API_KEY', async () => {
    const deps = makeDeps({
      exportKey: 'key_value_from_export',
      exportConfig: 'config_blob_from_export==',
      fixedServerApiKey: 'srv_fixed_test_key',
    });
    await runTeleport({ name: 'mcp' }, deps);
    const setCall = deps.calls.find((c) => c.method === 'setEnv');
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

  test('app already exists → CliError + warning', async () => {
    const deps = makeDeps({
      existingApp: { name: 'mcp', url: 'https://mcp.existing.com' },
    });
    await expect(runTeleport({ name: 'mcp' }, deps)).rejects.toThrow(
      /already exists/
    );
    // A warning was emitted before the throw so the user has context.
    expect(deps.warnLines.some((l) => l.includes('siteio apps rm'))).toBe(
      true
    );
    // Must not have attempted to create/set/deploy.
    const methods = deps.calls.map((c) => c.method);
    expect(methods).not.toContain('createApp');
    expect(methods).not.toContain('deploy');
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

  test('deletes the temp file even when setEnv fails', async () => {
    const deps = makeDeps({ failOn: 'setEnv' });
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
    expect(methods).not.toContain('setEnv');
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
  test('happy path: preflight → findApp → setEnv → restartApp → appInfo', async () => {
    const deps = makeDeps({
      existingApp: { name: 'mcp' },
      deployedApp: { name: 'mcp', url: 'https://mcp.x.com' },
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
      'setEnv',
      'restartApp',
      'appInfo',
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
    expect(methods).not.toContain('setEnv');
    expect(methods).not.toContain('restartApp');
  });

  test('setEnv passes ONLY AGENTIO_KEY + AGENTIO_CONFIG (NOT AGENTIO_SERVER_API_KEY)', async () => {
    const deps = makeDeps({
      existingApp: { name: 'mcp' },
      exportKey: 'rotated_key',
      exportConfig: 'rotated_config==',
    });
    await runTeleport({ name: 'mcp', sync: true }, deps);
    const setCall = deps.calls.find((c) => c.method === 'setEnv');
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

  test('output mentions client re-auth caveat', async () => {
    const deps = makeDeps({ existingApp: { name: 'mcp' } });
    await runTeleport({ name: 'mcp', sync: true }, deps);
    const joined = deps.logLines.join('\n');
    expect(joined).toContain('Sync complete');
    expect(joined.toLowerCase()).toContain('re-run');
    expect(joined).toContain('OAuth');
    expect(joined).toContain('operator API key has NOT changed');
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
    // Did NOT actually call setEnv / restartApp.
    const methods = deps.calls.map((c) => c.method);
    expect(methods).not.toContain('setEnv');
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
/* runTeleport — sync failure cleanup                                  */
/* ------------------------------------------------------------------ */

describe('runTeleport — sync failure paths', () => {
  test('setEnv fails → restartApp NOT called', async () => {
    const deps = makeDeps({
      existingApp: { name: 'mcp' },
      failOn: 'setEnv',
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
    // setEnv ran (we got past it before restartApp blew up).
    const methods = deps.calls.map((c) => c.method);
    expect(methods).toContain('setEnv');
  });
});
