import { describe, expect, test } from 'bun:test';
import { parseFrontmatter, serializeFrontmatter, mergeConfig } from './frontmatter';
import type { FrontmatterConfig } from '../../types/schedule';

describe('parseFrontmatter', () => {
  test('parses a complete frontmatter block', () => {
    const input = `---
schedule:
  type: daily
  hour: 21
  minute: 0
model: sonnet
permissionMode: bypassPermissions
sessionMode: new
enabled: true
---

Run the daily report.
`;
    const result = parseFrontmatter(input);
    expect(result.config).toEqual({
      schedule: { type: 'daily', hour: 21, minute: 0 },
      model: 'sonnet',
      permissionMode: 'bypassPermissions',
      sessionMode: 'new',
      enabled: true,
    });
    expect(result.body.trim()).toBe('Run the daily report.');
  });

  test('returns partial config when frontmatter is incomplete', () => {
    const input = `---
schedule:
  type: daily
---

Body.
`;
    const result = parseFrontmatter(input);
    expect(result.config).toEqual({
      schedule: { type: 'daily' },
    } as unknown as FrontmatterConfig);
    expect(result.body.trim()).toBe('Body.');
  });

  test('returns empty config when no frontmatter is present', () => {
    const input = 'Just a body.';
    const result = parseFrontmatter(input);
    expect(result.config).toEqual({} as unknown as FrontmatterConfig);
    expect(result.body.trim()).toBe('Just a body.');
  });
});

describe('mergeConfig', () => {
  test('override wins over base; defaults fill missing optional fields', () => {
    const base: Partial<FrontmatterConfig> = {
      schedule: { type: 'daily', hour: 8, minute: 0 },
      model: 'opus',
    };
    const override: Partial<FrontmatterConfig> = {
      schedule: { type: 'daily', hour: 21, minute: 30 },
    };
    const merged = mergeConfig(base, override);
    expect(merged.schedule).toEqual({ type: 'daily', hour: 21, minute: 30 });
    expect(merged.model).toBe('opus');
    expect(merged.permissionMode).toBe('bypassPermissions');
    expect(merged.sessionMode).toBe('new');
    expect(merged.enabled).toBe(true);
  });
});

describe('serializeFrontmatter', () => {
  test('round-trips a config', () => {
    const config: FrontmatterConfig = {
      schedule: { type: 'weekly', hour: 9, minute: 0, weekdays: [1, 3, 5] },
      model: 'sonnet',
      permissionMode: 'bypassPermissions',
      sessionMode: 'new',
      enabled: true,
    };
    const body = 'Weekly standup summary.';
    const serialized = serializeFrontmatter(config, body);
    const reparsed = parseFrontmatter(serialized);
    expect(reparsed.config).toEqual(config);
    expect(reparsed.body.trim()).toBe(body);
  });

  test('omits command when undefined', () => {
    const config: FrontmatterConfig = {
      schedule: { type: 'manual' },
      model: 'sonnet',
      permissionMode: 'default',
      sessionMode: 'new',
      enabled: true,
    };
    const serialized = serializeFrontmatter(config, 'x');
    expect(serialized).not.toContain('command');
  });
});
