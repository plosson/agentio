import { CliError } from '../../utils/errors';
import { displayNameOf, isChannelId, isUserId, type SlackClient } from './client';
import type { SlackCanvas, SlackCanvasAccessLevel, SlackCanvasContent, SlackCanvasList, SlackCanvasTargets, SlackChannel } from './types';

export const CANVAS_ARGUMENT = 'Canvas id (F…), canvas link, or #channel for that channel\'s canvas';

const CANVAS_ID = /^F[A-Z0-9]{6,}$/;
const ACCESS_LEVELS: SlackCanvasAccessLevel[] = ['read', 'write', 'owner'];
/** From this many owners, list reads users.list once instead of looking each one up. */
const BULK_OWNERS_MIN = 3;

/** The canvas id in an id or a canvas link on a Slack host; undefined for anything else. */
export function canvasIdFrom(input: string): string | undefined {
  const key = input.trim();
  if (CANVAS_ID.test(key)) return key;
  let url: URL;
  try {
    url = new URL(key);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || !(url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com'))) return undefined;
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments[0] !== 'docs' && segments[0] !== 'files') return undefined;
  return segments.find((s) => CANVAS_ID.test(s));
}

const isChannelKey = (key: string) => key.startsWith('#') || isChannelId(key);

/** A channel, by #name or id, and the id of its canvas if it has one. */
async function channelCanvas(client: SlackClient, key: string): Promise<{ channel: SlackChannel; canvasId?: string }> {
  const channel = await client.getChannel(key);
  return { channel, canvasId: await client.channelCanvasId(channel.id) };
}

/** The canvas `<canvas>` names: an id, a canvas link, or a channel for its canvas. */
export async function resolveCanvasId(client: SlackClient, input: string): Promise<string> {
  const id = canvasIdFrom(input);
  if (id) return id;
  const key = input.trim();
  if (!isChannelKey(key)) {
    throw new CliError('INVALID_PARAMS', `"${key}" is not a canvas id, a canvas link or a #channel`,
      'Canvas ids start with F; see: agentio slack canvases list');
  }
  const { channel, canvasId } = await channelCanvas(client, key);
  if (!canvasId) {
    throw new CliError('NOT_FOUND', `#${channel.name} has no canvas`, `Create one with: agentio slack canvases create --channel ${channel.name}`);
  }
  return canvasId;
}

/** A canvas as Markdown, with the parts Markdown cannot carry back. */
export async function readCanvas(client: SlackClient, input: string): Promise<SlackCanvasContent> {
  const { canvas, html } = await client.canvasHtml(await resolveCanvasId(client, input));
  // Loaded here, not at startup: turndown and its HTML parser are only needed to read a canvas.
  const { htmlToCanvasMarkdown } = await import('./canvas-markdown');
  return { ...canvas, ...htmlToCanvasMarkdown(html) };
}

/** Canvases for `list`: newest edit first, with their owners' names. */
export async function findCanvases(client: SlackClient, options: { channel?: string; mine?: boolean }): Promise<SlackCanvasList> {
  const user = options.mine ? (await client.authTest()).userId : undefined;
  let canvases: SlackCanvas[];
  let truncated = false;
  if (options.channel) {
    const { channel, canvasId } = await channelCanvas(client, options.channel);
    canvases = [];
    if (canvasId) {
      const canvas = await client.canvasInfo(canvasId);
      if (!user || canvas.owner === user) canvases.push({ ...canvas, channelId: channel.id });
    }
  } else {
    ({ canvases, truncated } = await client.listCanvases({ user }));
  }
  const names = await ownerNames(client, new Set(canvases.map((c) => c.owner).filter((o): o is string => !!o)));
  const named = canvases
    .map((c) => (c.owner ? { ...c, ownerName: names.get(c.owner) } : c))
    .sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));
  return { canvases: named, truncated };
}

/** Owners' names by id; an owner Slack no longer knows keeps their id. */
async function ownerNames(client: SlackClient, owners: Set<string>): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (owners.size >= BULK_OWNERS_MIN) {
    const users = new Map((await client.listUsers({ includeDeleted: true, includeBots: true })).map((u) => [u.id, displayNameOf(u)]));
    for (const owner of owners) names.set(owner, users.get(owner) ?? owner);
    return names;
  }
  for (const owner of owners) {
    try {
      names.set(owner, displayNameOf(await client.getUser(owner)));
    } catch (error) {
      if (!(error instanceof CliError) || error.code !== 'NOT_FOUND') throw error;
      names.set(owner, owner);
    }
  }
  return names;
}

/** Share targets, for messages. */
export const describeTargets = (targets: SlackCanvasTargets) => [...targets.users, ...targets.channels].join(', ');

/** Share targets as ids, split into users and channels, each once. Comma-separated values are allowed. */
export async function resolveTargets(client: SlackClient, inputs: string[]): Promise<SlackCanvasTargets> {
  const users = new Set<string>();
  const channels = new Set<string>();
  for (const key of inputs.flatMap((i) => i.split(',')).map((i) => i.trim()).filter(Boolean)) {
    if (isChannelKey(key)) channels.add((await client.getChannel(key)).id);
    else if (isUserId(key)) users.add(key);
    else if (key.includes('@')) users.add((await client.getUser(key)).id);
    else {
      throw new CliError('INVALID_PARAMS', `"${key}" is neither a user (U…, or an email address) nor a channel (#name, C…)`);
    }
  }
  if (users.size === 0 && channels.size === 0) throw new CliError('INVALID_PARAMS', 'No users or channels were given');
  return { users: [...users], channels: [...channels] };
}

/** --level: read, write or owner; read when absent. */
export function checkAccessLevel(input: string | undefined): SlackCanvasAccessLevel {
  if (input === undefined) return 'read';
  if (!ACCESS_LEVELS.includes(input as SlackCanvasAccessLevel)) {
    throw new CliError('INVALID_PARAMS', `Unknown --level: ${input || '(empty)'}`, `Use one of: ${ACCESS_LEVELS.join(', ')}`);
  }
  return input as SlackCanvasAccessLevel;
}
