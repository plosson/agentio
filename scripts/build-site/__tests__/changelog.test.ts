import { describe, it, expect } from 'bun:test';
import { parseConventional, groupReleases } from '../changelog';

describe('parseConventional', () => {
  it('parses feat with scope', () => {
    expect(parseConventional('feat(gmail): add filters')).toEqual({
      type: 'feat', scope: 'gmail', subject: 'add filters',
    });
  });

  it('parses fix without scope', () => {
    expect(parseConventional('fix: handle null token')).toEqual({
      type: 'fix', scope: undefined, subject: 'handle null token',
    });
  });

  it('returns null for non-conventional commits', () => {
    expect(parseConventional('Random merge commit')).toBeNull();
  });

  it('flags version bump commits', () => {
    expect(parseConventional('chore: bump version to 1.7.0')).toEqual({
      type: 'chore',
      scope: undefined,
      subject: 'bump version to 1.7.0',
      isVersionBump: true,
    });
  });
});

describe('groupReleases', () => {
  it('groups feats and fixes into prominent buckets, others into internal', () => {
    const commits = [
      { sha: 'a1', subject: 'feat(gmail): add filters', body: '' },
      { sha: 'a2', subject: 'fix: handle null', body: '' },
      { sha: 'a3', subject: 'chore: bump version to 1.7.0', body: '' },
      { sha: 'a4', subject: 'docs: update readme', body: '' },
      { sha: 'a5', subject: 'refactor: cleanup', body: '' },
    ];
    const groups = groupReleases(commits);
    expect(groups.features).toHaveLength(1);
    expect(groups.fixes).toHaveLength(1);
    expect(groups.internal).toHaveLength(2);
    expect(groups.features[0].scope).toBe('gmail');
  });
});
