import { describe, expect, test } from 'bun:test';
import type { Config, DaemonConfig } from './config';

describe('DaemonConfig', () => {
  test('has all gateway fields plus scheduler', () => {
    const cfg: DaemonConfig = {
      apiKey: 'k',
      server: { port: 7890 },
      scheduler: {
        watchedFolders: [{ path: '/tmp/x', addedAt: 1 }],
        tickIntervalSec: 60,
      },
    };
    expect(cfg.scheduler?.watchedFolders[0].path).toBe('/tmp/x');
  });
});
