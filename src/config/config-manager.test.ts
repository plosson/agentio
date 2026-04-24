import { describe, expect, test } from 'bun:test';
import { migrateGatewayToDaemon } from './config-manager';

describe('migrateGatewayToDaemon', () => {
  test('copies gateway into daemon when daemon absent', () => {
    const input = { profiles: {}, gateway: { apiKey: 'k' } };
    const out = migrateGatewayToDaemon(input);
    expect(out.daemon).toEqual({ apiKey: 'k' });
    expect(out.gateway).toBeUndefined();
  });

  test('leaves daemon alone when already present', () => {
    const input = {
      profiles: {},
      gateway: { apiKey: 'old' },
      daemon: { apiKey: 'new' },
    };
    const out = migrateGatewayToDaemon(input);
    expect(out.daemon?.apiKey).toBe('new');
    expect(out.gateway).toBeUndefined();
  });

  test('is a no-op when neither is present', () => {
    const input = { profiles: {} };
    const out = migrateGatewayToDaemon(input);
    expect(out.daemon).toBeUndefined();
    expect(out.gateway).toBeUndefined();
  });
});
