import { describe, expect, test } from 'bun:test';
import { renderChecks, type Check } from './doctor';

describe('renderChecks', () => {
  test('formats ok/warn/error with leading symbols', () => {
    const checks: Check[] = [
      { name: 'Vault', status: 'ok', detail: 'configured at ~/.config/agentio/vault.enc' },
      { name: 'Daemon', status: 'warn', detail: 'installed but not running' },
      { name: 'Profiles', status: 'error', detail: 'no profiles configured', fix: 'agentio gmail profile add' },
    ];
    const out = renderChecks(checks);
    expect(out).toContain('✓ Vault');
    expect(out).toContain('! Daemon');
    expect(out).toContain('✗ Profiles');
    expect(out).toContain('agentio gmail profile add');
  });
});
