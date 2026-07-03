import { loadConfig, getEnv } from '../config/config-manager';

let cachedConfig: { url: string; apiKey: string } | null = null;

/**
 * Get daemon URL and API key from config or environment
 */
async function getDaemonConnection(): Promise<{ url: string; apiKey: string }> {
  if (cachedConfig) return cachedConfig;

  // Check environment variables first.
  const envUrl =
    process.env.AGENTIO_DAEMON_URL || await getEnv('AGENTIO_DAEMON_URL');
  const envApiKey =
    process.env.AGENTIO_DAEMON_API_KEY || await getEnv('AGENTIO_DAEMON_API_KEY');

  if (envUrl) {
    cachedConfig = { url: envUrl, apiKey: envApiKey || '' };
    return cachedConfig;
  }

  const daemonConfig = (await loadConfig()).daemon;

  // Construct URL from server host:port (local daemon)
  const host = daemonConfig?.server?.host ?? '127.0.0.1';
  const port = daemonConfig?.server?.port ?? 7890;
  cachedConfig = { url: `http://${host}:${port}`, apiKey: daemonConfig?.apiKey ?? '' };
  return cachedConfig;
}

/**
 * Check if the daemon is running and reachable (via its /health endpoint).
 */
export async function isDaemonAvailable(): Promise<boolean> {
  try {
    const { url, apiKey } = await getDaemonConnection();
    const response = await fetch(`${url}/health`, {
      headers: apiKey ? { 'X-API-Key': apiKey } : {},
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}
