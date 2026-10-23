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
}

export function fakeChannel(id: string, name: string, overrides: Partial<FakeChannel> = {}): FakeChannel {
  return { id, name, is_private: false, is_archived: false, topic: { value: '' }, purpose: { value: '' }, members: ['U0ADMIN'], ...overrides };
}

const ALL_SCOPES = [
  'users:read', 'users:read.email', 'channels:read', 'groups:read',
  'channels:manage', 'groups:write', 'channels:write.invites', 'groups:write.invites', 'channels:write',
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
  private readonly original = globalThis.fetch;

  constructor() {
    globalThis.fetch = this.handle.bind(this) as typeof fetch;
  }

  stop(): void {
    globalThis.fetch = this.original;
  }

  private async handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    const params = Object.fromEntries(new URLSearchParams(typeof init?.body === 'string' ? init.body : ''));
    this.log.push({ url, method: init?.method ?? 'GET', authorization: headers.get('authorization'), contentType: headers.get('content-type'), params });

    if (!url.startsWith('https://slack.com/api/')) throw new TypeError(`blocked: ${url}`);

    const next = this.queue.shift();
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
      default:
        return { ok: false, error: 'unknown_method' };
    }
  }

  /** Private channels are visible only to their members, as for a real user token. */
  private visible(c: FakeChannel): boolean {
    return !c.is_private || c.members.includes(this.self.id);
  }

  private find(id: string | undefined): FakeChannel | undefined {
    const c = this.channels.find((x) => x.id === id);
    return c && this.visible(c) ? c : undefined;
  }

  private view(c: FakeChannel): Record<string, unknown> {
    const { members, ...rest } = c;
    return { ...rest, topic: { ...c.topic }, purpose: { ...c.purpose }, is_member: members.includes(this.self.id) };
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
