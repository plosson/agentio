import type { GatewayConfig } from '../types/config';

// Re-export for convenience
export type { GatewayConfig } from '../types/config';

export const DEFAULT_GATEWAY_CONFIG: Required<GatewayConfig> = {
  name: '',
  apiUrl: '',
  apiKey: '',
  server: {
    port: 7890,
    host: '0.0.0.0',  // Bind to all interfaces by default for server
  },
  webhook: {
    url: '',
    secret: '',
    debounceMs: 2000,
  },
  media: {
    download: true,
    maxSizeMb: 50,
  },
  retention: {
    doneMessagesDays: 30,
    sentMessagesDays: 7,
  },
};

export interface HealthResponse {
  status: 'ok' | 'error';
  timestamp: number;
}
