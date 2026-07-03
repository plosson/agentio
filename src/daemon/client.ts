import { CliError } from '../utils/errors';
import { loadConfig } from '../config/config-manager';
import { getEnv } from '../config/config-manager';
import type { GatewayConfig, HealthResponse } from './types';

let cachedConfig: { url: string; apiKey: string } | null = null;

/**
 * Get daemon URL and API key from config or environment
 */
async function getDaemonConnection(): Promise<{ url: string; apiKey: string }> {
  if (cachedConfig) return cachedConfig;

  // Check environment variables first; legacy AGENTIO_GATEWAY_* still works.
  const envUrl =
    process.env.AGENTIO_DAEMON_URL || process.env.AGENTIO_GATEWAY_URL ||
    await getEnv('AGENTIO_DAEMON_URL') || await getEnv('AGENTIO_GATEWAY_URL');
  const envApiKey =
    process.env.AGENTIO_DAEMON_API_KEY || process.env.AGENTIO_GATEWAY_API_KEY ||
    await getEnv('AGENTIO_DAEMON_API_KEY') || await getEnv('AGENTIO_GATEWAY_API_KEY');

  if (envUrl) {
    cachedConfig = { url: envUrl, apiKey: envApiKey || '' };
    return cachedConfig;
  }

  // Load from config (post-migration: config.daemon; pre-migration: config.gateway)
  const config = await loadConfig() as unknown as {
    daemon?: GatewayConfig;
    gateway?: GatewayConfig;
  };
  const daemonConfig = config.daemon ?? config.gateway;

  // Construct URL from server host:port (local daemon)
  const host = daemonConfig?.server?.host ?? '127.0.0.1';
  const port = daemonConfig?.server?.port ?? 7890;
  const url = `http://${host}:${port}`;
  const apiKey = daemonConfig?.apiKey ?? '';

  cachedConfig = { url, apiKey };
  return cachedConfig;
}

/**
 * Make a request to the daemon API
 */
async function request<T>(method: string, endpoint: string, body?: unknown): Promise<T> {
  const { url, apiKey } = await getDaemonConnection();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (apiKey) {
    headers['X-API-Key'] = apiKey;
  }

  try {
    const response = await fetch(`${url}${endpoint}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new CliError('AUTH_FAILED', 'Daemon authentication failed', 'Check AGENTIO_DAEMON_API_KEY (or legacy AGENTIO_GATEWAY_API_KEY)');
      }

      const errorData = await response.json().catch(() => ({})) as { error?: string };
      throw new CliError('API_ERROR', errorData.error || `Daemon error: ${response.status}`);
    }

    return await response.json() as T;
  } catch (error) {
    if (error instanceof CliError) throw error;

    if (error instanceof TypeError && error.message.includes('fetch')) {
      throw new CliError('NETWORK_ERROR', 'Cannot connect to daemon', 'Is the daemon running? Try: agentio daemon status');
    }

    throw new CliError('NETWORK_ERROR', error instanceof Error ? error.message : 'Unknown error');
  }
}

/**
 * Daemon client for CLI commands
 */
export class DaemonClient {
  /**
   * Check daemon health
   */
  async health(): Promise<HealthResponse> {
    return request<HealthResponse>('GET', '/health');
  }
}

/**
 * Get a daemon client instance
 */
export async function getDaemonClient(): Promise<DaemonClient> {
  // Ensure config is loaded
  await getDaemonConnection();
  return new DaemonClient();
}

/**
 * Check if daemon is available
 */
export async function isDaemonAvailable(): Promise<boolean> {
  try {
    const client = await getDaemonClient();
    await client.health();
    return true;
  } catch {
    return false;
  }
}
