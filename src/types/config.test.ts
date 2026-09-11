import { describe, expect, test } from 'bun:test';
import type { DaemonConfig } from './config';

describe('DaemonConfig', () => {
  test('has apiKey and server binding fields', () => {
    const cfg: DaemonConfig = {
      apiKey: 'k',
      server: { port: 7890, host: '0.0.0.0' },
    };
    expect(cfg.apiKey).toBe('k');
    expect(cfg.server?.port).toBe(7890);
  });
});
