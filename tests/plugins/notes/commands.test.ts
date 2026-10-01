import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { withTempVault } from '../../helpers/vault';
import { exitCodeForError } from '../../../src/utils/errors';
import type { NotesCredentials } from '../../../src/plugins/notes/types';
import { FakeNotes, KEY } from './fake-notes';

/**
 * The CLI as an agent runs it: a separate process, against the fake server,
 * with an environment that can only reach the test's own temp vault.
 */

let fake: FakeNotes;
let vault: ReturnType<typeof withTempVault>;
const home = () => vault.home();

beforeEach(() => {
  fake = new FakeNotes();
});

afterEach(() => fake.stop());

function withProfiles(profiles: () => Record<string, { readOnly?: boolean; apiKey?: string }>): void {
  const own = withTempVault('agentio-notes-cli-', () => {
    const entries = Object.entries(profiles());
    return {
      config: { profiles: { notes: entries.map(([name, p]) => ({ name, ...(p.readOnly ? { readOnly: true } : {}) })) } } as never,
      credentials: {
        notes: Object.fromEntries(entries.map(([name, p]): [string, NotesCredentials] => [name, { baseUrl: fake.url, apiKey: p.apiKey ?? KEY }])),
      } as never,
    };
  });
  beforeEach(() => { vault = own; });
}

async function cli(args: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', 'src/index.ts', ...args], {
    stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...vault.env(), NO_COLOR: '1' },
  });
  const code = await proc.exited;
  return { code, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() };
}

function file(name: string, content: string): string {
  const path = join(home(), name);
  writeFileSync(path, content);
  return path;
}

const INVALID = exitCodeForError('INVALID_PARAMS');

describe('one profile', () => {
  withProfiles(() => ({ main: {} }));

  test('create, get, search, update, delete in --json mode', async () => {
    const created = await cli(['notes', 'create', '--title', 'Groceries', '--body', '- milk\n- **eggs**', '--json']);
    expect(created.code).toBe(0);
    const note = JSON.parse(created.stdout);
    expect(note).toMatchObject({ name: 'Groceries', folder: 'Notes' });
    expect(note.bodyHtml).toBeUndefined();
    expect(fake.notes[0].bodyHtml).toContain('<li><strong>eggs</strong></li>');

    const got = JSON.parse((await cli(['notes', 'get', note.id, '--json'])).stdout);
    expect(got).toMatchObject({ id: note.id, name: 'Groceries' });
    expect(typeof got.bodyHtml).toBe('string');

    const found = JSON.parse((await cli(['notes', 'search', 'EGGS', '--json'])).stdout);
    expect(found.notes.map((n: { id: string }) => n.id)).toEqual([note.id]);

    const moved = await cli(['notes', 'update', note.id, '--folder', 'Work', '--json']);
    expect(moved.code).toBe(0);
    expect(fake.notes[0].folder).toBe('Work');
    expect(fake.notes[0].bodyHtml).toContain('eggs');

    const deleted = await cli(['notes', 'delete', note.id, '--json']);
    expect(JSON.parse(deleted.stdout)).toEqual({ id: note.id, deleted: true });
    expect(fake.notes).toHaveLength(0);
  });

  test('get prints the body in the chosen format', async () => {
    const note = fake.seed('A', '<h1>Head</h1><div>body</div>');
    expect((await cli(['notes', 'get', note.id, '--format', 'html'])).stdout).toContain('<h1>Head</h1>');
    const text = (await cli(['notes', 'get', note.id, '--format', 'text'])).stdout;
    expect(text).toContain('Head body');
    expect(text).not.toContain('<h1>');
    const bad = await cli(['notes', 'get', note.id, '--format', 'pdf']);
    expect(bad.code).toBe(INVALID);
  });

  test('the body is read from stdin only with --file -', async () => {
    const piped = await cli(['notes', 'create', '--title', 'Piped', '--file', '-', '--format', 'text'], '<b>not bold</b>');
    expect(piped.code).toBe(0);
    expect(fake.notes[0].bodyHtml).toBe('<div>&lt;b&gt;not bold&lt;/b&gt;</div>');

    // Without --file -, piped input is ignored rather than read.
    const ignored = await cli(['notes', 'create', '--title', 'Empty'], 'should not be read');
    expect(ignored.code).toBe(0);
    expect(fake.notes[1].bodyHtml).toBe('');
  });

  test('--file - with nothing piped in is refused and creates nothing', async () => {
    const res = await cli(['notes', 'create', '--title', 'X', '--file', '-'], '');
    expect(res.code).toBe(INVALID);
    expect(fake.notes).toHaveLength(0);
  });

  test('the file extension decides the format unless --format says otherwise', async () => {
    await cli(['notes', 'create', '--title', 'H', '--file', file('a.html', '<p>raw *html*</p>')]);
    expect(fake.notes[0].bodyHtml).toBe('<p>raw *html*</p>');
    await cli(['notes', 'create', '--title', 'T', '--file', file('a.txt', '# not a heading')]);
    expect(fake.notes[1].bodyHtml).toBe('<div># not a heading</div>');
    await cli(['notes', 'create', '--title', 'M', '--file', file('a.txt', '# heading'), '--format', 'markdown']);
    expect(fake.notes[2].bodyHtml).toBe('<h1>heading</h1>');
  });

  test('bad body options are refused before any request', async () => {
    const both = await cli(['notes', 'create', '--title', 'X', '--body', 'a', '--file', file('a.md', 'b')]);
    const missing = await cli(['notes', 'create', '--title', 'X', '--file', join(home(), 'nope.md')]);
    mkdirSync(join(home(), 'dir.md'));
    const dir = await cli(['notes', 'create', '--title', 'X', '--file', join(home(), 'dir.md')]);
    const formatOnly = await cli(['notes', 'create', '--title', 'X', '--format', 'html']);
    const badFormat = await cli(['notes', 'create', '--title', 'X', '--body', 'a', '--format', 'rtf']);
    const blankTitle = await cli(['notes', 'create', '--title', '  ', '--body', 'a']);
    for (const res of [both, missing, dir, formatOnly, badFormat, blankTitle]) expect(res.code).toBe(INVALID);
    expect(fake.log).toHaveLength(0);
  });

  test('update with nothing to change, or blank values, never reaches the server', async () => {
    const note = fake.seed('Keep', '<div>keep</div>');
    for (const args of [[], ['--title', ''], ['--folder', ' ']]) {
      const res = await cli(['notes', 'update', note.id, ...args]);
      expect(res.code).toBe(INVALID);
    }
    expect(fake.log).toHaveLength(0);
    expect(fake.notes[0]).toMatchObject({ name: 'Keep', bodyHtml: '<div>keep</div>' });
  });

  test('an invalid --limit is refused before any request', async () => {
    for (const limit of ['0', '1001', 'abc', '-5']) {
      expect((await cli(['notes', 'list', '--limit', limit])).code).toBe(INVALID);
    }
    expect(fake.log).toHaveLength(0);
  });

  test('a blank search is refused', async () => {
    expect((await cli(['notes', 'search', '   '])).code).toBe(INVALID);
    expect(fake.log).toHaveLength(0);
  });

  test('errors go to stderr; stdout stays empty', async () => {
    const res = await cli(['notes', 'get', 'x-coredata://missing/ICNote/p1']);
    expect(res.code).toBe(exitCodeForError('NOT_FOUND'));
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('not found');
  });

  test('list and folders print readable text by default', async () => {
    fake.seed('First', '<div>a</div>', 'Work');
    const list = await cli(['notes', 'list', '--folder', 'Work']);
    expect(list.stdout).toContain('First');
    expect(list.stdout).toContain('Folder: Work');
    const folders = await cli(['notes', 'folders']);
    expect(folders.stdout).toContain('Work (iCloud)');
  });
});

describe('a read-only profile', () => {
  withProfiles(() => ({ ro: { readOnly: true } }));

  test('reads work, and every write is refused before any request', async () => {
    const note = fake.seed('Mine', '<div>x</div>');
    expect((await cli(['notes', 'get', note.id])).code).toBe(0);
    const before = fake.log.length;
    for (const args of [
      ['create', '--title', 'X', '--body', 'y'],
      ['update', note.id, '--title', 'Changed'],
      ['delete', note.id],
    ]) {
      const res = await cli(['notes', ...args]);
      expect(res.code).toBe(exitCodeForError('PERMISSION_DENIED'));
      expect(res.stderr).toContain('read-only');
    }
    expect(fake.log.length).toBe(before);
    expect(fake.notes[0].name).toBe('Mine');
  });
});

describe('a profile with a revoked key', () => {
  withProfiles(() => ({ old: { apiKey: 'revoked' } }));

  test('says the key was refused, without printing it', async () => {
    const res = await cli(['notes', 'folders']);
    expect(res.code).toBe(exitCodeForError('AUTH_FAILED'));
    expect(res.stderr).toContain('refused the API key');
    expect(res.stderr).not.toContain('revoked');
  });
});

describe('two profiles', () => {
  withProfiles(() => ({ a: {}, b: {} }));

  test('a command without --profile is refused rather than guessing', async () => {
    const res = await cli(['notes', 'folders']);
    expect(res.code).not.toBe(0);
    expect(fake.log).toHaveLength(0);
    expect((await cli(['notes', 'folders', '--profile', 'b'])).code).toBe(0);
  });
});
