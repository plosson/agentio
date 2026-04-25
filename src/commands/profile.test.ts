import { describe, expect, test } from 'bun:test';
import { formatProfileList, type ProfileSummary } from './profile';

describe('formatProfileList', () => {
  test('groups profiles by service when multiple services have profiles', () => {
    const summaries: ProfileSummary[] = [
      { service: 'gmail', name: 'work' },
      { service: 'gmail', name: 'personal' },
      { service: 'slack', name: 'main' },
    ];
    const out = formatProfileList(summaries);
    expect(out).toContain('gmail:');
    expect(out).toContain('  work');
    expect(out).toContain('  personal');
    expect(out).toContain('slack:');
    expect(out).toContain('  main');
  });

  test('renders empty-state hint when no profiles', () => {
    const out = formatProfileList([]);
    expect(out).toContain('No profiles configured');
    expect(out).toContain('agentio profile add');
  });

  test('marks read-only profiles', () => {
    const summaries: ProfileSummary[] = [
      { service: 'gmail', name: 'work', readOnly: true },
    ];
    const out = formatProfileList(summaries);
    expect(out).toContain('[read-only]');
  });
});
