import { Command } from 'commander';
import { randomBytes } from 'crypto';
import { writeFile, unlink, mkdtemp } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

import { generateExportData } from './config';
import { loadConfig } from '../config/config-manager';
import { generateTeleportDockerfile } from '../server/dockerfile-gen';
import {
  createSiteioRunner,
  type SiteioRunner,
} from '../server/siteio-runner';
import { handleError, CliError } from '../utils/errors';
import type { Config } from '../types/config';

/**
 * `agentio teleport <name>` — one-command deploy of the local agentio
 * HTTP MCP server to a siteio-managed remote.
 *
 * Flow:
 *   1. Preflight: siteio installed, siteio logged in, at least one local
 *      profile configured.
 *   2. Refuse if an app with the same name already exists on siteio
 *      (warn + exit; user has to `siteio apps rm <name>` to reuse it).
 *   3. Generate a fresh AGENTIO_SERVER_API_KEY (we do NOT reuse the
 *      local one — each deployment is independent).
 *   4. Export the local profiles + credentials via `generateExportData()`
 *      (same encrypted blob `agentio config export --all` produces).
 *   5. Generate an inline Dockerfile via generateTeleportDockerfile().
 *   6. Write the Dockerfile to a temp file.
 *   7. `siteio apps create <name> -f <tempfile> -p 9999`
 *   8. `siteio apps set <name> -e AGENTIO_KEY=... -e AGENTIO_CONFIG=... -e AGENTIO_SERVER_API_KEY=...`
 *   9. `siteio apps deploy <name>`
 *   10. Print the deployed URL (from `siteio apps info`), the API key,
 *       and the `claude mcp add` command the user should run locally.
 *   11. Delete the temp Dockerfile in a finally (always).
 *
 * Dry-run and dockerfile-only modes skip parts of the flow for
 * inspection + offline development.
 */

/** Siteio app names must match this pattern. Mirrors Docker image name rules. */
const VALID_NAME = /^[a-z][a-z0-9-]{0,62}$/;

export function validateAppName(name: string): void {
  if (!VALID_NAME.test(name)) {
    throw new CliError(
      'INVALID_PARAMS',
      `Invalid app name "${name}"`,
      'Use lowercase letters, digits, and hyphens only (must start with a letter, max 63 chars).'
    );
  }
}

export function generateServerApiKey(): string {
  return `srv_${randomBytes(24).toString('base64url')}`;
}

/**
 * Dependency-injected internals so the command can be unit-tested
 * without touching disk, spawning siteio, or hitting the real config.
 */
export interface TeleportDeps {
  runner: SiteioRunner;
  loadConfig: () => Promise<Config>;
  generateExportData: () => Promise<{ key: string; config: string }>;
  generateServerApiKey: () => string;
  generateDockerfile: () => string;
  writeTempFile: (content: string) => Promise<string>;
  removeTempFile: (path: string) => Promise<void>;
  log: (msg: string) => void;
  warn: (msg: string) => void;
}

export interface TeleportOptions {
  name: string;
  dockerfileOnly?: boolean;
  output?: string;
  dryRun?: boolean;
  noCache?: boolean;
}

export interface TeleportResult {
  name: string;
  /** Deployed URL from siteio, if we could resolve it. */
  url?: string;
  serverApiKey: string;
  /** `claude mcp add ...` line to hand to the user. null if URL unknown. */
  claudeMcpAddCommand: string | null;
}

/**
 * Core orchestration. Pure function of its dependencies — used by both
 * the real command and the unit tests.
 */
export async function runTeleport(
  opts: TeleportOptions,
  deps: TeleportDeps
): Promise<TeleportResult> {
  validateAppName(opts.name);

  // dockerfile-only: skip every siteio interaction, just emit the
  // Dockerfile to stdout or a file and return.
  if (opts.dockerfileOnly) {
    const content = deps.generateDockerfile();
    if (opts.output) {
      const path = opts.output.startsWith('/')
        ? opts.output
        : `${process.cwd()}/${opts.output}`;
      await writeFile(path, content, { mode: 0o600 });
      deps.log(`Wrote Dockerfile to ${path}`);
    } else {
      // stdout directly — no log prefix, caller redirects as needed.
      process.stdout.write(content);
    }
    return {
      name: opts.name,
      serverApiKey: '',
      claudeMcpAddCommand: null,
    };
  }

  // Preflight.
  deps.log('Checking siteio…');
  if (!(await deps.runner.isInstalled())) {
    throw new CliError(
      'CONFIG_ERROR',
      'siteio is not installed or not on PATH',
      'Install siteio first: https://github.com/plosson/siteio'
    );
  }
  if (!(await deps.runner.isLoggedIn())) {
    throw new CliError(
      'AUTH_FAILED',
      'Not logged into siteio',
      'Run: siteio login --api-url <url> --api-key <key>'
    );
  }

  const config = await deps.loadConfig();
  const profileCount = Object.values(config.profiles ?? {}).reduce(
    (acc, list) => acc + (list?.length ?? 0),
    0
  );
  if (profileCount === 0) {
    throw new CliError(
      'NOT_FOUND',
      'No agentio profiles configured locally',
      'Add at least one profile first with `agentio <service> profile add`.'
    );
  }
  deps.log(`Found ${profileCount} local profile(s).`);

  // App must not already exist.
  deps.log(`Checking if siteio app "${opts.name}" already exists…`);
  const existing = await deps.runner.findApp(opts.name);
  if (existing) {
    deps.warn(
      `A siteio app named "${opts.name}" already exists. ` +
        `Run \`siteio apps rm ${opts.name}\` if you want to redeploy from scratch.`
    );
    throw new CliError(
      'INVALID_PARAMS',
      `App "${opts.name}" already exists on siteio`
    );
  }

  // Generate a fresh server API key for the remote.
  const serverApiKey = deps.generateServerApiKey();

  // Export the local config.
  deps.log('Exporting local configuration…');
  const exported = await deps.generateExportData();

  // Dry-run: report what would happen and exit.
  if (opts.dryRun) {
    const dockerfile = deps.generateDockerfile();
    deps.log('--- Dry run: the following commands would be executed ---');
    deps.log(
      `siteio apps create ${opts.name} -f <tempfile> -p 9999`
    );
    deps.log(
      `siteio apps set ${opts.name} -e AGENTIO_KEY=<redacted> -e AGENTIO_CONFIG=<${exported.config.length} chars> -e AGENTIO_SERVER_API_KEY=${serverApiKey}`
    );
    deps.log(
      `siteio apps deploy ${opts.name}${opts.noCache ? ' --no-cache' : ''}`
    );
    deps.log('--- Dockerfile that would be uploaded ---');
    deps.log(dockerfile);
    return {
      name: opts.name,
      serverApiKey,
      claudeMcpAddCommand: null,
    };
  }

  // Write the Dockerfile to a temp file and drive the siteio flow.
  const dockerfile = deps.generateDockerfile();
  const tempPath = await deps.writeTempFile(dockerfile);

  try {
    deps.log(`Creating siteio app "${opts.name}"…`);
    await deps.runner.createApp({
      name: opts.name,
      dockerfilePath: tempPath,
      port: 9999,
    });

    deps.log('Setting environment variables…');
    await deps.runner.setEnv({
      name: opts.name,
      envVars: {
        AGENTIO_KEY: exported.key,
        AGENTIO_CONFIG: exported.config,
        AGENTIO_SERVER_API_KEY: serverApiKey,
      },
    });

    deps.log('Deploying (this may take a minute — Docker is building your image)…');
    await deps.runner.deploy({
      name: opts.name,
      dockerfilePath: tempPath,
      noCache: opts.noCache,
    });

    // Try to surface the deployed URL. Non-fatal if siteio doesn't
    // give us one back.
    const info = await deps.runner.appInfo(opts.name);
    const url = typeof info?.url === 'string' ? info.url : undefined;
    const claudeCmd = url
      ? `claude mcp add --scope local --transport http agentio "${url}/mcp?services=rss"`
      : null;

    deps.log('');
    deps.log('Teleport complete!');
    if (url) {
      deps.log(`  URL:       ${url}`);
      deps.log(`  Health:    ${url}/health`);
      deps.log(`  MCP:       ${url}/mcp`);
    } else {
      deps.log(
        `  URL:       (siteio did not return a URL — run \`siteio apps info ${opts.name}\` to look it up)`
      );
    }
    deps.log(`  API key:   ${serverApiKey}`);
    deps.log('             (you will type this into the Authorize page when Claude Code first connects)');
    deps.log('');
    if (claudeCmd) {
      deps.log('To add to Claude Code:');
      deps.log(`  ${claudeCmd}`);
      deps.log(
        '  (swap `services=rss` for the profiles you want exposed)'
      );
    }

    return {
      name: opts.name,
      url,
      serverApiKey,
      claudeMcpAddCommand: claudeCmd,
    };
  } finally {
    // Always remove the temp Dockerfile, on both success and failure.
    await deps.removeTempFile(tempPath).catch(() => {
      /* ignore — not worth throwing over */
    });
  }
}

/* ------------------------------------------------------------------ */
/* production wiring                                                  */
/* ------------------------------------------------------------------ */

async function defaultWriteTempFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agentio-teleport-'));
  const path = join(dir, 'Dockerfile');
  await writeFile(path, content, { mode: 0o600 });
  return path;
}

async function defaultRemoveTempFile(path: string): Promise<void> {
  await unlink(path).catch(() => {});
  // The mkdtemp dir is left behind intentionally — it's in /tmp and
  // only contains the one empty file, so the OS will reap it.
}

export function registerTeleportCommand(program: Command): void {
  program
    .command('teleport')
    .description(
      'Deploy the agentio HTTP MCP server to a siteio-managed remote in one command'
    )
    .argument(
      '<name>',
      'Siteio app name (becomes the subdomain: e.g. "mcp" → mcp.<your-siteio-domain>)'
    )
    .option(
      '--dockerfile-only',
      'Print (or write) the Dockerfile without calling siteio'
    )
    .option(
      '--output <path>',
      'Used with --dockerfile-only to write the Dockerfile to a file instead of stdout'
    )
    .option(
      '--dry-run',
      'Run preflight + config export but do not invoke siteio; print the commands that would run'
    )
    .option(
      '--no-cache',
      'Pass --no-cache to `siteio apps deploy` to force a fresh Docker build'
    )
    .action(async (name: string, options) => {
      try {
        const runner = createSiteioRunner();
        await runTeleport(
          {
            name,
            dockerfileOnly: Boolean(options.dockerfileOnly),
            output: options.output,
            dryRun: Boolean(options.dryRun),
            // Commander's --no-cache sets options.cache=false when
            // declared as --no-cache; but we declared it as --no-cache
            // directly, so it comes through as options.noCache=true.
            // Handle both just in case.
            noCache: Boolean(options.noCache ?? options.cache === false),
          },
          {
            runner,
            loadConfig: () => loadConfig() as Promise<Config>,
            generateExportData,
            generateServerApiKey,
            generateDockerfile: () => generateTeleportDockerfile(),
            writeTempFile: defaultWriteTempFile,
            removeTempFile: defaultRemoveTempFile,
            log: (msg) => console.log(msg),
            warn: (msg) => console.error(msg),
          }
        );
      } catch (error) {
        handleError(error);
      }
    });
}
