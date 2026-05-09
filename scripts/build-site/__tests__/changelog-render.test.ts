import { describe, it, expect } from 'bun:test';
import { renderRelease } from '../changelog-render';
import type { ReleaseGroups } from '../changelog';

describe('renderRelease', () => {
  const empty: ReleaseGroups = { features: [], fixes: [], internal: [] };

  it('renders version, date, and feature list', () => {
    const groups: ReleaseGroups = {
      features: [{ type: 'feat', scope: 'gmail', subject: 'add filters', sha: 'abc1234' }],
      fixes: [],
      internal: [],
    };
    const html = renderRelease({ name: 'v1.7.0', date: '2026-05-09T00:00:00Z' }, groups);
    expect(html).toContain('v1.7.0');
    expect(html).toContain('add filters');
    expect(html).toContain('gmail');
    expect(html).toContain('abc1234');
  });

  it('collapses internal changes in <details>', () => {
    const groups: ReleaseGroups = {
      features: [],
      fixes: [],
      internal: [{ type: 'docs', subject: 'tweak readme', sha: 'def5678' }],
    };
    const html = renderRelease({ name: 'v1.0.0', date: '2026-01-01T00:00:00Z' }, groups);
    expect(html).toContain('<details');
    expect(html).toContain('Internal changes');
    expect(html).toContain('tweak readme');
  });

  it('omits empty groups', () => {
    const html = renderRelease({ name: 'v1.0.0', date: '2026-01-01T00:00:00Z' }, empty);
    expect(html).not.toContain('Features');
    expect(html).not.toContain('Fixes');
    expect(html).not.toContain('Internal');
  });
});
