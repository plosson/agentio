import { describe, test, expect } from 'bun:test';
import { parseServiceProfiles } from '../server';

describe('parseServiceProfiles', () => {
  test('parses service:profile pairs', () => {
    const pairs = parseServiceProfiles(['gmail:work', 'slack:team']);
    expect(pairs).toEqual([
      { service: 'gmail', profile: 'work' },
      { service: 'slack', profile: 'team' },
    ]);
  });

  test('parses service without profile', () => {
    const pairs = parseServiceProfiles(['rss']);
    expect(pairs).toEqual([{ service: 'rss' }]);
  });

  test('handles mixed services with and without profiles', () => {
    const pairs = parseServiceProfiles(['gmail:work', 'rss', 'jira:myteam']);
    expect(pairs).toEqual([
      { service: 'gmail', profile: 'work' },
      { service: 'rss' },
      { service: 'jira', profile: 'myteam' },
    ]);
  });

  test('handles empty array', () => {
    const pairs = parseServiceProfiles([]);
    expect(pairs).toEqual([]);
  });

  test('handles profile with colons in name', () => {
    // Edge case: profile name itself contains a colon
    const pairs = parseServiceProfiles(['gmail:work:extra']);
    expect(pairs).toEqual([
      { service: 'gmail', profile: 'work:extra' },
    ]);
  });
});
