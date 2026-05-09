import { describe, it, expect } from 'bun:test';
import { listVersionTags, listCommitsBetween } from '../git';

describe('listVersionTags', () => {
  it('returns version tags newest-first', async () => {
    const tags = await listVersionTags();
    expect(tags.length).toBeGreaterThan(0);
    expect(tags[0].name).toMatch(/^v?\d+\.\d+\.\d+$/);
    if (tags.length > 1) {
      expect(tags[0].date >= tags[1].date).toBe(true);
    }
  });
});

describe('listCommitsBetween', () => {
  it('returns commits between two refs', async () => {
    const tags = await listVersionTags();
    if (tags.length < 2) return;
    const commits = await listCommitsBetween(tags[1].name, tags[0].name);
    expect(commits.length).toBeGreaterThan(0);
    expect(commits[0]).toHaveProperty('sha');
    expect(commits[0]).toHaveProperty('subject');
  });
});
