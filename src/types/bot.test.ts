import { describe, expect, test } from 'bun:test';
import type { BotConfig } from './bot';
import { DEFAULT_BOT_CONFIG } from './bot';
import type { ProfileEntry } from './config';

describe('BotConfig', () => {
  test('DEFAULT_BOT_CONFIG has bypassPermissions and sonnet', () => {
    expect(DEFAULT_BOT_CONFIG.enabled).toBe(false);
    expect(DEFAULT_BOT_CONFIG.model).toBe('sonnet');
    expect(DEFAULT_BOT_CONFIG.permissionMode).toBe('bypassPermissions');
  });

  test('ProfileEntry accepts optional bot config', () => {
    const entry: ProfileEntry = {
      name: 'mybot',
      bot: { enabled: true, model: 'sonnet', permissionMode: 'bypassPermissions' },
    };
    expect(entry.bot?.enabled).toBe(true);
  });

  test('BotConfig accepts optional systemPrompt and cwd', () => {
    const cfg: BotConfig = {
      enabled: true, model: 'opus', permissionMode: 'plan',
      systemPrompt: 'You are concise.',
      cwd: '/tmp/work',
    };
    expect(cfg.systemPrompt).toBe('You are concise.');
    expect(cfg.cwd).toBe('/tmp/work');
  });
});
