import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { withTempVault } from '../../helpers/vault';
import { exitCodeForError } from '../../../src/utils/errors';
import { formatSource } from '../../../src/plugins/memory/client';
import type { MemoryCredentials } from '../../../src/plugins/memory/types';
import { FakeGraphiti, TOKEN } from './fake-graphiti';

/** The CLI as an agent runs it: a separate process, against fake servers, with its own temp vault. */

let home: FakeGraphiti;
let work: FakeGraphiti;
let vault: ReturnType<typeof withTempVault>;

beforeEach(() => {
  home = new FakeGraphiti();
  work = new FakeGraphiti('other-server-token-abcdefghijklmnop');
});

afterEach(() => {
  home.stop();
  work.stop();
});

interface ProfileSpec { server?: () => FakeGraphiti; token?: string; group?: string; readOnly?: boolean }

function withProfiles(profiles: () => Record<string, ProfileSpec>): void {
  const own = withTempVault('agentio-memory-cli-', () => {
    const entries = Object.entries(profiles());
    return {
      config: { profiles: { memory: entries.map(([name, p]) => ({ name, ...(p.readOnly ? { readOnly: true } : {}) })) } } as never,
      credentials: {
        memory: Object.fromEntries(entries.map(([name, p]): [string, MemoryCredentials] => {
          const server = (p.server ?? (() => home))();
          return [name, { baseUrl: server.url, token: p.token ?? server.token, ...(p.group ? { defaultGroup: p.group } : {}) }];
        })),
      } as never,
    };
  });
  beforeEach(() => { vault = own; });
}

async function cli(args: string[], stdin?: string, env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', 'src/index.ts', ...args], {
    stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...vault.env(), NO_COLOR: '1', ...env },
  });
  const code = await proc.exited;
  return { code, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() };
}

const INVALID = exitCodeForError('INVALID_PARAMS');

describe('profile add', () => {
  withProfiles(() => ({}));

  test('the token from stdin, a positional name and a default group; the token is never printed', async () => {
    const res = await cli(['memory', 'profile', 'add', 'home', '--url', home.url, '--token-stdin', '--group', 'famille'], `${TOKEN}\n`);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Profile "home" configured!');
    expect(res.stdout + res.stderr).not.toContain(TOKEN);
    const list = await cli(['memory', 'profile', 'list']);
    expect(list.stdout).toContain(home.url);
    expect(list.stdout + list.stderr).not.toContain(TOKEN);
  });

  test('the token from AGENTIO_MEMORY_TOKEN', async () => {
    const res = await cli(['memory', 'profile', 'add', '--url', home.url, '--profile', 'envy'], undefined, { AGENTIO_MEMORY_TOKEN: TOKEN });
    expect(res.code).toBe(0);
    expect((await cli(['memory', 'episodes', '--group', 'famille', '--profile', 'envy'])).code).toBe(0);
  });

  test('there is no --token flag; a wrong token saves nothing', async () => {
    const flag = await cli(['memory', 'profile', 'add', '--url', home.url, '--token', TOKEN]);
    expect(flag.code).not.toBe(0);
    const wrong = await cli(['memory', 'profile', 'add', '--url', home.url, '--token-stdin'], 'nope-wrong-token');
    expect(wrong.code).toBe(exitCodeForError('AUTH_FAILED'));
    expect(wrong.stderr).not.toContain('nope-wrong-token');
    expect((await cli(['memory', 'profile', 'list'])).stdout).not.toContain(home.url);
  });

  test('two names that disagree are refused', async () => {
    const res = await cli(['memory', 'profile', 'add', 'a', '--profile', 'b', '--url', home.url, '--token-stdin'], TOKEN);
    expect(res.code).toBe(INVALID);
    expect(home.log).toHaveLength(0);
  });
});

describe('one profile with a default group', () => {
  withProfiles(() => ({ main: { group: 'famille' } }));

  test('add from --text, then from stdin, both traced to their ref', async () => {
    const added = await cli(['memory', 'add', '--ref', '1AbC', '--url', 'https://docs.google.com/document/d/1AbC', '--text', 'Marie lives in Lyon', '--json']);
    expect(added.code).toBe(0);
    const out = JSON.parse(added.stdout);
    expect(out).toMatchObject({ group: 'famille', ref: '1AbC', url: 'https://docs.google.com/document/d/1AbC', queued: true });
    expect(home.episodes[0]).toMatchObject({ uuid: out.uuid, group_id: 'famille', source_description: 'ref:1AbC url:https://docs.google.com/document/d/1AbC', content: '(user): Marie lives in Lyon' });

    const piped = await cli(['memory', 'add', '--ref', 'invoice-7', '--group', 'societes', '--name', 'Invoice 7'], 'Acme SA owes 120 EUR\n');
    expect(piped.code).toBe(0);
    expect(home.episodes[1]).toMatchObject({ group_id: 'societes', name: 'Invoice 7', source_description: 'ref:invoice-7', content: '(user): Acme SA owes 120 EUR' });
  });

  test('add with nothing to remember, or bad values, never reaches the server', async () => {
    for (const args of [
      ['--ref', 'x'],
      ['--ref', 'x', '--text', '  '],
      ['--ref', ' ', '--text', 'y'],
      ['--ref', 'x', '--text', 'y', '--url', 'ftp://h'],
      ['--ref', 'x', '--text', 'y', '--group', 'no spaces'],
      ['--ref', 'x', '--text', 'y', '--time', 'yesterday-ish'],
    ]) {
      expect((await cli(['memory', 'add', ...args])).code).toBe(INVALID);
    }
    expect(home.log).toHaveLength(0);
  });

  test('search shows each fact with its document', async () => {
    const ep = home.seedEpisode('famille', formatSource('1AbC', 'https://example.com/doc'));
    home.seedFact('famille', 'Marie lives in Lyon', [ep]);
    const text = await cli(['memory', 'search', 'where does Marie live']);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('Marie lives in Lyon');
    expect(text.stdout).toContain('From: ref 1AbC https://example.com/doc');
    const json = JSON.parse((await cli(['memory', 'search', 'Lyon', '--limit', '5', '--json'])).stdout);
    expect(json.facts[0].sources).toEqual([{ episode: ep.uuid, ref: '1AbC', url: 'https://example.com/doc' }]);
    expect(home.log.find((r) => r.path === '/search')!.body).toEqual({ group_ids: ['famille'], query: 'where does Marie live', max_facts: 10 });
  });

  test('entity, episodes and forget', async () => {
    const a = home.seedEpisode('famille', formatSource('doc-a'), '(user): Marie works at Acme');
    const b = home.seedEpisode('famille', formatSource('doc-b'));
    home.seedFact('famille', 'Marie works at Acme', [a], ['marie', 'acme']);
    home.seedFact('famille', 'Marie has a sister', [a, b], ['marie', 'sister']);

    const entity = JSON.parse((await cli(['memory', 'entity', 'Marie', '--json'])).stdout);
    expect(entity.node).toBe('marie');
    expect(entity.facts).toHaveLength(2);

    const listed = JSON.parse((await cli(['memory', 'episodes', '--ref', 'doc-a', '--json'])).stdout);
    expect(listed.episodes.map((e: { uuid: string }) => e.uuid)).toEqual([a.uuid]);
    expect(listed.episodes[0].text).toBe('Marie works at Acme');

    // No terminal and no --yes: refused, nothing deleted.
    const unconfirmed = await cli(['memory', 'forget', '--ref', 'doc-a']);
    expect(unconfirmed.code).toBe(INVALID);
    expect(unconfirmed.stderr).toContain('--yes');
    expect(home.episodes).toHaveLength(2);

    const forgot = JSON.parse((await cli(['memory', 'forget', '--ref', 'doc-a', '--yes', '--json'])).stdout);
    expect(forgot).toMatchObject({ ref: 'doc-a', group: 'famille', deletedEpisodes: [a.uuid], failed: [] });
    expect(home.episodes.map((e) => e.uuid)).toEqual([b.uuid]);
    expect(home.facts.map((f) => f.fact)).toEqual(['Marie has a sister']);

    const again = await cli(['memory', 'forget', '--ref', 'doc-a']);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain('Nothing to forget');
  });

  test('there is no command that clears the graph or a group', async () => {
    for (const name of ['clear', 'delete-group', 'reset']) {
      expect((await cli(['memory', name, '--yes'])).code).not.toBe(0);
    }
    expect(home.log.some((r) => r.path === '/clear' || r.path.startsWith('/group/'))).toBe(false);
  });

  test('errors go to stderr, in JSON with --json', async () => {
    home.fail = { status: 500, body: {}, count: 1 };
    const res = await cli(['memory', 'episodes', '--json']);
    expect(res.code).not.toBe(0);
    expect(res.stdout).toContain('"event":"error"');
    expect(res.stdout).toContain('API_ERROR');
  });
});

describe('a profile without a default group', () => {
  withProfiles(() => ({ bare: {} }));

  test('commands that need one group say so; search covers every group', async () => {
    for (const args of [['add', '--ref', 'x', '--text', 'y'], ['episodes'], ['forget', '--ref', 'x', '--yes'], ['entity', 'Marie']]) {
      const res = await cli(['memory', ...args]);
      expect(res.code).toBe(INVALID);
      expect(res.stderr).toContain('No group given');
    }
    expect((await cli(['memory', 'search', 'anything'])).code).toBe(0);
    expect(home.log.find((r) => r.path === '/search')!.body.group_ids).toBeNull();
  });
});

describe('a read-only profile', () => {
  withProfiles(() => ({ ro: { group: 'famille', readOnly: true } }));

  test('reads work; add and forget are refused before any request', async () => {
    expect((await cli(['memory', 'episodes'])).code).toBe(0);
    const before = home.log.length;
    for (const args of [['add', '--ref', 'x', '--text', 'y'], ['forget', '--ref', 'x', '--yes']]) {
      const res = await cli(['memory', ...args]);
      expect(res.code).toBe(exitCodeForError('PERMISSION_DENIED'));
    }
    expect(home.log.length).toBe(before);
  });
});

describe('a profile with a revoked token', () => {
  withProfiles(() => ({ old: { group: 'famille', token: 'revoked-token-value' } }));

  test('says the token was refused, without printing it', async () => {
    const res = await cli(['memory', 'episodes']);
    expect(res.code).toBe(exitCodeForError('AUTH_FAILED'));
    expect(res.stderr).toContain('refused the token');
    expect(res.stderr).not.toContain('revoked-token-value');
  });
});

describe('two profiles on two Graphiti servers', () => {
  withProfiles(() => ({
    home: { server: () => home, group: 'famille' },
    work: { server: () => work, group: 'societes' },
  }));

  test('--profile picks the server, its token and its default group; none given is refused', async () => {
    expect((await cli(['memory', 'add', '--ref', 'h1', '--text', 'home fact', '--profile', 'home'])).code).toBe(0);
    expect((await cli(['memory', 'add', '--ref', 'w1', '--text', 'work fact', '--profile', 'work'])).code).toBe(0);

    expect(home.episodes.map((e) => [e.group_id, e.source_description])).toEqual([['famille', 'ref:h1']]);
    expect(work.episodes.map((e) => [e.group_id, e.source_description])).toEqual([['societes', 'ref:w1']]);
    expect(home.log.every((r) => r.authorization === `Bearer ${home.token}`)).toBe(true);
    expect(work.log.every((r) => r.authorization === `Bearer ${work.token}`)).toBe(true);

    const fromWork = JSON.parse((await cli(['memory', 'episodes', '--profile', 'work', '--json'])).stdout);
    expect(fromWork.episodes.map((e: { ref: string }) => e.ref)).toEqual(['w1']);

    const before = home.log.length + work.log.length;
    const ambiguous = await cli(['memory', 'episodes']);
    expect(ambiguous.code).not.toBe(0);
    expect(home.log.length + work.log.length).toBe(before);
  });
});
