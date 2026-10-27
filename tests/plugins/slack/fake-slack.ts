/**
 * An in-process stand-in for the Slack Web API: it replaces globalThis.fetch,
 * answers slack.com/api/<method> as Slack does (HTTP 200 with `ok: false` for
 * API errors, 429 with Retry-After for rate limits), and refuses any other host.
 */

import { expect } from 'bun:test';
import { CliError } from '../../../src/utils/errors';

export const TOKEN = 'xoxp-1111-2222-3333-secrettokenvalue';

/** The CliError a promise rejects with; fails the test when it resolves or throws anything else. */
export async function caught(p: Promise<unknown>): Promise<CliError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    return e as CliError;
  }
  throw new Error('expected a CliError, got success');
}

export interface LoggedCall {
  url: string;
  method: string;
  authorization: string | null;
  contentType: string | null;
  params: Record<string, string>;
}

/** What the next calls answer with instead of the normal answer, in order. */
export type Scripted =
  | { status: number; body?: unknown; text?: string; headers?: Record<string, string> }
  | { throws: Error };

export function rawUser(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: id.toLowerCase(),
    deleted: false,
    is_admin: false,
    is_owner: false,
    is_bot: false,
    is_restricted: false,
    profile: { real_name: `Real ${id}`, display_name: `disp-${id}`, email: `${id.toLowerCase()}@example.com` },
    ...overrides,
  };
}

export interface FakeChannel {
  id: string;
  name: string;
  is_private: boolean;
  is_archived: boolean;
  topic: { value: string };
  purpose: { value: string };
  members: string[];
  is_im?: boolean;
  is_mpim?: boolean;
  /** Direct messages: the other person. */
  user?: string;
  /** The file id of the channel's canvas. */
  canvas?: string;
  /** Top-level messages and thread replies alike; replies carry thread_ts. */
  messages: FakeMessage[];
}

export function fakeChannel(id: string, name: string, overrides: Partial<FakeChannel> = {}): FakeChannel {
  return { id, name, is_private: false, is_archived: false, topic: { value: '' }, purpose: { value: '' }, members: ['U0ADMIN'], messages: [], ...overrides };
}

export interface FakeMessage {
  ts: string;
  user?: string;
  username?: string;
  subtype?: string;
  text: string;
  thread_ts?: string;
  files?: { name: string }[];
}

export interface FakeCanvas {
  id: string;
  title: string;
  user: string;
  /** What a download returns. */
  html: string;
  /** The last Markdown written by create or edit. */
  markdown: string;
  channel?: string;
  created: number;
  updated: number;
  /** User or channel id → access level. */
  access: Record<string, string>;
}

/** A Slack timestamp for an ISO date: whole seconds, then a six-digit sequence. */
export function tsAt(iso: string, seq = 1): string {
  return `${Math.floor(Date.parse(iso) / 1000)}.${String(seq).padStart(6, '0')}`;
}

type Kind = 'public_channel' | 'private_channel' | 'im' | 'mpim';
const READ_SCOPE: Record<Kind, string> = { public_channel: 'channels:read', private_channel: 'groups:read', im: 'im:read', mpim: 'mpim:read' };
const HISTORY_SCOPE: Record<Kind, string> = { public_channel: 'channels:history', private_channel: 'groups:history', im: 'im:history', mpim: 'mpim:history' };
const byTs = (a: FakeMessage, b: FakeMessage) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);

function kindOf(c: FakeChannel): Kind {
  if (c.is_im) return 'im';
  if (c.is_mpim) return 'mpim';
  return c.is_private ? 'private_channel' : 'public_channel';
}

/** Slack's oldest/latest window: exclusive unless inclusive=true. */
function inWindow(ts: string, oldest: string | undefined, latest: string | undefined, inclusive: boolean): boolean {
  const n = Number(ts);
  const lo = oldest ? Number(oldest) : -Infinity;
  const hi = latest ? Number(latest) : Infinity;
  return inclusive ? n >= lo && n <= hi : n > lo && n < hi;
}

const ALL_SCOPES = [
  'users:read', 'users:read.email', 'channels:read', 'groups:read',
  'channels:manage', 'groups:write', 'channels:write.invites', 'groups:write.invites', 'channels:write',
  'channels:history', 'groups:history', 'im:history', 'mpim:history', 'im:read', 'mpim:read', 'search:read',
  'canvases:read', 'canvases:write', 'files:read',
];

export class FakeSlack {
  readonly log: LoggedCall[] = [];
  readonly queue: Scripted[] = [];
  team = { id: 'T0001', name: 'Hex-Rays SA' };
  self = { id: 'U0ADMIN', name: 'admin' };
  /** users.list answers these, `pageSize` per page. */
  users: Record<string, unknown>[] = [rawUser('U0001'), rawUser('U0002')];
  pageSize = 1000;
  /** Scopes the token has; a method needing another answers missing_scope. */
  scopes = new Set(ALL_SCOPES);
  channels: FakeChannel[] = [fakeChannel('C0GENERAL', 'general'), fakeChannel('C0RANDOM', 'random')];
  /** conversations.list and conversations.members answer this many per page. */
  channelPageSize = 1000;
  /** Users conversations.invite refuses, with the error Slack gives. */
  inviteErrors: Record<string, string> = {};
  /** Users conversations.kick refuses, with the error Slack gives. */
  kickErrors: Record<string, string> = {};
  /** conversations.history answers this Slack error for these channel ids. */
  historyErrors: Record<string, string> = {};
  /** When set, search.messages answers these raw matches instead of searching. */
  searchMatches?: Record<string, unknown>[];
  searchPageSize = 100;
  /** Answers for one call by its 1-based number, before the queue. */
  private readonly at = new Map<number, Scripted>();
  canvases: FakeCanvas[] = [];
  /** Files that are not canvases, which files.list pages over too. */
  otherFiles: Record<string, unknown>[] = [];
  /** files.list answers this many files per page, before keeping canvases. */
  filesPageSize = 100;
  /** The download link files.info gives; replace it to test the token guard. */
  downloadUrlFor = (c: FakeCanvas) => `https://files.slack.com/files-pri/T0001-${c.id}/download`;
  /** When set, every download answers this. */
  downloadAnswer?: { status: number; contentType?: string; body?: string };
  /** Each canvases.edit call's changes, in order. */
  readonly edits: { id: string; changes: Record<string, unknown>[] }[] = [];
  /** canvases.access.set and .delete answer this Slack error when one of these ids is in the call. */
  accessErrors: Record<string, string> = {};
  /** Each canvases.access.set or .delete call's parameters, in order. */
  readonly accessCalls: { method: string; params: Record<string, string> }[] = [];

  addCanvas(fields: Partial<FakeCanvas> & { title: string }): FakeCanvas {
    const n = this.canvases.length + 1;
    const canvas: FakeCanvas = {
      id: `F0CANVAS${String(n).padStart(2, '0')}`, user: this.self.id, html: '<div class="quip-canvas-content"></div>', markdown: '',
      created: 1792454400 + n, updated: 1792454400 + n, access: {}, ...fields,
    };
    this.canvases.push(canvas);
    return canvas;
  }
  private readonly original = globalThis.fetch;

  constructor() {
    globalThis.fetch = this.handle.bind(this) as typeof fetch;
  }

  stop(): void {
    globalThis.fetch = this.original;
  }

  queueAt(call: number, scripted: Scripted): void {
    this.at.set(call, scripted);
  }

  private async handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    const params = Object.fromEntries(new URLSearchParams(typeof init?.body === 'string' ? init.body : ''));
    this.log.push({ url, method: init?.method ?? 'GET', authorization: headers.get('authorization'), contentType: headers.get('content-type'), params });

    if (url.startsWith('https://files.slack.com/')) return this.download(url, headers.get('authorization'));
    if (!url.startsWith('https://slack.com/api/')) throw new TypeError(`blocked: ${url}`);

    const scriptedAt = this.at.get(this.log.length);
    if (scriptedAt) this.at.delete(this.log.length);
    const next = scriptedAt ?? this.queue.shift();
    if (next) {
      if ('throws' in next) throw next.throws;
      const text = next.text ?? (next.body === undefined ? '' : JSON.stringify(next.body));
      return new Response(text, { status: next.status, headers: next.headers });
    }

    if (headers.get('authorization') !== `Bearer ${TOKEN}`) return this.json({ ok: false, error: 'invalid_auth' });
    const method = url.slice('https://slack.com/api/'.length);
    return this.json(this.answer(method, params));
  }

  private answer(method: string, params: Record<string, string>): Record<string, unknown> {
    const need = (scope: string) => (this.scopes.has(scope) ? null : { ok: false, error: 'missing_scope', needed: scope, provided: [...this.scopes].join(',') });
    switch (method) {
      case 'auth.test':
        return { ok: true, team_id: this.team.id, team: this.team.name, user_id: this.self.id, user: this.self.name, url: 'https://hex-rays.slack.com/' };
      case 'users.list': {
        const denied = need('users:read');
        if (denied) return denied;
        const start = params.cursor ? Number(params.cursor.replace('page-', '')) : 0;
        const members = this.users.slice(start, start + this.pageSize);
        const nextStart = start + this.pageSize;
        return { ok: true, members, response_metadata: { next_cursor: nextStart < this.users.length ? `page-${nextStart}` : '' } };
      }
      case 'users.info': {
        const denied = need('users:read');
        if (denied) return denied;
        const user = this.users.find((u) => u.id === params.user);
        return user ? { ok: true, user } : { ok: false, error: 'user_not_found' };
      }
      case 'users.lookupByEmail': {
        const denied = need('users:read.email');
        if (denied) return denied;
        const user = this.users.find((u) => (u.profile as { email?: string }).email === params.email);
        return user ? { ok: true, user } : { ok: false, error: 'users_not_found' };
      }
      case 'conversations.list': {
        const types = (params.types ?? 'public_channel').split(',');
        const visible = this.channels.filter((c) => this.visible(c)
          && types.includes(c.is_private ? 'private_channel' : 'public_channel')
          && (params.exclude_archived !== 'true' || !c.is_archived));
        for (const t of types) {
          const denied = need(t === 'private_channel' ? 'groups:read' : 'channels:read');
          if (denied) return denied;
        }
        return this.page(visible.map((c) => this.view(c)), params.cursor, 'channels');
      }
      case 'conversations.info': {
        const c = this.find(params.channel);
        if (!c) return { ok: false, error: 'channel_not_found' };
        const denied = need(c.is_private ? 'groups:read' : 'channels:read');
        return denied ?? { ok: true, channel: { ...this.view(c), ...(params.include_num_members === 'true' ? { num_members: c.members.length } : {}) } };
      }
      case 'conversations.members': {
        const c = this.find(params.channel);
        if (!c) return { ok: false, error: 'channel_not_found' };
        const denied = need(c.is_private ? 'groups:read' : 'channels:read');
        return denied ?? this.page(c.members, params.cursor, 'members');
      }
      case 'conversations.create': {
        const isPrivate = params.is_private === 'true';
        const denied = need(isPrivate ? 'groups:write' : 'channels:manage');
        if (denied) return denied;
        if (this.channels.some((c) => c.name === params.name)) return { ok: false, error: 'name_taken' };
        const c = fakeChannel(`${isPrivate ? 'G' : 'C'}0NEW${this.channels.length}`, params.name, { is_private: isPrivate });
        this.channels.push(c);
        return { ok: true, channel: this.view(c) };
      }
      case 'conversations.rename':
      case 'conversations.setTopic':
      case 'conversations.setPurpose':
      case 'conversations.kick': {
        const c = this.find(params.channel);
        if (!c) return { ok: false, error: 'channel_not_found' };
        const denied = need(c.is_private ? 'groups:write' : 'channels:manage');
        if (denied) return denied;
        if (c.is_archived) return { ok: false, error: 'is_archived' };
        if (method === 'conversations.rename') {
          if (this.channels.some((o) => o !== c && o.name === params.name)) return { ok: false, error: 'name_taken' };
          c.name = params.name;
        } else if (method === 'conversations.setTopic') {
          c.topic.value = params.topic;
        } else if (method === 'conversations.setPurpose') {
          c.purpose.value = params.purpose;
        } else {
          if (params.user === this.self.id) return { ok: false, error: 'cant_kick_self' };
          if (this.kickErrors[params.user]) return { ok: false, error: this.kickErrors[params.user] };
          if (!c.members.includes(params.user)) return { ok: false, error: 'not_in_channel' };
          c.members = c.members.filter((m) => m !== params.user);
          return { ok: true };
        }
        return { ok: true, channel: this.view(c) };
      }
      case 'conversations.archive':
      case 'conversations.unarchive': {
        const c = this.find(params.channel);
        if (!c) return { ok: false, error: 'channel_not_found' };
        const denied = need(c.is_private ? 'groups:write' : 'channels:manage');
        if (denied) return denied;
        const archive = method === 'conversations.archive';
        if (archive && c.name === 'general') return { ok: false, error: 'cant_archive_general' };
        if (archive === c.is_archived) return { ok: false, error: archive ? 'already_archived' : 'not_archived' };
        c.is_archived = archive;
        return { ok: true };
      }
      case 'conversations.leave': {
        const c = this.find(params.channel);
        if (!c) return { ok: false, error: 'channel_not_found' };
        const denied = need(c.is_private ? 'groups:write' : 'channels:write');
        if (denied) return denied;
        if (c.name === 'general') return { ok: false, error: 'cant_leave_general' };
        if (!c.members.includes(this.self.id)) return { ok: true, not_in_channel: true };
        if (c.is_private && c.members.length === 1) return { ok: false, error: 'last_member' };
        c.members = c.members.filter((m) => m !== this.self.id);
        return { ok: true };
      }
      case 'conversations.invite': {
        const c = this.find(params.channel);
        if (!c) return { ok: false, error: 'channel_not_found' };
        const denied = need(c.is_private ? 'groups:write.invites' : 'channels:write.invites');
        if (denied) return denied;
        if (!c.members.includes(this.self.id)) return { ok: false, error: 'not_in_channel' };
        const ids = (params.users ?? '').split(',');
        for (const id of ids) {
          if (this.inviteErrors[id]) return { ok: false, error: this.inviteErrors[id] };
          if (c.members.includes(id)) return { ok: false, error: 'already_in_channel' };
          if (!this.users.some((u) => u.id === id)) return { ok: false, error: 'user_not_found' };
        }
        c.members.push(...ids);
        return { ok: true, channel: this.view(c) };
      }
      case 'users.conversations': {
        const types = (params.types ?? 'public_channel').split(',') as Kind[];
        for (const t of types) {
          const denied = need(READ_SCOPE[t]);
          if (denied) return denied;
        }
        const mine = this.channels.filter((c) => c.members.includes(this.self.id)
          && types.includes(kindOf(c)) && (params.exclude_archived !== 'true' || !c.is_archived));
        return this.page(mine.map((c) => this.view(c)), params.cursor, 'channels');
      }
      case 'conversations.history': {
        const c = this.find(params.channel);
        if (!c) return { ok: false, error: 'channel_not_found' };
        const denied = need(HISTORY_SCOPE[kindOf(c)]);
        if (denied) return denied;
        if (this.historyErrors[c.id]) return { ok: false, error: this.historyErrors[c.id] };
        const listed = c.messages
          .filter((m) => (!m.thread_ts || m.thread_ts === m.ts || m.subtype === 'thread_broadcast')
            && inWindow(m.ts, params.oldest, params.latest, params.inclusive === 'true'))
          .sort(byTs).reverse()
          .map((m) => this.withReplyCount(c, m));
        return this.page(listed, params.cursor, 'messages');
      }
      case 'conversations.replies': {
        const c = this.find(params.channel);
        if (!c) return { ok: false, error: 'channel_not_found' };
        const denied = need(HISTORY_SCOPE[kindOf(c)]);
        if (denied) return denied;
        const parent = c.messages.find((m) => m.ts === params.ts);
        if (!parent) return { ok: false, error: 'thread_not_found' };
        const thread = [parent, ...c.messages.filter((m) => m.thread_ts === params.ts && m.ts !== params.ts).sort(byTs)]
          .map((m) => this.withReplyCount(c, m));
        if (params.limit === '1') return { ok: true, messages: thread.slice(0, 1), has_more: thread.length > 1 };
        return this.page(thread, params.cursor, 'messages');
      }
      case 'search.messages': {
        const denied = need('search:read');
        if (denied) return denied;
        const matches = this.searchMatches ?? this.search(params.query ?? '');
        const page = Number(params.page ?? '1');
        const size = this.searchPageSize;
        return {
          ok: true,
          messages: {
            matches: matches.slice((page - 1) * size, page * size),
            paging: { count: size, total: matches.length, page, pages: Math.max(1, Math.ceil(matches.length / size)) },
          },
        };
      }
      case 'files.list': {
        const denied = need('files:read');
        if (denied) return denied;
        const page = Number(params.page ?? '1');
        const size = this.filesPageSize;
        // Like Slack: pages over every file, then keeps the asked type.
        const all = [...this.canvases.map((c) => this.canvasFile(c)), ...this.otherFiles]
          .filter((f) => !params.user || f.user === params.user);
        const slice = all.slice((page - 1) * size, page * size);
        const files = params.types === 'canvas' ? slice.filter((f) => f.filetype === 'quip') : slice;
        return { ok: true, files, paging: { count: size, total: all.length, page, pages: Math.max(1, Math.ceil(all.length / size)) } };
      }
      case 'files.info': {
        const denied = need('files:read');
        if (denied) return denied;
        const canvas = this.canvases.find((c) => c.id === params.file);
        if (canvas) return { ok: true, file: this.canvasFile(canvas) };
        const file = this.otherFiles.find((f) => f.id === params.file);
        return file ? { ok: true, file } : { ok: false, error: 'file_not_found' };
      }
      case 'canvases.create': {
        const denied = need('canvases:write');
        if (denied) return denied;
        const markdown = params.document_content ? (JSON.parse(params.document_content) as { markdown: string }).markdown : '';
        return { ok: true, canvas_id: this.addCanvas({ title: params.title ?? 'Untitled', markdown }).id };
      }
      case 'conversations.canvases.create': {
        const denied = need('canvases:write');
        if (denied) return denied;
        const channel = this.find(params.channel_id);
        if (!channel) return { ok: false, error: 'channel_not_found' };
        if (channel.canvas) return { ok: false, error: 'channel_canvas_already_exists' };
        const markdown = params.document_content ? (JSON.parse(params.document_content) as { markdown: string }).markdown : '';
        const canvas = this.addCanvas({ title: '', markdown, channel: channel.id });
        channel.canvas = canvas.id;
        return { ok: true, canvas_id: canvas.id };
      }
      case 'canvases.edit': {
        const denied = need('canvases:write');
        if (denied) return denied;
        const canvas = this.canvases.find((c) => c.id === params.canvas_id);
        if (!canvas) return { ok: false, error: 'canvas_not_found' };
        const changes = JSON.parse(params.changes ?? '[]') as Record<string, any>[];
        for (const change of changes) {
          if (change.operation === 'replace' && !change.section_id) canvas.markdown = change.document_content.markdown;
          else if (change.operation === 'rename') canvas.title = change.title_content.markdown;
          else return { ok: false, error: 'invalid_arguments' };
        }
        this.edits.push({ id: canvas.id, changes });
        return { ok: true };
      }
      case 'canvases.access.set':
      case 'canvases.access.delete': {
        const denied = need('canvases:write');
        if (denied) return denied;
        const canvas = this.canvases.find((c) => c.id === params.canvas_id);
        if (!canvas) return { ok: false, error: 'canvas_not_found' };
        this.accessCalls.push({ method, params });
        // Like Slack: users or channels, not both, 1 to 20 ids.
        if (params.user_ids && params.channel_ids) return { ok: false, error: 'invalid_arguments' };
        const ids = JSON.parse(params.user_ids ?? params.channel_ids ?? '[]') as string[];
        if (ids.length === 0 || ids.length > 20) return { ok: false, error: 'invalid_arguments' };
        const failing = ids.find((id) => this.accessErrors[id]);
        if (failing) return { ok: false, error: this.accessErrors[failing] };
        for (const id of ids) {
          if (method === 'canvases.access.set') canvas.access[id] = params.access_level;
          else delete canvas.access[id];
        }
        return { ok: true };
      }
      case 'canvases.delete': {
        const denied = need('canvases:write');
        if (denied) return denied;
        const index = this.canvases.findIndex((c) => c.id === params.canvas_id);
        if (index < 0) return { ok: false, error: 'canvas_not_found' };
        this.canvases.splice(index, 1);
        return { ok: true };
      }
      default:
        return { ok: false, error: 'unknown_method' };
    }
  }

  /** Private channels are visible only to their members, as for a real user token. */
  private visible(c: FakeChannel): boolean {
    return (!c.is_private && !c.is_im && !c.is_mpim) || c.members.includes(this.self.id);
  }

  private canvasFile(c: FakeCanvas): Record<string, unknown> {
    return {
      id: c.id, title: c.title, name: c.title, filetype: 'quip', pretty_type: 'Canvas', user: c.user,
      created: c.created, updated: c.updated, permalink: `https://example.slack.com/docs/T0001/${c.id}`,
      url_private_download: this.downloadUrlFor(c), linked_channel_id: c.channel ?? null,
    };
  }

  private download(url: string, authorization: string | null): Response {
    if (this.downloadAnswer) {
      const a = this.downloadAnswer;
      return new Response(a.body ?? '', { status: a.status, headers: { 'Content-Type': a.contentType ?? 'text/html; charset=utf-8' } });
    }
    if (authorization !== `Bearer ${TOKEN}`) return new Response('', { status: 403 });
    const canvas = this.canvases.find((c) => url === this.downloadUrlFor(c));
    if (!canvas) return new Response('', { status: 404 });
    return new Response(canvas.html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  private withReplyCount(c: FakeChannel, m: FakeMessage): Record<string, unknown> {
    const count = c.messages.filter((r) => r.thread_ts === m.ts && r.ts !== m.ts).length;
    return count > 0 ? { ...m, thread_ts: m.ts, reply_count: count } : { ...m };
  }

  /** Real search: whole days, exclusive, over every channel the user can see, including public ones they are not in. */
  private search(query: string): Record<string, unknown>[] {
    const after = /after:(\d{4}-\d{2}-\d{2})/.exec(query)?.[1];
    const before = /before:(\d{4}-\d{2}-\d{2})/.exec(query)?.[1];
    if (!after && !before) return [];
    const from = after ? Date.parse(after) + 86_400_000 : -Infinity;
    const to = before ? Date.parse(before) : Infinity;
    return this.channels.filter((c) => this.visible(c)).flatMap((c) => c.messages
      .filter((m) => Number(m.ts) * 1000 >= from && Number(m.ts) * 1000 < to)
      .map(({ thread_ts, ...m }) => ({
        ...m,
        channel: { id: c.id, name: c.name },
        permalink: `https://hex-rays.slack.com/archives/${c.id}/p${m.ts.replace('.', '')}`
          + (thread_ts && thread_ts !== m.ts ? `?thread_ts=${thread_ts}&cid=${c.id}` : ''),
      })))
      .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  }

  private find(id: string | undefined): FakeChannel | undefined {
    const c = this.channels.find((x) => x.id === id);
    return c && this.visible(c) ? c : undefined;
  }

  private view(c: FakeChannel): Record<string, unknown> {
    const { members, messages, canvas, ...rest } = c;
    return { ...rest, topic: { ...c.topic }, purpose: { ...c.purpose }, is_member: members.includes(this.self.id),
      properties: canvas ? { canvas: { file_id: canvas } } : {} };
  }

  private page(items: unknown[], cursor: string | undefined, key: string): Record<string, unknown> {
    const start = cursor ? Number(cursor.replace('page-', '')) : 0;
    const next = start + this.channelPageSize;
    return { ok: true, [key]: items.slice(start, next), response_metadata: { next_cursor: next < items.length ? `page-${next}` : '' } };
  }

  private json(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
}
