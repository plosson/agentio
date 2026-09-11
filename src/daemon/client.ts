import { DAEMON_PORT, type HealthResponse } from './types';

const LOCAL_DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;

/**
 * Probe the local daemon's /health. Returns null when it is not reachable.
 * Reads nothing from the vault, so it works whether or not one is unlocked.
 */
export async function getDaemonHealth(): Promise<HealthResponse | null> {
  try {
    const response = await fetch(`${LOCAL_DAEMON_URL}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    return (await response.json()) as HealthResponse;
  } catch {
    return null;
  }
}
