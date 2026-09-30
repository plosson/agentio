import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { withTempVault } from '../../helpers/vault';
import { createProgram } from '../../../src/cli';
import { collectCommands } from '../../../src/utils/command-tree';
import { generateSkill } from '../../../src/commands/skill';
import { exitCodeForError } from '../../../src/utils/errors';
import type { KiteCredentials } from '../../../src/plugins/kite/types';
import { FakeKite } from './fake-kite';

/**
 * The CLI as an agent runs it: a separate process, against the fake Kite,
 * with an environment that can only reach the test's own temp vault.
 */

const ME = 'me@example.com';
let fake: FakeKite;
let other: FakeKite;
let home = '';

function creds(server: FakeKite, email = ME): KiteCredentials {
  return { baseUrl: server.url, token: server.issueToken(email), email, expiresAt: '2026-04-01T00:00:00Z' };
}

// Servers start before the vault is seeded, so the seeded credentials point at them.
beforeEach(() => {
  fake = new FakeKite();
  other = new FakeKite();
});

/**
 * A temp vault holding these Kite profiles, for the tests of the enclosing
 * describe. Registered there so it runs after the servers exist.
 */
function withProfiles(profiles: () => Record<string, { readOnly?: boolean; server: FakeKite }>): void {
  const vault = withTempVault('agentio-kite-cli-', () => {
    const entries = Object.entries(profiles());
    return {
      config: { profiles: { kite: entries.map(([name, p]) => ({ name, ...(p.readOnly ? { readOnly: true } : {}) })) } } as never,
      credentials: { kite: Object.fromEntries(entries.map(([name, p]) => [name, creds(p.server)])) } as never,
    };
  });
  beforeEach(() => { home = vault.home(); });
}

afterEach(() => {
  fake.stop();
  other.stop();
});

/** Never run or write anything without a temp home: an empty one would mean the repo folder. */
function requireHome(): string {
  if (!home.startsWith(tmpdir())) throw new Error(`no temp home for this test: "${home}"`);
  return home;
}

async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const home = requireHome();
  const proc = Bun.spawn(['bun', 'run', 'src/index.ts', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PATH: process.env.PATH,
      HOME: home,
      AGENTIO_HOME: join(home, '.config', 'agentio'),
      AGENTIO_TOKEN: '',
      AGENTIO_PASSPHRASE: process.env.AGENTIO_PASSPHRASE,
      NO_COLOR: '1',
    },
  });
  const code = await proc.exited;
  return { code, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() };
}

/** Stdout must be exactly one JSON document. */
function onlyJson(stdout: string): any {
  return JSON.parse(stdout);
}

function file(name: string, content: string): string {
  const path = join(requireHome(), name);
  writeFileSync(path, content);
  return path;
}

describe('one profile', () => {
  withProfiles(() => ({ main: { server: fake } }));

  test('publish, update, get, list, delete in --json mode', async () => {
    const path = file('doc.md', '# One');
    const published = await cli('kite', 'publish', path, '--title', 'First', '--json');
    expect(published.code).toBe(0);
    const doc = onlyJson(published.stdout);
    expect(Object.keys(doc).sort()).toEqual(['id', 'title', 'type', 'updated', 'url', 'version']);
    expect(doc).toMatchObject({ title: 'First', type: 'markdown', version: 1 });

    writeFileSync(path, '# Two');
    const updated = onlyJson((await cli('kite', 'publish', path, '--id', doc.id, '--json')).stdout);
    expect(updated.version).toBe(2);

    const got = onlyJson((await cli('kite', 'get', doc.url, '--json')).stdout);
    expect(got.content).toBe('# Two');
    expect(got.id).toBe(doc.id);

    const out = join(home, 'out.md');
    const saved = onlyJson((await cli('kite', 'get', doc.id, '--out', out, '--json')).stdout);
    expect(saved.file).toBe(out);
    expect(saved).not.toHaveProperty('content');
    expect(readFileSync(out, 'utf8')).toBe('# Two');

    const list = onlyJson((await cli('kite', 'list', '--json')).stdout);
    expect(list).toEqual({ documents: [expect.objectContaining({ id: doc.id })] });
    expect(list.documents[0]).not.toHaveProperty('content');

    const deleted = await cli('kite', 'delete', doc.id, '--confirm', '--json');
    expect(onlyJson(deleted.stdout)).toEqual({ id: doc.id, deleted: true });
    expect(fake.docs.size).toBe(0);
  }, 30_000);

  test('sharing and comments in --json mode', async () => {
    const doc = fake.seedDoc(ME);
    const shown = await cli('kite', 'share', 'show', doc.id, '--json');
    expect(onlyJson(shown.stdout)).toEqual({ id: doc.id, isPublic: false, people: [], domains: [], expiresAt: null });

    const added = onlyJson((await cli('kite', 'share', 'add', doc.id, 'p@x.com', '--json')).stdout);
    expect(added.notified).toBe(true);
    expect(added.people).toEqual([{ email: 'p@x.com', pending: true }]);
    expect(onlyJson((await cli('kite', 'share', 'add', doc.id, 'example.com', '--json')).stdout).domains).toEqual(['example.com']);
    expect(onlyJson((await cli('kite', 'share', 'remove', doc.id, 'p@x.com', '--json')).stdout).people).toEqual([]);
    expect(onlyJson((await cli('kite', 'share', 'public', doc.id, '--json')).stdout).isPublic).toBe(true);
    expect(onlyJson((await cli('kite', 'share', 'private', doc.id, '--json')).stdout).isPublic).toBe(false);
    expect(onlyJson((await cli('kite', 'share', 'expiry', doc.id, '30d', '--json')).stdout).expiresAt).toBeString();

    const thread = onlyJson((await cli('kite', 'comments', 'add', doc.id, '--body', 'Why?', '--snippet', 'exact rendered text', '--json')).stdout);
    expect(thread.mentions).toEqual({ notified: [], shared: [], awaitingAccess: [] });
    expect(thread.anchor).toEqual({ snippet: 'exact rendered text' });
    const reply = onlyJson((await cli('kite', 'comments', 'reply', thread.id, '--body', 'Because', '--json')).stdout);
    expect(reply.body).toBe('Because');
    expect(onlyJson((await cli('kite', 'comments', 'resolve', thread.id, '--json')).stdout).status).toBe('resolved');
    expect(onlyJson((await cli('kite', 'comments', 'reopen', thread.id, '--json')).stdout).status).toBe('open');
    const listed = onlyJson((await cli('kite', 'comments', 'list', doc.id, '--status', 'open', '--json')).stdout);
    expect(listed.threads).toHaveLength(1);
    expect(Object.keys(listed.threads[0]).sort()).toEqual(['anchor', 'anchorDrifted', 'anchorLost', 'comments', 'id', 'status']);
    expect(listed.threads[0].comments.map((c: { body: string }) => c.body)).toEqual(['Why?', 'Because']);
  }, 30_000);

  test('human output goes to stdout and never says artifact', async () => {
    const doc = fake.seedDoc(ME, { title: 'Plan' });
    const outputs = await Promise.all([
      cli('kite', 'list'),
      cli('kite', 'get', doc.id),
      cli('kite', 'share', 'show', doc.id),
      cli('kite', 'comments', 'list', doc.id),
    ]);
    for (const o of outputs) {
      expect(o.code).toBe(0);
      expect(o.stdout.toLowerCase()).not.toContain('artifact');
    }
    expect(outputs[1].stdout).toContain('# Hello');
  }, 30_000);

  test('errors in --json mode are one event with the right exit code', async () => {
    const missing = await cli('kite', 'get', 'art_missing', '--json');
    expect(onlyJson(missing.stdout)).toMatchObject({ v: 1, event: 'error', code: 'NOT_FOUND' });
    expect(missing.code).toBe(exitCodeForError('NOT_FOUND'));

    const doc = fake.seedDoc(ME);
    const path = file('c.md', 'x');
    fake.after((r) => r.method === 'GET', () => { doc.version = 9; });
    const conflict = await cli('kite', 'publish', path, '--id', doc.id, '--json');
    expect(onlyJson(conflict.stdout)).toMatchObject({ event: 'error', code: 'API_ERROR' });
    expect(onlyJson(conflict.stdout).message).toContain('Someone changed this document');
    expect(conflict.code).toBe(5);
  }, 30_000);

  test('local refusals make no request', async () => {
    const txt = file('notes.txt', 'x');
    const runs = await Promise.all([
      cli('kite', 'delete', 'art_1', '--json'),
      cli('kite', 'publish', txt, '--json'),
      cli('kite', 'publish', join(home, 'missing.md'), '--json'),
      cli('kite', 'share', 'expiry', 'art_1', '30', '--json'),
      cli('kite', 'comments', 'list', 'art_1', '--since', 'soon', '--json'),
      cli('kite', 'comments', 'list', 'art_1', '--status', 'closed', '--json'),
      cli('kite', 'comments', 'add', 'art_1', '--body', ' ', '--json'),
      cli('kite', 'comments', 'add', 'art_1', '--body', 'b', '--heading', 'h', '--json'),
      cli('kite', 'share', 'show', 'https://kite.example/a/slug', '--json'),
      cli('kite', 'publish', file('d.md', 'x'), '--id', 'https://kite.example/a/slug', '--json'),
      cli('kite', 'get', 'art_1', '--out', home, '--json'),
      cli('kite', 'get', 'art_1', '--out', join(home, 'no', 'such', 'dir', 'x.md'), '--json'),
    ]);
    for (const r of runs) {
      expect(r.code).not.toBe(0);
      expect(onlyJson(r.stdout)).toMatchObject({ event: 'error', code: 'INVALID_PARAMS' });
    }
    expect(fake.log).toEqual([]);
  }, 30_000);

  test('get --out replaces an existing file', async () => {
    const doc = fake.seedDoc(ME, { content: 'fresh' });
    const out = file('existing.md', 'stale');
    expect((await cli('kite', 'get', doc.id, '--out', out)).code).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe('fresh');
  }, 30_000);

  test('a token revoked on the server is AUTH_EXPIRED with the reauth suggestion', async () => {
    fake.tokens.clear();
    const r = await cli('kite', 'list', '--json');
    expect(onlyJson(r.stdout)).toMatchObject({ event: 'error', code: 'AUTH_EXPIRED', suggestion: expect.stringContaining('agentio profile reauth kite') });
    expect(r.code).toBe(2);
  }, 30_000);

  test('an unknown profile is PROFILE_NOT_FOUND', async () => {
    const r = await cli('kite', 'list', '--profile', 'nope', '--json');
    expect(onlyJson(r.stdout)).toMatchObject({ event: 'error', code: 'PROFILE_NOT_FOUND' });
    expect(fake.log).toEqual([]);
  }, 30_000);
});

describe('read-only profile', () => {
  withProfiles(() => ({ ro: { readOnly: true, server: fake } }));

  test('every write command is refused with no request; reads work', async () => {
    const path = file('doc.md', 'x');
    const writes = await Promise.all([
      cli('kite', 'publish', path, '--json'),
      cli('kite', 'publish', path, '--id', 'art_1', '--json'),
      cli('kite', 'delete', 'art_1', '--confirm', '--json'),
      cli('kite', 'share', 'add', 'art_1', 'a@b.com', '--json'),
      cli('kite', 'share', 'remove', 'art_1', 'a@b.com', '--json'),
      cli('kite', 'share', 'public', 'art_1', '--json'),
      cli('kite', 'share', 'private', 'art_1', '--json'),
      cli('kite', 'share', 'expiry', 'art_1', '1d', '--json'),
      cli('kite', 'comments', 'add', 'art_1', '--body', 'x', '--json'),
      cli('kite', 'comments', 'reply', 'thr_1', '--body', 'x', '--json'),
      cli('kite', 'comments', 'resolve', 'thr_1', '--json'),
      cli('kite', 'comments', 'reopen', 'thr_1', '--json'),
    ]);
    for (const r of writes) {
      const event = onlyJson(r.stdout);
      expect(event).toMatchObject({ event: 'error', code: 'PERMISSION_DENIED' });
      expect(event.message).toContain('read-only');
      expect(r.code).toBe(2);
    }
    expect(fake.log).toEqual([]);

    const doc = fake.seedDoc(ME);
    const reads = await Promise.all([
      cli('kite', 'list', '--json'),
      cli('kite', 'get', doc.id, '--json'),
      cli('kite', 'share', 'show', doc.id, '--json'),
      cli('kite', 'comments', 'list', doc.id, '--json'),
    ]);
    for (const r of reads) expect(r.code).toBe(0);
  }, 60_000);
});

describe('two profiles on two servers', () => {
  withProfiles(() => ({ a: { server: fake }, b: { server: other } }));

  test('omitting --profile is a clear error, with no request', async () => {
    const r = await cli('kite', 'list', '--json');
    const event = onlyJson(r.stdout);
    expect(event.event).toBe('error');
    expect(event.message).toContain('Multiple kite profiles');
    expect(event.suggestion).toContain('--profile');
    expect(fake.log.length + other.log.length).toBe(0);
  }, 30_000);

  test('each profile talks only to its own server', async () => {
    await cli('kite', 'list', '--profile', 'a', '--json');
    expect(fake.log.length).toBe(1);
    expect(other.log.length).toBe(0);
    await cli('kite', 'list', '--profile', 'b', '--json');
    expect(fake.log.length).toBe(1);
    expect(other.log.length).toBe(1);
  }, 30_000);

  test('no command but profile add takes --url', async () => {
    const r = await cli('kite', 'list', '--profile', 'a', '--url', other.url);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("unknown option '--url'");
    expect(fake.log.length + other.log.length).toBe(0);
  }, 30_000);
});

describe('name hygiene', () => {
  test('help and the generated skill never say artifact', () => {
    const program = createProgram();
    const kiteCommands = collectCommands(program, 'agentio').filter((c) => c.fullPath.startsWith('agentio kite'));
    expect(kiteCommands.length).toBeGreaterThan(15);
    const texts: string[] = [];
    const walk = (cmd: import('commander').Command) => {
      texts.push(cmd.helpInformation());
      for (const sub of cmd.commands) walk(sub);
    };
    walk(program.commands.find((c) => c.name() === 'kite')!);
    texts.push(generateSkill(program, 'kite'));
    for (const text of texts) expect(text.toLowerCase()).not.toContain('artifact');
    for (const c of kiteCommands) {
      if (!c.fullPath.includes(' profile ')) {
        expect(c.options.some((o) => o.flags.includes('--url'))).toBe(false);
      }
    }
  });
});
