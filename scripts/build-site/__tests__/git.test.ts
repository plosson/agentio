import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { listCommitsBetween, listCommitsUpTo, listVersionTags } from '../git';

/**
 * Against a throwaway repository, so the outcome does not depend on the
 * checkout the tests run in (a shallow CI clone, a fork with no tags).
 */

let repo = '';

/** Runs git in the fixture repo; `date` pins author, committer, and tagger dates. */
async function sh(args: string[], date = '2026-01-01T00:00:00Z'): Promise<void> {
  const proc = Bun.spawn(['git', ...args], {
    cwd: repo,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x',
      GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date,
    },
  });
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(' ')}: ${await new Response(proc.stderr).text()}`);
}

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), 'agentio-git-test-'));
  await sh(['init', '-q', '-b', 'main']);
  await sh(['commit', '-q', '--allow-empty', '-m', 'first']);
  await sh(['tag', '-a', 'v1.0.0', '-m', 'v1.0.0']);
  await sh(['tag', 'not-a-version']);
  await sh(['commit', '-q', '--allow-empty', '-m', 'second', '-m', 'with a body']);
  await sh(['commit', '-q', '--allow-empty', '-m', 'third'], '2026-01-02T00:00:00Z');
  await sh(['tag', '-a', 'v1.1.0', '-m', 'v1.1.0'], '2026-01-02T00:00:00Z');
});

afterAll(() => rm(repo, { recursive: true, force: true }));

describe('listVersionTags', () => {
  it('returns only version tags, newest first', async () => {
    const tags = await listVersionTags(repo);
    expect(tags.map((t) => t.name)).toEqual(['v1.1.0', 'v1.0.0']);
    expect(tags[0].date >= tags[1].date).toBe(true);
  });
});

describe('listCommitsBetween', () => {
  it('returns the commits between two refs with subject and body', async () => {
    const commits = await listCommitsBetween('v1.0.0', 'v1.1.0', repo);
    expect(commits.map((c) => c.subject)).toEqual(['third', 'second']);
    expect(commits[1].body).toBe('with a body');
    expect(commits[0].sha).toMatch(/^[0-9a-f]{7,}$/);
  });

  it('listCommitsUpTo includes everything reachable', async () => {
    expect((await listCommitsUpTo('v1.1.0', repo)).map((c) => c.subject)).toEqual(['third', 'second', 'first']);
  });
});
