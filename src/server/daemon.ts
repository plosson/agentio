import { randomBytes } from 'crypto';

import { loadConfig, saveConfig } from '../config/config-manager';
import type { Config } from '../types/config';
import type { ServerConfig } from '../types/server';
import { handleRequest, type ServerContext } from './http';
import {
  createOAuthStore,
  type PersistableOAuthState,
} from './oauth-store';

const DEFAULT_PORT = 9999;
const DEFAULT_HOST = '0.0.0.0';

/**
 * Validate a port value from any source (CLI, env, config). Bun.serve
 * silently falls back to a default when given NaN / negative / oversized
 * values; we want to bail loudly instead so the operator sees the
 * misconfiguration.
 */
function validatePort(value: number, source: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(
      `Invalid port from ${source}: must be an integer in [1, 65535], got ${value}`
    );
  }
  return value;
}

export interface StartServerOptions {
  /** Override the bound port (CLI flag > env > config > default). */
  port?: number;
  /** Override the bound host (CLI flag > env > config > default). */
  host?: string;
  /** Override the API key in-memory (does not get persisted). */
  apiKey?: string;
}

let shutdownRequested = false;
let runningServer: ReturnType<typeof Bun.serve> | null = null;

/**
 * Resolve effective server config from CLI options → env vars → stored
 * config → defaults. The stored config is the source of truth for the API
 * key (it persists across restarts), but CLI/env can override it for the
 * current process only.
 */
async function resolveServerConfig(opts: StartServerOptions): Promise<{
  port: number;
  host: string;
  apiKey: string;
  generated: boolean;
}> {
  const config = (await loadConfig()) as Config;
  let stored: ServerConfig = config.server ?? {};
  let generated = false;

  // Generate and persist an API key on first run.
  if (!stored.apiKey) {
    const generatedKey = `srv_${randomBytes(24).toString('base64url')}`;
    stored = { ...stored, apiKey: generatedKey };
    config.server = stored;
    await saveConfig(config);
    generated = true;
  }

  let port: number;
  if (opts.port !== undefined) {
    port = validatePort(opts.port, '--port');
  } else if (process.env.AGENTIO_SERVER_PORT) {
    port = validatePort(
      Number(process.env.AGENTIO_SERVER_PORT),
      'AGENTIO_SERVER_PORT'
    );
  } else if (stored.port !== undefined) {
    port = validatePort(stored.port, 'config.server.port');
  } else {
    port = DEFAULT_PORT;
  }

  const host =
    opts.host ??
    process.env.AGENTIO_SERVER_HOST ??
    stored.host ??
    DEFAULT_HOST;

  const apiKey =
    opts.apiKey ?? process.env.AGENTIO_SERVER_API_KEY ?? stored.apiKey!;

  return { port, host, apiKey, generated };
}

/**
 * Start the agentio HTTP server in the foreground. Mirrors the gateway
 * daemon's lifecycle: load/persist config, install signal handlers, run a
 * Bun HTTP server, and `await` forever until SIGINT/SIGTERM.
 */
export async function startServer(opts: StartServerOptions = {}): Promise<void> {
  console.log(`agentio-server starting (PID ${process.pid})`);

  const { port, host, apiKey, generated } = await resolveServerConfig(opts);

  if (generated) {
    console.log('Generated new API key (persisted to config.server.apiKey)');
  }

  // Always print the API key so headless deploys (Docker, journalctl) can
  // read it from the logs.
  console.log(`API Key: ${apiKey}`);
  console.log(`Listening on http://${host}:${port}`);

  // Build the OAuth store. State is loaded from config.server.{clients,
  // tokens} and persisted on every mutation through a callback that
  // round-trips through loadConfig/saveConfig — that way we never clobber
  // unrelated config.server.* fields (apiKey, port, host) that another
  // part of the daemon may have updated.
  const initialConfig = (await loadConfig()) as Config;
  const oauthStore = createOAuthStore({
    initial: {
      clients: initialConfig.server?.clients,
      tokens: initialConfig.server?.tokens,
    },
    save: async (state: PersistableOAuthState) => {
      const cfg = (await loadConfig()) as Config;
      cfg.server = {
        ...cfg.server,
        clients: state.clients,
        tokens: state.tokens,
      };
      await saveConfig(cfg);
    },
  });

  const ctx: ServerContext = { apiKey, oauthStore };

  const shutdown = async (signal: string) => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    console.log(`\nReceived ${signal}, shutting down...`);
    if (runningServer) {
      runningServer.stop();
      runningServer = null;
    }
    console.log('Server stopped');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    runningServer = Bun.serve({
      port,
      hostname: host,
      fetch: (req) => handleRequest(req, ctx),
    });

    console.log('Server ready');

    // Wait forever; signal handlers will exit().
    await new Promise(() => {});
  } catch (error) {
    console.error(
      'Server error:',
      error instanceof Error ? error.message : error
    );
    process.exit(1);
  }
}
