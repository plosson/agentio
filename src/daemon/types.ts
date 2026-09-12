/** Fixed bind: the daemon runs in a container, so the port is mapped there. */
export const DAEMON_HOST = '0.0.0.0';
export const DAEMON_PORT = 7890;

export interface HealthResponse {
  status: 'ok';
  timestamp: number;
  uptime: number;
  locked: boolean;
}
