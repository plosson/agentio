import type { GatewayConfig } from '../types/config';

// Re-export for convenience
export type { GatewayConfig } from '../types/config';

export const DEFAULT_GATEWAY_CONFIG: Required<GatewayConfig> = {
  apiKey: '',
  server: {
    port: 7890,
    host: '0.0.0.0',  // Bind to all interfaces by default for server
  },
};

export interface HealthResponse {
  status: 'ok' | 'error';
  timestamp: number;
}
