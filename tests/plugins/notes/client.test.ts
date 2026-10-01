import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { bodyToHtml, NotesClient, normaliseNotesUrl, parseLimit } from '../../../src/plugins/notes/client';
import { CliError } from '../../../src/utils/errors';
import { caught, FakeNotes, KEY } from './fake-notes';

let fake: FakeNotes;
let client: NotesClient;

beforeEach(() => {
  fake = new FakeNotes();
  client = new NotesClient({ baseUrl: fake.url, apiKey: KEY });
});

afterEach(() => fake.stop());

describe('note ids', () => {
  test('an x-coredata id with slashes reaches the note, encoded as one path segment', async () => {
    const note = fake.seed('Groceries', '<div>milk</div>');
    expect((await client.get(note.id)).name).toBe('Groceries');
    const req = fake.log.at(-1)!;
    expect(req.rawPath).toBe(`/v1/notes/${encodeURIComponent(note.id)}`);
    expect(req.rawPath.split('/').length).toBe(4);
  });

  test('characters that would end the path or start a query stay inside the id', async () => {
    const note = fake.seed('Odd', '<div>x</div>', 'Notes', { id: 'x-coredata://A/ICNote/p1?q=1#frag%2F' });
    expect((await client.get(note.id)).id).toBe(note.id);
    expect(fake.log.at(-1)!.query).toEqual({});
  });

  test('an empty or blank id is refused before any request', async () => {
    for (const id of ['', '   ']) {
      const err = await caught(client.get(id));
      expect(err.code).toBe('INVALID_PARAMS');
    }
    expect(fake.log).toHaveLength(0);
  });

  test('an id that does not exist is NOT_FOUND, not a crash', async () => {
    const err = await caught(client.get('x-coredata://nope/ICNote/p999'));
    expect(err.code).toBe('NOT_FOUND');
  });
});

describe('errors from the server', () => {
  test('a wrong key is AUTH_FAILED, and the key is never echoed', async () => {
    const bad = new NotesClient({ baseUrl: fake.url, apiKey: 'wrong-key' });
    const err = await caught(bad.folders());
    expect(err.code).toBe('AUTH_FAILED');
    expect(`${err.message} ${err.suggestion}`).not.toContain('wrong-key');
  });

  test('a server message that contains the key has it scrubbed', async () => {
    fake.failNext = { status: 502, body: { error: 'NotesError', message: `osascript failed with ${KEY} in args` } };
    const err = await caught(client.folders());
    expect(err.code).toBe('API_ERROR');
    expect(err.message).not.toContain(KEY);
    expect(err.message).toContain('[api key]');
    expect(err.suggestion).toContain('Notes.app');
  });

  test('a missing Automation permission says where to grant it', async () => {
    fake.failNext = { status: 403, body: { error: 'PermissionDenied', message: 'denied', detail: '(-1743)' } };
    const err = await caught(client.list());
    expect(err.code).toBe('PERMISSION_DENIED');
    expect(err.suggestion).toContain('Automation');
  });

  test('a locked note is PERMISSION_DENIED with a reason', async () => {
    const note = fake.seed('Secret', '<div>x</div>', 'Notes', { locked: true });
    const err = await caught(client.get(note.id));
    expect(err.code).toBe('PERMISSION_DENIED');
    expect(err.message).toContain('locked');
  });

  test('a server not on macOS is a configuration error', async () => {
    fake.platform = 'linux';
    const err = await caught(client.folders());
    expect(err.code).toBe('CONFIG_ERROR');
  });

  test('validation issues are spelled out', async () => {
    fake.failNext = { status: 400, body: { error: 'ValidationError', issues: { formErrors: ['bad form'], fieldErrors: { limit: ['too big'] } } } };
    const err = await caught(client.list());
    expect(err.code).toBe('INVALID_PARAMS');
    expect(err.message).toContain('bad form');
    expect(err.message).toContain('limit: too big');
  });

  test('an HTML error page (a proxy) still gives a status-based error', async () => {
    const proxy = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<html>Bad Gateway</html>', { status: 502 }) });
    try {
      const err = await caught(new NotesClient({ baseUrl: `http://127.0.0.1:${proxy.port}`, apiKey: KEY }).folders());
      expect(err.code).toBe('API_ERROR');
      expect(err.message).toContain('502');
    } finally {
      proxy.stop(true);
    }
  });

  test('a 200 that is not JSON is refused rather than read as empty', async () => {
    const odd = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<html>login</html>', { status: 200 }) });
    try {
      const err = await caught(new NotesClient({ baseUrl: `http://127.0.0.1:${odd.port}`, apiKey: KEY }).folders());
      expect(err.code).toBe('API_ERROR');
    } finally {
      odd.stop(true);
    }
  });

  test('an unreachable server is NETWORK_ERROR', async () => {
    const url = fake.url;
    fake.stop();
    const err = await caught(new NotesClient({ baseUrl: url, apiKey: KEY }).folders());
    expect(err.code).toBe('NETWORK_ERROR');
  });

  test('health on a server that is not apple-notes-api is refused', async () => {
    const other = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ status: 'up' }) });
    try {
      const err = await caught(new NotesClient({ baseUrl: `http://127.0.0.1:${other.port}`, apiKey: KEY }).health());
      expect(err.code).toBe('CONFIG_ERROR');
    } finally {
      other.stop(true);
    }
  });
});

describe('list and search', () => {
  test('folder, query and limit reach the server as its parameters; absent ones are not sent', async () => {
    await client.list();
    expect(fake.log.at(-1)!.query).toEqual({});
    await client.list({ folder: 'Work & Play', query: 'a+b c', limit: 5 });
    expect(fake.log.at(-1)!.query).toEqual({ folder: 'Work & Play', q: 'a+b c', limit: '5' });
  });

  test('search matches title or body text', async () => {
    fake.seed('Groceries', '<div>milk</div>');
    fake.seed('Other', '<div>buy MILK</div>');
    fake.seed('Unrelated', '<div>x</div>');
    expect((await client.list({ query: 'milk' })).map((n) => n.name)).toEqual(['Groceries', 'Other']);
  });
});

describe('write requests', () => {
  test('update with nothing to change is refused before any request', async () => {
    const note = fake.seed('A', '<div>a</div>');
    const err = await caught(client.update(note.id, {}));
    expect(err.code).toBe('INVALID_PARAMS');
    expect(fake.log).toHaveLength(0);
  });

  test('update to a blank title is refused, so a note never loses its title', async () => {
    const note = fake.seed('A', '<div>a</div>');
    const err = await caught(client.update(note.id, { name: '  ' }));
    expect(err.code).toBe('INVALID_PARAMS');
    expect(fake.notes[0].name).toBe('A');
  });

  test('update sends only the fields given', async () => {
    const note = fake.seed('A', '<div>keep me</div>');
    await client.update(note.id, { folder: 'Work' });
    expect(fake.log.at(-1)!.body).toEqual({ folder: 'Work' });
    expect(fake.notes[0].bodyHtml).toBe('<div>keep me</div>');
  });

  test('create in a folder that does not exist is NOT_FOUND and creates nothing', async () => {
    const err = await caught(client.create({ name: 'X', body: '', folder: 'Nope' }));
    expect(err.code).toBe('NOT_FOUND');
    expect(fake.notes).toHaveLength(0);
  });

  test('create with a blank title is refused before any request', async () => {
    const err = await caught(client.create({ name: ' ', body: 'x' }));
    expect(err.code).toBe('INVALID_PARAMS');
    expect(fake.log).toHaveLength(0);
  });

  test('delete of a note that is already gone is NOT_FOUND', async () => {
    const note = fake.seed('A', '<div>a</div>');
    await client.delete(note.id);
    const err = await caught(client.delete(note.id));
    expect(err.code).toBe('NOT_FOUND');
  });
});

describe('bodyToHtml', () => {
  test('text is escaped, so markup in it is shown, not run', () => {
    const html = bodyToHtml('<script>alert(1)</script>\n\na & b', 'text');
    expect(html).not.toContain('<script>');
    expect(html).toBe('<div>&lt;script&gt;alert(1)&lt;/script&gt;</div><div><br></div><div>a &amp; b</div>');
  });

  test('text with CRLF line ends gives the same blocks as LF', () => {
    expect(bodyToHtml('a\r\nb', 'text')).toBe(bodyToHtml('a\nb', 'text'));
  });

  test('markdown is rendered to HTML', () => {
    const html = bodyToHtml('# Title\n\n- **one**\n- two', 'markdown');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<li><strong>one</strong></li>');
  });

  test('plain prose through the markdown path is still HTML, so the server never guesses', () => {
    expect(bodyToHtml('just words', 'markdown')).toBe('<p>just words</p>');
  });

  test('html is sent unchanged', () => {
    expect(bodyToHtml('<div>x</div>', 'html')).toBe('<div>x</div>');
  });
});

describe('parseLimit', () => {
  test('accepts 1 to 1000', () => {
    expect(parseLimit('1')).toBe(1);
    expect(parseLimit('1000')).toBe(1000);
  });

  test('refuses anything else', () => {
    for (const bad of ['0', '1001', '-1', '1.5', 'ten', '', ' ', '1e2', '0x10', '10abc']) {
      expect(() => parseLimit(bad)).toThrow(CliError);
    }
  });
});

describe('normaliseNotesUrl', () => {
  test('adds https and strips trailing slashes', () => {
    expect(normaliseNotesUrl('mac.example.ts.net')).toBe('https://mac.example.ts.net');
    expect(normaliseNotesUrl(' http://127.0.0.1:8787/ ')).toBe('http://127.0.0.1:8787');
  });

  test('refuses other schemes, credentials in the URL and garbage', () => {
    for (const bad of ['', 'ftp://mac', 'https://user:pw@mac', 'http://', 'file:///etc/passwd']) {
      expect(() => normaliseNotesUrl(bad)).toThrow(CliError);
    }
  });
});
