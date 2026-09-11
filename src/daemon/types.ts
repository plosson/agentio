export interface HealthResponse {
  status: 'ok' | 'error';
  timestamp: number;
  uptime: number;
  locked: boolean;
}
