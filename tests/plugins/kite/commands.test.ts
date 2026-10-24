import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { withTempVault } from '../../helpers/vault';
import { getCredentials } from '../../../src/auth/token-store';
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
/** A second server, started only by the tests that need one. */
let other: FakeKite | undefined;
/** The vault of the running test's describe. */
let vault: ReturnType<typeof withTempVault>;
const home = () => vault.home();

function creds(server: FakeKite, email = ME): KiteCredentials {
  return { baseUrl: server.url, token: server.issueToken(email), email, expiresAt: '2026-04-01T00:00:00Z' };
}

// The server starts before the vault is seeded, so the seeded credentials point at it.
beforeEach(() => {
  fake = new FakeKite();
});

/**
 * A temp vault holding these Kite profiles, for the tests of the enclosing
 * describe. Registered there so it runs after the servers exist.
 */
function withProfiles(profiles: () => Record<string, { readOnly?: boolean; server: FakeKite }>): void {
  const own = withTempVault('agentio-kite-cli-', () => {
    const entries = Object.entries(profiles());
    return {
      config: { profiles: { kite: entries.map(([name, p]) => ({ name, ...(p.readOnly ? { readOnly: true } : {}) })) } } as never,
      credentials: { kite: Object.fromEntries(entries.map(([name, p]) => [name, creds(p.server)])) } as never,
    };
  });
  beforeEach(() => { vault = own; });
}

afterEach(() => {
  fake.stop();
  other?.stop();
  other = undefined;
});

async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return cliIn(process.cwd(), ...args);
}

/** The CLI run from another folder, for what it writes there. */
async function cliIn(cwd: string, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', join(import.meta.dir, '../../../src/index.ts'), ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...vault.env(), NO_COLOR: '1' },
  });
  const code = await proc.exited;
  return { code, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() };
}

/** Stdout parsed as one JSON document; a second document or any stray text makes it throw. */
function onlyJson(stdout: string): any {
  return JSON.parse(stdout);
}

function file(name: string, content: string): string {
  const path = join(home(), name);
  writeFileSync(path, content);
  return path;
}

describe('one profile', () => {
  withProfiles(() => ({ main: { server: fake } }));

  test('publish, update, get, list, delete in --json mode', async () => {
    const path = file('doc.md', '# One');
    const published = await cli('kite', 'publish', path, '--title', 'First', '--description', 'D.', '--summary', 'S.', '--json');
    expect(published.code).toBe(0);
    const doc = onlyJson(published.stdout);
    expect(Object.keys(doc).sort()).toEqual(
      ['description', 'id', 'summary', 'summaryVersion', 'title', 'type', 'updated', 'url', 'version'],
    );
    expect(doc).toMatchObject({ title: 'First', type: 'markdown', version: 1 });

    writeFileSync(path, '# Two');
    const updated = onlyJson((await cli('kite', 'publish', path, '--id', doc.id, '--json')).stdout);
    expect(updated.version).toBe(2);

    const out = join(home(), 'out.md');
    const [gotRun, savedRun, listRun] = await Promise.all([
      cli('kite', 'get', doc.url, '--json'),
      cli('kite', 'get', doc.id, '--out', out, '--json'),
      cli('kite', 'list', '--json'),
    ]);
    const got = onlyJson(gotRun.stdout);
    expect(got.content).toBe('# Two');
    expect(got.id).toBe(doc.id);

    const saved = onlyJson(savedRun.stdout);
    expect(saved.file).toBe(out);
    expect(saved).not.toHaveProperty('content');
    expect(readFileSync(out, 'utf8')).toBe('# Two');

    const list = onlyJson(listRun.stdout);
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

    // Sharing and comments touch different state, so the two sequences run side by side.
    const sharing = async () => {
      const added = onlyJson((await cli('kite', 'share', 'add', doc.id, 'p@x.com', '--json')).stdout);
      expect(added.notified).toBe(true);
      expect(added.people).toEqual([{ email: 'p@x.com', pending: true }]);
      expect(onlyJson((await cli('kite', 'share', 'add', doc.id, 'example.com', '--json')).stdout).domains).toEqual(['example.com']);
      expect(onlyJson((await cli('kite', 'share', 'remove', doc.id, 'p@x.com', '--json')).stdout).people).toEqual([]);
      expect(onlyJson((await cli('kite', 'share', 'public', doc.id, '--json')).stdout).isPublic).toBe(true);
      expect(onlyJson((await cli('kite', 'share', 'private', doc.id, '--json')).stdout).isPublic).toBe(false);
      expect(onlyJson((await cli('kite', 'share', 'expiry', doc.id, '30d', '--json')).stdout).expiresAt).toBeString();
    };

    const comments = async () => {
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
    };

    await Promise.all([sharing(), comments()]);
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
      cli('kite', 'publish', join(home(), 'missing.md'), '--json'),
      cli('kite', 'share', 'expiry', 'art_1', '30', '--json'),
      cli('kite', 'comments', 'list', 'art_1', '--since', 'soon', '--json'),
      cli('kite', 'comments', 'list', 'art_1', '--status', 'closed', '--json'),
      cli('kite', 'comments', 'add', 'art_1', '--body', ' ', '--json'),
      cli('kite', 'comments', 'add', 'art_1', '--body', 'b', '--heading', 'h', '--json'),
      cli('kite', 'share', 'show', 'https://kite.example/a/slug', '--json'),
      cli('kite', 'publish', file('d.md', 'x'), '--id', 'https://kite.example/a/slug', '--json'),
      cli('kite', 'get', 'art_1', '--out', home(), '--json'),
      cli('kite', 'get', 'art_1', '--out', join(home(), 'no', 'such', 'dir', 'x.md'), '--json'),
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
      cli('kite', 'describe', 'art_1', '--title', 'T', '--json'),
      cli('kite', 'move', 'art_1', 'inbox', '--json'),
      cli('kite', 'workspaces', 'create', 'Research', '--description', 'Papers.', '--json'),
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
      cli('kite', 'workspaces', 'list', '--json'),
      cli('kite', 'organize', '--json'),
    ]);
    for (const r of reads) expect(r.code).toBe(0);
  }, 60_000);
});

describe('two profiles on two servers', () => {
  beforeEach(() => { other = new FakeKite(); });
  withProfiles(() => ({ a: { server: fake }, b: { server: other! } }));

  test('omitting --profile is a clear error, with no request', async () => {
    const r = await cli('kite', 'list', '--json');
    const event = onlyJson(r.stdout);
    expect(event.event).toBe('error');
    expect(event.message).toContain('Multiple kite profiles');
    expect(event.suggestion).toContain('--profile');
    expect(fake.log.length + other!.log.length).toBe(0);
  }, 30_000);

  test('each profile talks only to its own server', async () => {
    const [a, b] = await Promise.all([getCredentials<KiteCredentials>('kite', 'a'), getCredentials<KiteCredentials>('kite', 'b')]);
    await Promise.all([cli('kite', 'list', '--profile', 'a', '--json'), cli('kite', 'list', '--profile', 'b', '--json')]);
    expect(fake.log.map((r) => r.headers.authorization)).toEqual([`Bearer ${a!.token}`]);
    expect(other!.log.map((r) => r.headers.authorization)).toEqual([`Bearer ${b!.token}`]);
  }, 30_000);

  test('no command but profile add takes --url', async () => {
    const r = await cli('kite', 'list', '--profile', 'a', '--url', other!.url);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("unknown option '--url'");
    expect(fake.log.length + other!.log.length).toBe(0);
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

describe('describing and organizing from the command line', () => {
  withProfiles(() => ({ main: { server: fake } }));

  test('a new document without --description sends nothing and says what is missing', async () => {
    const r = await cli('kite', 'publish', file('doc.md', '# x'), '--summary', 'S.', '--json');
    const event = onlyJson(r.stdout);
    expect(event).toMatchObject({ event: 'error', code: 'INVALID_PARAMS' });
    expect(JSON.stringify(event)).toContain('--description');
    expect(fake.requests('POST')).toEqual([]);
  }, 30_000);

  test('--summary and --summary-file together are refused with no request', async () => {
    const summary = file('summary.txt', 'From a file.');
    const r = await cli('kite', 'publish', file('doc.md', '# x'), '--description', 'D.', '--summary', 'S.', '--summary-file', summary, '--json');
    expect(onlyJson(r.stdout)).toMatchObject({ event: 'error', code: 'INVALID_PARAMS' });
    expect(fake.log).toEqual([]);
  }, 30_000);

  test('a --summary-file that does not exist is refused with no request', async () => {
    const r = await cli('kite', 'describe', 'art_1', '--summary-file', join(home(), 'nope.txt'), '--json');
    expect(onlyJson(r.stdout)).toMatchObject({ event: 'error', code: 'INVALID_PARAMS' });
    expect(fake.log).toEqual([]);
  }, 30_000);

  test('the summary file is sent as written, line breaks and all', async () => {
    const doc = fake.seedDoc(ME);
    const summary = 'Line one.\nLine two.\n';
    const r = await cli('kite', 'describe', doc.id, '--summary-file', file('summary.txt', summary), '--json');
    expect(r.code).toBe(0);
    expect(fake.requests('PATCH')[0].body).toEqual({ summary });
    expect(fake.docs.get(doc.id)!.summary).toBe('Line one.\nLine two.');
  }, 30_000);

  test('an update without the flags keeps what the document said', async () => {
    const doc = fake.seedDoc(ME, { description: 'Kept.', summary: 'Kept.' });
    const r = await cli('kite', 'publish', file('doc.md', '# New'), '--id', doc.id, '--json');
    expect(onlyJson(r.stdout)).toMatchObject({ description: 'Kept.', summary: 'Kept.', summaryVersion: 1, version: 2 });
  }, 30_000);

  test('organize --json is one document an agent can read whole', async () => {
    fake.seedWorkspace(ME, 'Research');
    fake.seedDoc(ME, { title: 'A note' });
    const library = onlyJson((await cli('kite', 'organize', '--json')).stdout);
    expect(Object.keys(library).sort()).toEqual(['documents', 'instructions', 'workspaces']);
    expect(library.documents[0]).toMatchObject({ title: 'A note', workspace: 'inbox' });
  }, 30_000);

  test('organize without --json says how stale each summary is', async () => {
    fake.seedDoc(ME, { title: 'Drifted', version: 4, summaryVersion: 1 });
    fake.seedDoc(ME, { title: 'Never described', description: null, summary: null, summaryVersion: null });
    const r = await cli('kite', 'organize');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('written for version 1, 3 versions behind');
    expect(r.stdout).toContain('Summary (missing)');
    expect(r.stdout).toContain('Propose before you change anything');
  }, 30_000);

  test('move by name, then back to the inbox', async () => {
    const research = fake.seedWorkspace(ME, 'Research');
    const doc = fake.seedDoc(ME);
    expect(onlyJson((await cli('kite', 'move', doc.id, 'research', '--json')).stdout)).toEqual({ id: doc.id, workspace: research.id });
    expect(onlyJson((await cli('kite', 'move', doc.id, 'inbox', '--json')).stdout)).toEqual({ id: doc.id, workspace: 'inbox' });
  }, 30_000);

  test('workspaces create needs a description', async () => {
    const r = await cli('kite', 'workspaces', 'create', 'Research', '--json');
    expect(r.code).not.toBe(0);
    expect(fake.log).toEqual([]);
  }, 30_000);
});

describe('versions and views from the command line', () => {
  withProfiles(() => ({ main: { server: fake } }));

  test('versions lists by default, versions get reads one, --out saves it', async () => {
    const doc = fake.seedDoc(ME, { content: '# One', title: 'Plan' });
    fake.seedEdit(doc, '# Two');
    const out = join(home(), 'v1.md');
    const [listed, explicit, text, got, saved] = await Promise.all([
      cli('kite', 'versions', doc.id, '--json'),
      cli('kite', 'versions', 'list', `${fake.url}/a/${doc.slug}`, '--json'),
      cli('kite', 'versions', doc.id),
      cli('kite', 'versions', 'get', doc.id, '1', '--json'),
      cli('kite', 'versions', 'get', doc.id, '1', '--out', out, '--json'),
    ]);
    expect(listed.code).toBe(0);
    expect(onlyJson(listed.stdout).versions.map((v: any) => [v.version, v.current])).toEqual([[2, true], [1, false]]);
    expect(onlyJson(explicit.stdout).id).toBe(doc.id);
    expect(text.stdout).toContain('v2 (current)  Plan');
    expect(text.stdout).toContain(`agentio kite versions get ${doc.id} <n>`);
    expect(onlyJson(got.stdout)).toMatchObject({ content: '# One', version: 1, currentVersion: 2, current: false });
    const savedJson = onlyJson(saved.stdout);
    expect(savedJson).toMatchObject({ file: out, version: 1 });
    expect(savedJson).not.toHaveProperty('content');
    expect(readFileSync(out, 'utf8')).toBe('# One');
  }, 30_000);

  test('against a Kite without version history, a clear error and a non-zero exit', async () => {
    fake.versionsApi = false;
    const doc = fake.seedDoc(ME);
    const res = await cli('kite', 'versions', doc.id);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('does not have version history yet');
    expect(res.stderr).toContain('Kite 1.3.0 or later');
    expect(res.stdout).toBe('');
  }, 30_000);

  test('views with an id shows one document, without shows them all', async () => {
    const doc = fake.seedDoc(ME, { title: 'Plan' });
    fake.seedOpen(doc, ME);
    fake.seedOpen(doc, 'p@x.com');
    const [one, all, allText] = await Promise.all([
      cli('kite', 'views', doc.id, '--json'),
      cli('kite', 'views', '--json'),
      cli('kite', 'views'),
    ]);
    expect(onlyJson(one.stdout)).toMatchObject({ id: doc.id, views: 2, ownerViews: 1, otherViews: 1 });
    expect(onlyJson(all.stdout).documents).toEqual([expect.objectContaining({ id: doc.id, views: 2 })]);
    expect(allText.stdout).toContain('Plan (version 1)');
    expect(allText.stdout).toContain('2 views (1 yours, 1 others)');
  }, 30_000);
});

describe('canvases from the command line', () => {
  withProfiles(() => ({ main: { server: fake } }));

  test('create, add, connect, outline, a stale version, versions get, restore', async () => {
    const created = onlyJson((await cli('kite', 'canvas', 'create', '--title', 'Board', '--description', 'D.', '--summary', 'S.', '--json')).stdout);
    expect(created).toMatchObject({ type: 'canvas', version: 1 });

    const added = await cli('kite', 'canvas', 'add', created.id, '--text', 'Ship it', '--at', '0,-40', '--json');
    expect(added.code).toBe(0);
    const n1 = onlyJson(added.stdout).ids.new;
    const second = onlyJson((await cli('kite', 'canvas', 'add', created.id, '--link', 'https://jsoncanvas.org', '--near', n1, '--json')).stdout);
    expect(second.version).toBe(3);
    const n2 = second.ids.new;
    expect(fake.requests('POST', `/api/artifacts/${created.id}/canvas/ops`)[1].body).toEqual({
      baseVersion: 2, ops: [{ op: 'add', tempId: 'new', near: n1, side: 'right', node: { type: 'link', url: 'https://jsoncanvas.org' } }],
    });

    const connected = await cli('kite', 'canvas', 'connect', created.id, n1, n2, '--label', 'then', '--base-version', '3');
    expect(connected.code).toBe(0);
    expect(connected.stdout).toContain(`${created.id} is at version 4 now.`);

    const moved = await cli('kite', 'canvas', 'move', '--json', '--', created.id, n1, '-200', '-80');
    expect(onlyJson(moved.stdout).version).toBe(5);

    const outline = await cli('kite', 'canvas', 'outline', created.id);
    expect(outline.stdout).toContain(`${created.id}, version 5: 2 nodes (0 groups), 1 edges`);
    expect(outline.stdout).toContain(`- ${n1} [text] Ship it  (260×140 at -200,-80)`);

    const stale = await cli('kite', 'canvas', 'delete', created.id, n2, '--base-version', '3');
    expect(stale.code).not.toBe(0);
    expect(stale.stderr).toContain('changed since version 3: it is at version 5 now');
    expect(stale.stderr).toContain('--base-version 5');

    const old = onlyJson((await cli('kite', 'canvas', 'versions', 'get', created.id, '2')).stdout);
    expect(old).toMatchObject({ version: 2, currentVersion: 5 });
    expect(old.nodes.length).toBe(1);
    expect(fake.requests('GET', `/api/artifacts/${created.id}/versions/2`)[0].query).toEqual({ record: 'false' });

    const restored = await cli('kite', 'canvas', 'restore', created.id, '2');
    expect(restored.stdout).toContain(`${created.id} is at version 6 now, the same as version 2.`);
  });

  test('ops needs a version and reads it from the file when it has one', async () => {
    const doc = fake.seedDoc(ME, { type: 'canvas', content: JSON.stringify({ nodes: [{ id: 'n1', type: 'text', text: 'A', x: 0, y: 0, width: 260, height: 140 }], edges: [] }) });
    const missing = await cli('kite', 'canvas', 'ops', doc.id, '--ops', '[{"op":"delete","id":"n1"}]');
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain('--base-version');
    expect(fake.requests('POST').length).toBe(0);

    const path = file('ops.json', JSON.stringify({ baseVersion: 1, ops: [{ op: 'update', id: 'n1', set: { text: 'B' } }] }));
    const dry = await cli('kite', 'canvas', 'ops', doc.id, path, '--dry-run');
    expect(dry.stdout).toContain('Dry run');
    expect(doc.version).toBe(1);
    expect(onlyJson((await cli('kite', 'canvas', 'ops', doc.id, path, '--json')).stdout).version).toBe(2);
  });

  test('add needs exactly one kind of node, before any request', async () => {
    const doc = fake.seedDoc(ME, { type: 'canvas', content: '{"nodes":[],"edges":[]}' });
    const both = await cli('kite', 'canvas', 'add', doc.id, '--text', 'A', '--link', 'https://x.example');
    expect(both.code).not.toBe(0);
    expect(both.stderr).toContain('Give one of --text, --link, --doc or --group');
    expect(fake.log.length).toBe(0);
  });
});

describe('how a canvas looks, from the command line', () => {
  withProfiles(() => ({ main: { server: fake } }));

  const seed = () => fake.seedDoc(ME, {
    type: 'canvas',
    content: JSON.stringify({
      nodes: [
        { id: 'n1', type: 'text', text: 'A', x: 0, y: 0, width: 260, height: 140, kite: { style: { fill: '#ffffff', radius: 8 } } },
        { id: 'n2', type: 'text', text: 'B', x: 400, y: 0, width: 260, height: 140 },
      ],
      edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n2' }],
    }),
  });
  const lastOps = (id: string) => (fake.requests('POST', `/api/artifacts/${id}/canvas/ops`).at(-1)!.body as { ops: unknown[] }).ops;

  test('add takes style and a Lucide icon, in the node\'s kite', async () => {
    const doc = seed();
    const added = await cli('kite', 'canvas', 'add', doc.id, '--text', 'API', '--fill', '#eef4ff', '--border', '3', '--border-width', '2',
      '--font', 'grotesk', '--weight', '600', '--align', 'center', '--shadow', 'md', '--icon', 'lucide:server', '--icon-position', 'top', '--icon-size', '40', '--json');
    expect(added.code).toBe(0);
    expect(lastOps(doc.id)).toEqual([{
      op: 'add', tempId: 'new',
      node: {
        type: 'text', text: 'API',
        kite: {
          style: { fill: '#eef4ff', borderColor: '3', borderWidth: 2, font: 'grotesk', fontWeight: 600, textAlign: 'center', shadow: 'md' },
          icon: { name: 'lucide:server', position: 'top', size: 40 },
        },
      },
    }]);
  });

  test('--icon-svg sends the file as an asset first, and the node names it by its tempId', async () => {
    const doc = seed();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>';
    const path = file('logo.svg', svg);
    const added = onlyJson((await cli('kite', 'canvas', 'add', doc.id, '--text', 'Acme', '--icon-svg', path, '--json')).stdout);
    expect(lastOps(doc.id)).toEqual([
      { op: 'addAsset', tempId: 'icon', svg, name: 'logo' },
      { op: 'add', tempId: 'new', node: { type: 'text', text: 'Acme', kite: { icon: { name: 'asset:icon' } } } },
    ]);
    const asset = added.ids.icon;
    expect(asset).toMatch(/^a/);
    const got = onlyJson((await cli('kite', 'canvas', 'get', doc.id)).stdout);
    expect(got.kite.assets[asset]).toMatchObject({ type: 'svg', name: 'logo' });
    expect(got.nodes.find((n: { id: string }) => n.id === added.ids.new).kite.icon).toEqual({ name: `asset:${asset}` });
    expect(got.kite).not.toHaveProperty('docId');

    const reused = await cli('kite', 'canvas', 'update', doc.id, 'n2', '--icon', `asset:${asset}`);
    expect(reused.code).toBe(0);
    expect(lastOps(doc.id)).toEqual([{ op: 'update', id: 'n2', set: { kite: { icon: { name: `asset:${asset}` } } } }]);
  });

  test('update merges style, unsets keys, and styles edges', async () => {
    const doc = seed();
    expect((await cli('kite', 'canvas', 'update', doc.id, 'n1', '--text-color', '#111111', '--unset', 'style.fill', 'icon')).code).toBe(0);
    expect(lastOps(doc.id)).toEqual([{ op: 'update', id: 'n1', set: { kite: { style: { fill: null, textColor: '#111111' }, icon: null } } }]);
    const n1 = fake.canvasOf(doc).nodes[0];
    expect(n1.kite.style).toEqual({ radius: 8, textColor: '#111111' });

    expect((await cli('kite', 'canvas', 'update', doc.id, 'n1', '--unset', 'style')).code).toBe(0);
    expect(lastOps(doc.id)).toEqual([{ op: 'update', id: 'n1', set: { kite: { style: null } } }]);

    expect((await cli('kite', 'canvas', 'update', doc.id, 'e1', '--color', '5', '--dashed', '--curve', 'step', '--line-width', '3', '--arrow', 'both')).code).toBe(0);
    expect(lastOps(doc.id)).toEqual([{
      op: 'update', id: 'e1',
      set: { color: '5', fromEnd: 'arrow', toEnd: 'arrow', kite: { style: { width: 3, line: 'dashed', curve: 'step' } } },
    }]);
  });

  test('connect takes colour, line and label style', async () => {
    const doc = seed();
    expect((await cli('kite', 'canvas', 'connect', doc.id, 'n2', 'n1', '--label', 'reads', '--color', '#8a5cf6', '--dotted', '--curve', 'straight',
      '--label-color', '#444444', '--arrow', 'none')).code).toBe(0);
    expect(lastOps(doc.id)).toEqual([{
      op: 'connect', from: 'n2', to: 'n1', tempId: 'edge', label: 'reads', color: '#8a5cf6', fromEnd: 'none', toEnd: 'none',
      kite: { style: { line: 'dotted', curve: 'straight', labelColor: '#444444' } },
    }]);
  });

  test('theme merges a file with flags, and --reset removes it', async () => {
    const doc = seed();
    const path = file('theme.json', JSON.stringify({ background: '#000000', node: { radius: 4, font: 'serif' }, group: { labelWeight: 700 } }));
    const set = await cli('kite', 'canvas', 'theme', doc.id, '--from', path, '--background', '#f7f5ef', '--grid', 'dots', '--font', 'inter',
      '--group-fill', '#ffffff80', '--curve', 'step', '--edge-color', '4');
    expect(set.code).toBe(0);
    expect(lastOps(doc.id)).toEqual([{
      op: 'theme',
      set: {
        background: '#f7f5ef', grid: 'dots',
        node: { radius: 4, font: 'inter' },
        group: { labelWeight: 700, fill: '#ffffff80' },
        edge: { curve: 'step', color: '4' },
      },
    }]);
    expect(onlyJson((await cli('kite', 'canvas', 'get', doc.id)).stdout).kite.theme.grid).toBe('dots');

    expect((await cli('kite', 'canvas', 'theme', doc.id, '--reset')).code).toBe(0);
    expect(lastOps(doc.id)).toEqual([{ op: 'theme', set: null }]);
    expect(onlyJson((await cli('kite', 'canvas', 'get', doc.id)).stdout)).not.toHaveProperty('kite');
  });

  test('a bad value is refused before any request, and says what fits', async () => {
    const doc = seed();
    const cases: Array<[string[], string]> = [
      [['add', doc.id, '--text', 'A', '--fill', 'red'], 'Not a colour for --fill: red'],
      [['add', doc.id, '--text', 'A', '--font', 'comic'], 'Not a value for --font: comic'],
      [['add', doc.id, '--text', 'A', '--icon', 'server'], 'Not an icon: server'],
      [['add', doc.id, '--text', 'A', '--icon-size', '400', '--icon', 'lucide:x'], 'Not a value for --icon-size: 400'],
      [['add', doc.id, '--text', 'A', '--icon-position', 'top'], 'Which icon?'],
      [['connect', doc.id, 'n1', 'n2', '--dashed', '--dotted'], 'Give one of --line, --dashed or --dotted'],
      [['connect', doc.id, 'n1', 'n2', '--curve', 'wavy'], 'Not a value for --curve: wavy'],
      [['theme', doc.id], 'Nothing to change'],
      [['theme', doc.id, '--reset', '--grid', 'dots'], '--reset removes the theme'],
    ];
    for (const [args, said] of cases) {
      const res = await cli('kite', 'canvas', ...args);
      expect(res.code).not.toBe(0);
      expect(res.stderr).toContain(said);
    }
    expect(fake.requests('POST').length).toBe(0);
  });
});

describe('canvases on a read-only profile', () => {
  withProfiles(() => ({ ro: { readOnly: true, server: fake } }));

  test('reads work, changes are refused before any request', async () => {
    const doc = fake.seedDoc(ME, { type: 'canvas', content: '{"nodes":[],"edges":[]}' });
    expect((await cli('kite', 'canvas', 'outline', doc.id)).code).toBe(0);
    const refused = await cli('kite', 'canvas', 'add', doc.id, '--text', 'A');
    expect(refused.code).not.toBe(0);
    expect(fake.requests('POST').length).toBe(0);
  });
});

describe('a canvas as an image, from the command line', () => {
  withProfiles(() => ({ main: { server: fake } }));

  const seed = () => fake.seedDoc(ME, {
    type: 'canvas', title: 'Launch plan',
    content: JSON.stringify({ nodes: [{ id: 'n1', type: 'text', text: 'A', x: 0, y: 0, width: 260, height: 140 }], edges: [] }),
  });
  const folder = (name: string) => {
    const path = join(home(), name);
    mkdirSync(path, { recursive: true });
    return path;
  };

  test('writes <title>.png in the current folder and prints its path', async () => {
    const doc = seed();
    const here = folder('here');
    const done = await cliIn(here, 'kite', 'canvas', 'image', doc.id);
    expect(done.code).toBe(0);
    expect(done.stdout.trim()).toBe(join(here, 'Launch plan.png'));
    expect([...readFileSync(join(here, 'Launch plan.png')).subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  test('-o names the file, and its extension chooses the format; a folder takes the titled file', async () => {
    const doc = seed();
    const out = join(home(), 'board.svg');
    const named = onlyJson((await cli('kite', 'canvas', 'image', doc.id, '-o', out, '--node', 'n1', '--scale', '3', '--transparent', '--json')).stdout);
    expect(named).toMatchObject({ id: doc.id, version: 1, format: 'svg', file: out, origin: { x: -32, y: -32 } });
    expect(readFileSync(out, 'utf8')).toStartWith('<svg');
    expect(fake.requests('GET', `/api/artifacts/${doc.id}/canvas/image`)[0].query)
      .toEqual({ format: 'svg', node: 'n1', scale: '3', background: 'transparent' });

    const into = folder('images');
    // --version is the command's own, not agentio's version, which comes before the command.
    const inFolder = await cli('kite', 'canvas', 'image', doc.id, '--out', into, '--format', 'svg', '--version', '1');
    expect(inFolder.stdout.trim()).toBe(join(into, 'Launch plan.svg'));
    expect(fake.requests('GET', `/api/artifacts/${doc.id}/canvas/image`)[1].query).toEqual({ format: 'svg', version: '1' });
    expect((await cli('--version')).stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('a format the file name contradicts, or an unknown one, is refused before asking Kite', async () => {
    const doc = seed();
    const clash = await cli('kite', 'canvas', 'image', doc.id, '-o', join(home(), 'a.png'), '--format', 'svg');
    expect(clash.code).not.toBe(0);
    expect(clash.stderr).toContain('--format svg does not match');
    const unknown = await cli('kite', 'canvas', 'image', doc.id, '--format', 'jpg');
    expect(unknown.stderr).toContain('Not an image format: jpg');
    const nowhere = await cli('kite', 'canvas', 'image', doc.id, '-o', join(home(), 'missing', 'a.png'));
    expect(nowhere.stderr).toContain('its folder does not exist');
    expect(fake.requests('GET', `/api/artifacts/${doc.id}/canvas/image`).length).toBe(0);
  });

  test('says which Kite it needs', async () => {
    const help = await cli('kite', 'canvas', 'image', '--help');
    expect(help.stdout).toContain('Needs Kite 1.6.0 or later.');
    const list = await cli('kite', 'canvas', '--help');
    expect(list.stdout).toMatch(/image .*\(Kite 1\.6\.0\+\)/);
  });
});
