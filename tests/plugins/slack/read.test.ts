import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { downloadTarget, exportSlackAttachments, manifestToCsv, saveFile } from '../../../src/plugins/slack/attachments';
import { fileIdFrom, messagePermalink, SlackClient } from '../../../src/plugins/slack/client';
import { SlackDirectory } from '../../../src/plugins/slack/directory';
import { collectMessages } from '../../../src/plugins/slack/messages';
import type { SlackManifestEntry } from '../../../src/plugins/slack/types';
import { caught, FakeSlack, fakeChannel, fakeFile, rawUser, TOKEN, tsAt } from './fake-slack';

let fake: FakeSlack;
let client: SlackClient;
let warnings: string[];
let home: string;
let savedHome: string | undefined;

beforeEach(async () => {
  savedHome = process.env.AGENTIO_HOME;
  home = await mkdtemp(join(tmpdir(), 'agentio-slack-read-'));
  process.env.AGENTIO_HOME = home;
  fake = new FakeSlack();
  fake.users = [
    rawUser('U0001', { profile: { real_name: 'Alice Martin', display_name: 'alice' } }),
    rawUser('U0002', { profile: { real_name: 'Bob Stone', display_name: '' } }),
  ];
  client = new SlackClient({ type: 'token', token: TOKEN }, { sleep: async () => {} });
  warnings = [];
});

afterEach(async () => {
  fake.stop();
  if (savedHome === undefined) delete process.env.AGENTIO_HOME;
  else process.env.AGENTIO_HOME = savedHome;
  await rm(home, { recursive: true, force: true });
});

const range = { since: new Date('2026-10-20T00:00:00Z'), until: new Date('2026-10-27T00:00:00Z') };
const collect = (extra: Record<string, unknown> = {}) => collectMessages(client, { range, onWarning: (m) => warnings.push(m), ...extra });
const methods = () => fake.log.map((c) => c.url.replace('https://slack.com/api/', ''));
const channel = (id: string) => fake.channels.find((c) => c.id === id)!;
const WRITES = /\.(join|invite|kick|leave|mark|create|rename|archive|unarchive|setTopic|setPurpose)$|^chat\./;

describe('--include-public', () => {
  beforeEach(() => {
    fake.channels.push(fakeChannel('C0OTHER', 'other', { members: ['U0001'], messages: [{ ts: tsAt('2026-10-22T10:00:00Z'), user: 'U0001', text: 'not joined' }] }));
    channel('C0GENERAL').messages.push({ ts: tsAt('2026-10-22T09:00:00Z'), user: 'U0002', text: 'mine' });
  });

  test('without it, a public channel you are not in is not read', async () => {
    const result = await collect();
    expect(result.conversations.map((c) => c.id)).toEqual(['C0GENERAL']);
    expect(result.conversations[0].isMember).toBe(true);
  });

  test('with it, public channels you are not in are read with isMember false, and nothing is joined or marked read', async () => {
    const result = await collect({ includePublic: true });
    const other = result.conversations.find((c) => c.id === 'C0OTHER')!;
    expect(other).toMatchObject({ name: 'other', type: 'channel', isMember: false });
    expect(other.messages.map((m) => m.text)).toEqual(['not joined']);
    expect(result.conversations.find((c) => c.id === 'C0GENERAL')!.isMember).toBe(true);
    expect(methods().filter((m) => WRITES.test(m))).toEqual([]);
    expect(fake.log.find((c) => c.url.endsWith('conversations.list'))!.params.types).toBe('public_channel');
    expect(channel('C0OTHER').members).toEqual(['U0001']);
  });

  test('--channel can name a public channel you are not in', async () => {
    const result = await collect({ includePublic: true, channels: ['#other'] });
    expect(result.conversations.map((c) => c.id)).toEqual(['C0OTHER']);
  });

  test('a refused public channel (not_in_channel or missing scope) is left out with a warning naming it; the rest is read', async () => {
    fake.historyErrors.C0OTHER = 'not_in_channel';
    const result = await collect({ includePublic: true });
    expect(result.conversations.map((c) => c.id)).toEqual(['C0GENERAL']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('#other (public, not a member)');

    warnings = [];
    fake.historyErrors.C0OTHER = 'missing_scope';
    expect((await collect({ includePublic: true })).conversations.map((c) => c.id)).toEqual(['C0GENERAL']);
    expect(warnings[0]).toContain('#other (public, not a member)');
  });

  test('not_in_channel or missing_scope on a conversation you are in still fails the run', async () => {
    fake.historyErrors.C0GENERAL = 'missing_scope';
    expect((await caught(collect({ includePublic: true }))).code).toBeDefined();
  });

  test('with --types leaving channels out it is refused', async () => {
    expect((await caught(collect({ includePublic: true, types: ['dm'] }))).code).toBe('INVALID_PARAMS');
  });
});

describe('what each message carries', () => {
  test('Slackbot\'s direct message is skipped quietly', async () => {
    fake.channels.push(fakeChannel('D0SLACKBOT', '', { is_im: true, user: 'USLACKBOT', members: ['U0ADMIN', 'USLACKBOT'] }));
    fake.historyErrors.D0SLACKBOT = 'channel_not_found';
    channel('C0GENERAL').messages.push({ ts: tsAt('2026-10-22T09:00:00Z'), user: 'U0001', text: 'hi' });
    const result = await collect();
    expect(result.conversations.map((c) => c.id)).toEqual(['C0GENERAL']);
    expect(warnings).toEqual([]);
    expect(fake.log.some((c) => c.params.channel === 'D0SLACKBOT')).toBe(false);
  });

  test('permalinks for messages and replies; real and display names for authors; links made readable', async () => {
    const parent = tsAt('2026-10-21T09:00:00Z');
    channel('C0GENERAL').messages.push(
      { ts: parent, user: 'U0001', text: 'see <https://example.com/spec|the spec> and <https://example.com/b>' },
      { ts: tsAt('2026-10-21T09:05:00Z'), user: 'U0002', text: 'ok <@U0001>', thread_ts: parent },
    );
    fake.scopes.delete('search:read');
    const [conv] = (await collect()).conversations;
    const [m] = conv.messages;
    expect(m).toMatchObject({
      userName: 'alice', realName: 'Alice Martin', displayName: 'alice',
      text: 'see the spec (https://example.com/spec) and https://example.com/b',
      permalink: `https://example.slack.com/archives/C0GENERAL/p${parent.replace('.', '')}`,
    });
    const [reply] = m.replies;
    expect(reply).toMatchObject({ userName: 'Bob Stone', realName: 'Bob Stone', text: 'ok @alice' });
    expect(reply.displayName).toBeUndefined();
    expect(reply.permalink).toBe(messagePermalink('https://example.slack.com/', 'C0GENERAL', reply.ts, parent));
    expect(reply.permalink).toContain(`?thread_ts=${parent}&cid=C0GENERAL`);
  });

  test('--raw keeps Slack\'s markup as sent', async () => {
    channel('C0GENERAL').messages.push({ ts: tsAt('2026-10-21T09:00:00Z'), user: 'U0001', text: 'ok <@U0002> <https://example.com|x> &amp;' });
    const [conv] = (await collect({ raw: true })).conversations;
    expect(conv.messages[0].text).toBe('ok <@U0002> <https://example.com|x> &amp;');
    expect(conv.messages[0].userName).toBe('alice');
  });

  test('names come from a cache: a second run does not read users.list again', async () => {
    channel('C0GENERAL').messages.push({ ts: tsAt('2026-10-21T09:00:00Z'), user: 'U0001', text: 'hi' });
    await collect();
    await collect();
    expect(methods().filter((m) => m === 'users.list')).toHaveLength(1);
  });
});

describe('SlackDirectory', () => {
  const at = (iso: string) => () => Date.parse(iso);

  test('re-reads once a day, and for an unknown id at most once an hour; stores names only', async () => {
    const count = () => methods().filter((m) => m === 'users.list').length;
    await new SlackDirectory(client, 'T0001:U0ADMIN', at('2026-10-27T08:00:00Z')).entries(['U0001']);
    expect(count()).toBe(1);
    const cached = JSON.stringify(await new SlackDirectory(client, 'T0001:U0ADMIN', at('2026-10-27T08:00:00Z')).entries([]));
    expect(cached).not.toContain('@example.com');
    expect(count()).toBe(1);

    await new SlackDirectory(client, 'T0001:U0ADMIN', at('2026-10-27T08:30:00Z')).entries(['U0NEW']);
    expect(count()).toBe(1);
    fake.users.push(rawUser('U0NEW'));
    const entries = await new SlackDirectory(client, 'T0001:U0ADMIN', at('2026-10-27T09:00:00Z')).entries(['U0NEW']);
    expect(count()).toBe(2);
    expect(entries.find((e) => e.id === 'U0NEW')).toBeDefined();

    await new SlackDirectory(client, 'T0001:U0ADMIN', at('2026-10-28T09:00:01Z')).entries([]);
    expect(count()).toBe(3);
  });
});

describe('files', () => {
  test('fileIdFrom: an id, a permalink or a private download URL; anything else is refused', async () => {
    expect(fileIdFrom('F0123ABCDEF')).toBe('F0123ABCDEF');
    expect(fileIdFrom('https://example.slack.com/files/U0001/F0123ABCDEF/report.pdf')).toBe('F0123ABCDEF');
    expect(fileIdFrom('https://files.slack.com/files-pri/T0001-F0123ABCDEF/download/report.pdf')).toBe('F0123ABCDEF');
    for (const bad of ['report.pdf', 'https://example.com/files/F0123ABCDEF', 'http://files.slack.com/files-pri/T0001-F0123ABCDEF/x', 'https://example.slack.com/archives/C0GENERAL']) {
      expect(() => fileIdFrom(bad)).toThrow();
    }
  });

  test('a download sends the token to Slack only, and refuses Slack\'s sign-in page', async () => {
    fake.files.F0LOG01 = fakeFile('F0LOG01', 'log.txt', 'hello');
    const info = await client.fileInfo('F0LOG01');
    expect(info).toMatchObject({ id: 'F0LOG01', name: 'log.txt', mimetype: 'text/plain', size: 5 });
    expect(await (await client.downloadFile(info)).text()).toBe('hello');
    expect(fake.log.at(-1)!.authorization).toBe(`Bearer ${TOKEN}`);

    const elsewhere = { ...info, urlPrivateDownload: 'https://files.example.com/log.txt' };
    expect((await caught(client.downloadFile(elsewhere))).code).toBe('API_ERROR');
    expect(fake.log.some((c) => c.url.includes('example.com/log.txt'))).toBe(false);

    fake.scopes.delete('files:read');
    const err = await caught(client.downloadFile(info));
    expect(err.code).toBe('PERMISSION_DENIED');
    expect(err.suggestion).toContain('files:read');
  });

  test('downloadTarget: --out as a file, as a folder, or the file\'s own name here', async () => {
    const dir = join(home, 'out');
    await mkdir(dir);
    expect(await downloadTarget(join(home, 'x.bin'), 'log.txt')).toBe(join(home, 'x.bin'));
    expect(await downloadTarget(dir, 'log.txt')).toBe(join(dir, 'log.txt'));
    expect(await downloadTarget(join(home, 'new') + '/', '../evil.txt')).toBe(join(home, 'new', '_evil.txt'));
    expect(await downloadTarget(undefined, 'a/b.txt')).toBe(join(process.cwd(), 'a_b.txt'));
  });

  test('saveFile reads files.info first when the message carried no download link', async () => {
    fake.files.F0LOG01 = fakeFile('F0LOG01', 'log.txt', 'hello');
    const path = join(home, 'log.txt');
    const saved = await saveFile(client, { id: 'F0LOG01', name: 'log.txt' }, path);
    expect(saved.bytes).toBe(5);
    expect(await readFile(path, 'utf8')).toBe('hello');
    expect(methods()).toContain('files.info');
  });
});

describe('exportSlackAttachments', () => {
  const day = tsAt('2026-10-21T09:00:00Z');

  beforeEach(() => {
    fake.files.F0AAA01 = fakeFile('F0AAA01', 'report.pdf', 'pdf bytes');
    fake.files.F0BBB01 = fakeFile('F0BBB01', 'report.pdf', 'other bytes');
    channel('C0GENERAL').messages.push(
      { ts: day, user: 'U0001', text: 'two reports', files: [fake.files.F0AAA01.raw, fake.files.F0BBB01.raw] },
      { ts: tsAt('2026-10-21T09:05:00Z'), user: 'U0002', text: 'gone', thread_ts: day, files: [{ id: 'F0GONE1', name: 'gone.png', mode: 'tombstone' }] },
    );
    fake.scopes.delete('search:read');
  });

  test('saves every file, replies included, named by date and sender, with a JSON and CSV manifest', async () => {
    const out = join(home, 'files');
    const result = await exportSlackAttachments(client, await collect(), { outDir: out });
    expect(result).toMatchObject({ files: 3, saved: 2, failed: 0, skipped: 1, messagesWithFiles: 2 });
    expect(await readFile(join(out, '2026-10-21_Alice-Martin_report.pdf'), 'utf8')).toBe('pdf bytes');
    expect(await readFile(join(out, '2026-10-21_Alice-Martin_report (2).pdf'), 'utf8')).toBe('other bytes');
    const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')) as SlackManifestEntry[];
    expect(manifest.map((e) => [e.fileId, e.status])).toEqual([['F0AAA01', 'saved'], ['F0BBB01', 'saved'], ['F0GONE1', 'skipped']]);
    expect(manifest[0]).toMatchObject({ conversationId: 'C0GENERAL', conversation: 'general', messageTs: day, user: 'U0001', realName: 'Alice Martin', bytes: 9 });
    expect(manifest[0].permalink).toContain('/archives/C0GENERAL/');
    const csv = await readFile(join(out, 'manifest.csv'), 'utf8');
    expect(csv.split('\n')[0]).toBe('conversationId,conversation,messageTs,time,user,userName,realName,permalink,fileId,name,mimetype,size,savedPath,status,bytes,error');
    expect(csv).toBe(manifestToCsv(manifest));
  });

  test('--dry-run downloads nothing but writes the manifest', async () => {
    const out = join(home, 'dry');
    const result = await exportSlackAttachments(client, await collect(), { outDir: out, dryRun: true });
    expect(result).toMatchObject({ files: 3, saved: 0, skipped: 1 });
    expect(fake.log.some((c) => c.url.startsWith('https://files.slack.com/'))).toBe(false);
    const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')) as SlackManifestEntry[];
    expect(manifest.map((e) => e.status)).toEqual(['planned', 'planned', 'skipped']);
  });

  test('a file that fails is recorded with its error and the others are still saved', async () => {
    const messages = await collect();
    messages.conversations[0].messages[0].files[1].urlPrivateDownload = 'https://files.slack.com/files-pri/T0001-F0BBB01/download/missing';
    const result = await exportSlackAttachments(client, messages, { outDir: join(home, 'partial') });
    expect(result).toMatchObject({ saved: 1, failed: 1 });
    expect(result.entries[1].error).toContain('HTTP 404');
  });

  test('other files already in the folder are left alone', async () => {
    const out = join(home, 'again');
    await mkdir(out);
    await writeFile(join(out, 'keep.txt'), 'mine');
    await exportSlackAttachments(client, await collect(), { outDir: out });
    expect(await readFile(join(out, 'keep.txt'), 'utf8')).toBe('mine');
  });
});
