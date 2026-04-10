/**
 * Thin wrapper around the `siteio` CLI for `agentio teleport`. Every
 * siteio command we need to invoke goes through this module, which
 * delegates to an injected `spawn` function. Tests inject a mock; the
 * production wiring injects a tiny adapter over `Bun.spawn`.
 *
 * Why the indirection: `siteio` is an external dependency I can't run
 * in CI, and I don't want the teleport command tests to require a real
 * `siteio` binary on PATH. The runner captures the exact argv + env
 * that would be invoked, the mock returns stubbed output, and the
 * test asserts the argv lines up with the intended workflow.
 */

export interface SpawnedProcess {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SpawnOptions {
  /** Full argv, including the binary name at argv[0]. */
  cmd: string[];
  /** Optional extra env vars (merged over process.env inside the adapter). */
  env?: Record<string, string>;
}

export type SpawnFn = (opts: SpawnOptions) => Promise<SpawnedProcess>;

/**
 * Default production `spawn` implementation that shells out to Bun.spawn.
 * Tests pass their own mock instead.
 */
export const defaultSpawn: SpawnFn = async (opts) => {
  const proc = Bun.spawn(opts.cmd, {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

/* ------------------------------------------------------------------ */
/* SiteioRunner                                                        */
/* ------------------------------------------------------------------ */

export interface SiteioApp {
  name: string;
  /** URL the app is (or will be) deployed at. Present when siteio has
   *  assigned a subdomain. */
  url?: string;
  /** Free-form additional fields from siteio's JSON output — we pass
   *  them through without interpretation. */
  [key: string]: unknown;
}

export interface SiteioRunner {
  /** `siteio --version` → true on exit 0, false on any error. */
  isInstalled(): Promise<boolean>;
  /** `siteio status` → true on exit 0 (i.e. currently logged in). */
  isLoggedIn(): Promise<boolean>;
  /** `siteio apps list --json`, filtered to the named app. */
  findApp(name: string): Promise<SiteioApp | null>;
  /** `siteio apps create <name> -f <dockerfile> -p <port>`. */
  createApp(args: {
    name: string;
    dockerfilePath: string;
    port: number;
  }): Promise<void>;
  /** `siteio apps set <name> -e KEY=value -e KEY2=value2 ...`. */
  setEnv(args: { name: string; envVars: Record<string, string> }): Promise<void>;
  /** `siteio apps deploy <name> [-f <path>] [--no-cache]`. */
  deploy(args: {
    name: string;
    dockerfilePath?: string;
    noCache?: boolean;
  }): Promise<void>;
  /** `siteio apps info <name> --json` — used to surface the deployed URL. */
  appInfo(name: string): Promise<SiteioApp | null>;
}

export interface SiteioRunnerError extends Error {
  command: string[];
  exitCode: number;
  stderr: string;
}

function makeError(
  cmd: string[],
  result: SpawnedProcess,
  context: string
): SiteioRunnerError {
  const err = new Error(
    `siteio ${cmd.slice(1).join(' ')} failed (${context}): exit ${result.exitCode}\n${result.stderr.trim()}`
  ) as SiteioRunnerError;
  err.command = cmd;
  err.exitCode = result.exitCode;
  err.stderr = result.stderr;
  return err;
}

export function createSiteioRunner(
  spawn: SpawnFn = defaultSpawn
): SiteioRunner {
  return {
    async isInstalled() {
      try {
        const r = await spawn({ cmd: ['siteio', '--version'] });
        return r.exitCode === 0;
      } catch {
        return false;
      }
    },

    async isLoggedIn() {
      try {
        const r = await spawn({ cmd: ['siteio', 'status'] });
        return r.exitCode === 0;
      } catch {
        return false;
      }
    },

    async findApp(name) {
      const cmd = ['siteio', 'apps', 'list', '--json'];
      const r = await spawn({ cmd });
      if (r.exitCode !== 0) {
        throw makeError(cmd, r, 'list apps');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.stdout);
      } catch {
        throw new Error(
          `siteio apps list --json returned unparseable output:\n${r.stdout}`
        );
      }
      if (!Array.isArray(parsed)) {
        // Some versions of siteio may wrap the list in { apps: [...] }.
        // Be permissive and try both shapes.
        if (
          parsed &&
          typeof parsed === 'object' &&
          Array.isArray((parsed as { apps?: unknown }).apps)
        ) {
          parsed = (parsed as { apps: unknown[] }).apps;
        } else {
          throw new Error(
            `siteio apps list --json: expected an array, got:\n${r.stdout}`
          );
        }
      }
      const apps = parsed as SiteioApp[];
      const match = apps.find((a) => a && typeof a === 'object' && a.name === name);
      return match ?? null;
    },

    async createApp(args) {
      const cmd = [
        'siteio',
        'apps',
        'create',
        args.name,
        '-f',
        args.dockerfilePath,
        '-p',
        String(args.port),
      ];
      const r = await spawn({ cmd });
      if (r.exitCode !== 0) {
        throw makeError(cmd, r, `create ${args.name}`);
      }
    },

    async setEnv(args) {
      const cmd = ['siteio', 'apps', 'set', args.name];
      for (const [key, value] of Object.entries(args.envVars)) {
        cmd.push('-e', `${key}=${value}`);
      }
      const r = await spawn({ cmd });
      if (r.exitCode !== 0) {
        throw makeError(cmd, r, `set env on ${args.name}`);
      }
    },

    async deploy(args) {
      const cmd = ['siteio', 'apps', 'deploy', args.name];
      if (args.dockerfilePath) {
        cmd.push('-f', args.dockerfilePath);
      }
      if (args.noCache) {
        cmd.push('--no-cache');
      }
      const r = await spawn({ cmd });
      if (r.exitCode !== 0) {
        throw makeError(cmd, r, `deploy ${args.name}`);
      }
    },

    async appInfo(name) {
      const cmd = ['siteio', 'apps', 'info', name, '--json'];
      const r = await spawn({ cmd });
      if (r.exitCode !== 0) {
        // app doesn't exist or siteio errored — caller can treat null
        // as "could not read info" rather than blow up the whole
        // teleport just because we couldn't get a URL to print.
        return null;
      }
      try {
        const parsed = JSON.parse(r.stdout);
        if (parsed && typeof parsed === 'object') {
          return parsed as SiteioApp;
        }
        return null;
      } catch {
        return null;
      }
    },
  };
}
