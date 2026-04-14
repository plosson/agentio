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
 * `agentio mcp teleport <name>` — one-command deploy of the local agentio
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

/** Path inside the repo to the teleport Dockerfile (relative to repo root). */
export const TELEPORT_DOCKERFILE_PATH = 'docker/Dockerfile.teleport';

/** Container path where agentio writes config + tokens.enc. */
export const DATA_VOLUME_PATH = '/data';

/**
 * Compute the named-volume identifier for an app. Per-app suffix avoids
 * collisions when a user deploys multiple agentio instances on the same
 * siteio agent (e.g. mcp-prod + mcp-staging).
 */
export function volumeNameFor(appName: string): string {
  return `agentio-data-${appName}`;
}

/**
 * Inspect an app's `volumes` field (as returned by `siteio apps info`)
 * and decide whether `/data` is already mounted. Tolerates the various
 * shapes siteio might return (array of strings, array of objects with
 * `path` or `mountPath`, or absent).
 */
export function hasDataVolumeMount(appInfo: unknown): boolean {
  if (!appInfo || typeof appInfo !== 'object') return false;
  const vols = (appInfo as { volumes?: unknown }).volumes;
  if (!Array.isArray(vols)) return false;
  return vols.some((v) => {
    if (typeof v === 'string') return v.endsWith(`:${DATA_VOLUME_PATH}`);
    if (v && typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      return obj.path === DATA_VOLUME_PATH || obj.mountPath === DATA_VOLUME_PATH;
    }
    return false;
  });
}

/** Siteio app names must match this pattern. Mirrors Docker image name rules. */
const VALID_NAME = /^[a-z][a-z0-9-]{0,62}$/;

/**
 * Normalize common git URL shapes to an HTTPS URL that siteio's agent
 * can clone without credentials. SSH URLs (`git@github.com:owner/repo.git`)
 * are converted; HTTPS URLs pass through unchanged.
 */
export function normalizeGitUrl(url: string): string {
  const trimmed = url.trim();
  // git@github.com:owner/repo.git  →  https://github.com/owner/repo.git
  // git@gitlab.example.com:group/sub/repo.git  →  https://gitlab.example.com/group/sub/repo.git
  const sshMatch = trimmed.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) {
    const host = sshMatch[1];
    const path = sshMatch[2];
    return `https://${host}/${path}.git`;
  }
  // Already HTTPS / HTTP — leave alone.
  if (/^https?:\/\//.test(trimmed)) {
    return trimmed;
  }
  // Unknown shape — return as-is and let siteio report the error.
  return trimmed;
}

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
  /**
   * Return the git origin URL of the current project, or null if the
   * cwd isn't a git repo / has no origin remote. Used to compute the
   * siteio `--git` argument in git-mode.
   */
  detectGitOriginUrl: () => Promise<string | null>;
  /**
   * HTTP probe used by `waitForHealth`. Returns the status code (200 on
   * a healthy server). Network errors are surfaced as `null` so the
   * poller can treat them the same as a not-yet-ready container.
   */
  probeHealth: (url: string) => Promise<number | null>;
  /** Resolved after `ms` milliseconds. Injected for testability. */
  sleep: (ms: number) => Promise<void>;
  log: (msg: string) => void;
  warn: (msg: string) => void;
}

/* ------------------------------------------------------------------ */
/* health polling                                                     */
/* ------------------------------------------------------------------ */

/** How long to wait for /health to return 200 before giving up. */
export const HEALTH_TIMEOUT_MS = 90_000;
/** Spacing between consecutive /health probes. */
export const HEALTH_INTERVAL_MS = 2_000;
/** Number of log lines to surface when the health check times out. */
export const HEALTH_FAILURE_LOG_TAIL = 50;

/**
 * Poll `${url}/health` until it returns 200 or we exhaust the attempt
 * budget (ceil(timeoutMs / intervalMs)). Returns true on success; false
 * otherwise. Uses an attempt-count loop (not wall clock) so tests that
 * stub `deps.sleep` to a no-op can exercise the timeout path without
 * actually waiting 90 real seconds.
 */
export async function waitForHealth(
  url: string,
  deps: Pick<TeleportDeps, 'probeHealth' | 'sleep' | 'log'>,
  opts: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? HEALTH_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? HEALTH_INTERVAL_MS;
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));
  const healthUrl = `${url.replace(/\/+$/, '')}/health`;
  deps.log(`Waiting for ${healthUrl} (up to ${Math.round(timeoutMs / 1000)}s)…`);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const status = await deps.probeHealth(healthUrl);
    if (status === 200) {
      deps.log(`  /health responded 200 after ${attempt} attempt(s).`);
      return true;
    }
    if (attempt < maxAttempts) {
      await deps.sleep(intervalMs);
    }
  }
  return false;
}

export interface TeleportOptions {
  name: string;
  dockerfileOnly?: boolean;
  output?: string;
  dryRun?: boolean;
  noCache?: boolean;
  /**
   * When set, switches to git-mode: siteio clones the repo on the agent
   * and builds docker/Dockerfile.teleport with the repo as the build
   * context. Required to deploy unreleased code — the default inline
   * mode fetches the latest GitHub release binary, which won't contain
   * commits that haven't shipped yet.
   */
  gitBranch?: string;
  /**
   * Override the git URL siteio clones from. Default: detected via
   * `git remote get-url origin` in the current working directory,
   * normalized from SSH (`git@github.com:owner/repo.git`) to HTTPS.
   */
  gitUrl?: string;
  /**
   * Sync mode: re-export the local config + push it to an EXISTING
   * siteio app via `apps set -e AGENTIO_KEY=… -e AGENTIO_CONFIG=…`,
   * then `apps restart`. Does NOT touch AGENTIO_SERVER_API_KEY (so
   * the operator key on the remote stays the same and Claude clients
   * keep using the same /authorize PIN). Does NOT rebuild the Docker
   * image. Use this when you've added or changed profiles locally and
   * want the remote to pick them up.
   */
  sync?: boolean;
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
 * Sync mode: re-export local config and push it to an existing siteio
 * app, then restart. Same dependency-injection model as runTeleport
 * for testability.
 */
async function runSync(
  opts: TeleportOptions,
  deps: TeleportDeps
): Promise<TeleportResult> {
  // Preflight: same as full teleport.
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

  // Sync requires the app to ALREADY EXIST. This is the inverse of the
  // normal teleport check.
  deps.log(`Checking that siteio app "${opts.name}" exists…`);
  const existing = await deps.runner.findApp(opts.name);
  if (!existing) {
    throw new CliError(
      'NOT_FOUND',
      `No siteio app named "${opts.name}" to sync to`,
      `Run \`agentio mcp teleport ${opts.name}\` (without --sync) first to create it.`
    );
  }

  // Re-export local config — generates a fresh AGENTIO_KEY each call.
  deps.log('Re-exporting local configuration…');
  const exported = await deps.generateExportData();

  // Detect whether /data is already mounted as a persistent volume.
  // If not, attach it as part of this sync (one-time backfill for apps
  // teleported before the volume was a default).
  const detail = await deps.runner.appInfo(opts.name);
  const needsVolumeBackfill = !hasDataVolumeMount(detail);
  if (needsVolumeBackfill) {
    deps.log(
      `No persistent volume mounted at ${DATA_VOLUME_PATH} — will attach ${volumeNameFor(opts.name)}:${DATA_VOLUME_PATH} as part of this sync.`
    );
  }

  // Dry-run: report what would happen and exit.
  if (opts.dryRun) {
    deps.log('--- Dry run: the following commands would be executed ---');
    const dryParts = [
      `siteio apps set ${opts.name}`,
      '-e AGENTIO_KEY=<redacted>',
      `-e AGENTIO_CONFIG=<${exported.config.length} chars>`,
    ];
    if (needsVolumeBackfill) {
      dryParts.push(
        `-v ${volumeNameFor(opts.name)}:${DATA_VOLUME_PATH}`
      );
    }
    deps.log(dryParts.join(' '));
    deps.log(`siteio apps restart ${opts.name}`);
    deps.log(
      '(AGENTIO_SERVER_API_KEY is intentionally NOT touched — operator key on the remote stays the same.)'
    );
    return {
      name: opts.name,
      serverApiKey: '',
      claudeMcpAddCommand: null,
    };
  }

  deps.log(
    needsVolumeBackfill
      ? 'Updating env vars + attaching persistent volume on siteio…'
      : 'Updating environment variables on siteio…'
  );
  // Critical: only AGENTIO_KEY + AGENTIO_CONFIG in env. Do NOT pass
  // AGENTIO_SERVER_API_KEY — siteio's `apps set -e` only updates the
  // vars you name, leaving others intact, which is exactly what we
  // want: the operator key stays the same so Claude /authorize keeps
  // accepting the existing PIN.
  //
  // For volumes: only attach /data if it isn't already mounted. Siteio
  // REPLACES the volumes list on update (env merges; volumes don't),
  // so attaching when something else is mounted would clobber it.
  await deps.runner.setApp({
    name: opts.name,
    envVars: {
      AGENTIO_KEY: exported.key,
      AGENTIO_CONFIG: exported.config,
    },
    ...(needsVolumeBackfill
      ? {
          volumes: { [volumeNameFor(opts.name)]: DATA_VOLUME_PATH },
        }
      : {}),
  });

  deps.log('Restarting container so the new env vars take effect…');
  await deps.runner.restartApp(opts.name);

  // We already fetched appInfo earlier for volume detection; reuse
  // its URL field rather than calling again. Same fallback as the
  // full-teleport path: siteio's `apps info --json` omits the
  // generated subdomain URL, so fall back to findApp if it's missing.
  let url = typeof detail?.url === 'string' ? detail.url : undefined;
  if (!url) {
    const listed = await deps.runner.findApp(opts.name);
    if (typeof listed?.url === 'string') url = listed.url;
  }

  // Same health-check / log-surface pattern as the full teleport path.
  // A sync that breaks the container (bad env, corrupted config blob,
  // volume backfill surprise) should fail loudly instead of silently
  // leaving a crash-looping remote.
  if (url) {
    const healthy = await waitForHealth(url, deps);
    if (!healthy) {
      deps.warn(
        `Container failed to report healthy after ${Math.round(HEALTH_TIMEOUT_MS / 1000)}s. Fetching logs…`
      );
      const logs = await deps.runner.logsApp(opts.name, {
        tail: HEALTH_FAILURE_LOG_TAIL,
      });
      deps.warn('--- container logs (tail) ---');
      deps.warn(logs.trim() || '(no logs returned by siteio)');
      deps.warn('--- end logs ---');
      throw new CliError(
        'API_ERROR',
        `Sync to "${opts.name}" restarted the container but /health never returned 200`,
        'Inspect the logs above. The previous config is gone — the next sync (or a manual `siteio apps restart`) will still see the broken state until you fix the root cause.'
      );
    }
  }

  deps.log('');
  deps.log('Sync complete!');
  if (url) {
    deps.log(`  URL:    ${url}`);
    deps.log(`  Health: ${url}/health`);
  }
  if (needsVolumeBackfill) {
    deps.log(
      '  First sync after volume backfill: previous /data state is gone, so'
    );
    deps.log(
      '        any bearer Claude had cached is now invalid. Re-paste the'
    );
    deps.log(
      '        operator API key when prompted. From here on, bearers persist.'
    );
  } else {
    deps.log(
      '  Note: container restarted. With the persistent volume on /data,'
    );
    deps.log(
      '        connected clients should keep their existing bearer.'
    );
  }

  return {
    name: opts.name,
    url,
    // We did not generate a new server key in sync mode.
    serverApiKey: '',
    claudeMcpAddCommand: null,
  };
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

  // Sync mode short-circuits — different command shape, different
  // preflight (app must EXIST, not absent), no Dockerfile work, no
  // create. Mutual exclusion with the "create new app" flags.
  if (opts.sync) {
    if (opts.dockerfileOnly) {
      throw new CliError(
        'INVALID_PARAMS',
        '--sync cannot be combined with --dockerfile-only',
        '--dockerfile-only emits a Dockerfile for a fresh deploy; --sync just pushes new env to an existing app.'
      );
    }
    if (opts.gitBranch) {
      throw new CliError(
        'INVALID_PARAMS',
        '--sync cannot be combined with --git-branch',
        '--git-branch triggers a fresh build; --sync only pushes config. Use one or the other.'
      );
    }
    if (opts.noCache) {
      throw new CliError(
        'INVALID_PARAMS',
        '--sync cannot be combined with --no-cache',
        '--no-cache is a build flag; --sync does not rebuild.'
      );
    }
    if (opts.output) {
      throw new CliError(
        'INVALID_PARAMS',
        '--sync cannot be combined with --output',
        '--output is for --dockerfile-only.'
      );
    }
    return runSync(opts, deps);
  }

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

  // Resolve git mode settings up front so dry-run can show the same
  // command shape the real run would use.
  const isGitMode = Boolean(opts.gitBranch);
  let gitSettings: { repoUrl: string; branch: string } | null = null;
  if (isGitMode) {
    let repoUrl = opts.gitUrl;
    if (!repoUrl) {
      const detected = await deps.detectGitOriginUrl();
      if (!detected) {
        throw new CliError(
          'CONFIG_ERROR',
          'Could not detect git origin URL for --git-branch mode',
          'Run from inside a git repo with an "origin" remote, or pass --git-url <url> explicitly.'
        );
      }
      repoUrl = normalizeGitUrl(detected);
    } else {
      repoUrl = normalizeGitUrl(repoUrl);
    }
    gitSettings = { repoUrl, branch: opts.gitBranch! };
    deps.log(
      `Git mode: will clone ${gitSettings.repoUrl} @ ${gitSettings.branch}`
    );
  }

  // Dry-run: report what would happen and exit.
  if (opts.dryRun) {
    deps.log('--- Dry run: the following commands would be executed ---');
    if (gitSettings) {
      deps.log(
        `siteio apps create ${opts.name} -g ${gitSettings.repoUrl} --branch ${gitSettings.branch} --dockerfile ${TELEPORT_DOCKERFILE_PATH} -p 9999`
      );
    } else {
      deps.log(
        `siteio apps create ${opts.name} -f <tempfile> -p 9999`
      );
    }
    deps.log(
      `siteio apps set ${opts.name} -e AGENTIO_KEY=<redacted> -e AGENTIO_CONFIG=<${exported.config.length} chars> -e AGENTIO_SERVER_API_KEY=${serverApiKey}`
    );
    deps.log(
      `siteio apps deploy ${opts.name}${opts.noCache ? ' --no-cache' : ''}`
    );
    if (!gitSettings) {
      const dockerfile = deps.generateDockerfile();
      deps.log('--- Dockerfile that would be uploaded ---');
      deps.log(dockerfile);
    } else {
      deps.log(
        `--- siteio will build ${TELEPORT_DOCKERFILE_PATH} from the cloned repo (no inline Dockerfile) ---`
      );
    }
    return {
      name: opts.name,
      serverApiKey,
      claudeMcpAddCommand: null,
    };
  }

  // In inline mode, write the generated Dockerfile to a temp file so
  // siteio can read it with -f. In git mode, no temp file is needed —
  // the Dockerfile already lives in the repo siteio is cloning.
  const tempPath = gitSettings
    ? null
    : await deps.writeTempFile(deps.generateDockerfile());

  try {
    deps.log(`Creating siteio app "${opts.name}"…`);
    if (gitSettings) {
      await deps.runner.createApp({
        name: opts.name,
        port: 9999,
        git: {
          repoUrl: gitSettings.repoUrl,
          branch: gitSettings.branch,
          dockerfilePath: TELEPORT_DOCKERFILE_PATH,
        },
      });
    } else {
      await deps.runner.createApp({
        name: opts.name,
        dockerfilePath: tempPath!,
        port: 9999,
      });
    }

    deps.log('Setting environment variables and persistent volume…');
    await deps.runner.setApp({
      name: opts.name,
      envVars: {
        AGENTIO_KEY: exported.key,
        AGENTIO_CONFIG: exported.config,
        AGENTIO_SERVER_API_KEY: serverApiKey,
      },
      // Persistent named volume mounted at /data so config.server.tokens
      // (issued OAuth bearers) survive container restarts. Without this
      // mount, every restart wipes the bearer and connected clients
      // would re-run the OAuth flow.
      volumes: { [volumeNameFor(opts.name)]: DATA_VOLUME_PATH },
    });

    deps.log('Deploying (this may take a minute — Docker is building your image)…');
    await deps.runner.deploy({
      name: opts.name,
      // In git mode, there's no -f to re-pass on deploy — siteio uses
      // the stored git settings from create.
      ...(tempPath ? { dockerfilePath: tempPath } : {}),
      noCache: opts.noCache,
    });

    // Try to surface the deployed URL. Non-fatal if siteio doesn't
    // give us one back.
    const info = await deps.runner.appInfo(opts.name);
    let url = typeof info?.url === 'string' ? info.url : undefined;
    // siteio's `apps info --json` output omits the generated subdomain
    // URL (domains: [] in the payload) even though the app is reachable
    // at it. `apps list --json` DOES include the url field at the top
    // level. Fall back to findApp so the post-deploy health check can
    // still run even when siteio doesn't surface url in info.
    if (!url) {
      const listed = await deps.runner.findApp(opts.name);
      if (typeof listed?.url === 'string') url = listed.url;
    }

    // Poll /health to CONFIRM the container actually came up. siteio's
    // deploy returns success as soon as Docker starts the container, so
    // a crash-loop (bad volume permissions, bad config, missing binary,
    // etc.) looks like a successful deploy until the user probes it
    // themselves. Surfacing logs on timeout is the fix.
    if (url) {
      const healthy = await waitForHealth(url, deps);
      if (!healthy) {
        deps.warn(
          `Container failed to report healthy after ${Math.round(HEALTH_TIMEOUT_MS / 1000)}s. Fetching logs…`
        );
        const logs = await deps.runner.logsApp(opts.name, {
          tail: HEALTH_FAILURE_LOG_TAIL,
        });
        deps.warn('--- container logs (tail) ---');
        deps.warn(logs.trim() || '(no logs returned by siteio)');
        deps.warn('--- end logs ---');
        throw new CliError(
          'API_ERROR',
          `Deploy "${opts.name}" started but /health never returned 200`,
          'Inspect the logs above. Common causes: permission errors on mounted volumes, missing env vars, binary not found for the container arch.'
        );
      }
    } else {
      deps.warn(
        'Skipping health check: siteio did not return a URL for this app. ' +
          `Run \`siteio apps info ${opts.name}\` and curl <url>/health manually to verify.`
      );
    }

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
    // In inline mode, always remove the temp Dockerfile on both success
    // and failure. In git mode there is nothing to clean up.
    if (tempPath) {
      await deps.removeTempFile(tempPath).catch(() => {
        /* ignore — not worth throwing over */
      });
    }
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

/**
 * Default git-origin-URL detector: shell out to `git remote get-url origin`.
 * Returns null if the cwd isn't a git repo, has no origin remote, or if
 * the git binary isn't on PATH.
 */
/**
 * Default health probe: HEAD-equivalent GET on the given URL. Returns
 * the HTTP status code, or null if the request couldn't be made (DNS,
 * connection refused, TLS error, etc). We treat connection errors the
 * same as "not ready yet" so the poller keeps retrying.
 */
async function defaultProbeHealth(url: string): Promise<number | null> {
  try {
    // Short timeout per attempt so a hung connection can't eat the
    // whole polling budget. AbortSignal.timeout is natively supported
    // by Bun's fetch.
    const res = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(5_000),
    });
    // Drain the body so the socket is released promptly; we only care
    // about the status code here.
    await res.text().catch(() => {});
    return res.status;
  } catch {
    return null;
  }
}

async function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultDetectGitOriginUrl(): Promise<string | null> {
  try {
    const proc = Bun.spawn(['git', 'remote', 'get-url', 'origin'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) return null;
    const url = stdout.trim();
    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

/**
 * Register the `teleport` subcommand under a parent Commander command
 * (typically `mcp`). Invoked from `registerMcpCommands` so the user
 * types `agentio mcp teleport <name>` rather than `agentio teleport`.
 */
export function registerTeleportCommand(parent: Command): void {
  parent
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
    .option(
      '--git-branch <branch>',
      'Deploy unreleased code by telling siteio to clone this repo and build docker/Dockerfile.teleport from the given branch (instead of fetching the latest release binary)'
    )
    .option(
      '--git-url <url>',
      'Override the git URL siteio clones from. Default: detected via `git remote get-url origin`, normalized to HTTPS'
    )
    .option(
      '--sync',
      'Push the latest local config (profiles + credentials) to an EXISTING siteio app and restart it. Use after adding/changing a profile. Does not rebuild the image; does not change the operator API key.'
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
            gitBranch: options.gitBranch,
            gitUrl: options.gitUrl,
            sync: Boolean(options.sync),
          },
          {
            runner,
            loadConfig: () => loadConfig() as Promise<Config>,
            generateExportData,
            generateServerApiKey,
            generateDockerfile: () => generateTeleportDockerfile(),
            writeTempFile: defaultWriteTempFile,
            removeTempFile: defaultRemoveTempFile,
            detectGitOriginUrl: defaultDetectGitOriginUrl,
            probeHealth: defaultProbeHealth,
            sleep: defaultSleep,
            log: (msg) => console.log(msg),
            warn: (msg) => console.error(msg),
          }
        );
      } catch (error) {
        handleError(error);
      }
    });
}
