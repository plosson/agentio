import { CliError } from '../../utils/errors';
import { htmlToCanvasMarkdown } from './canvas-markdown';
import { isChannelId, isUserId, type SlackClient } from './client';
import type { SlackCanvas, SlackCanvasAccessLevel, SlackCanvasContent, SlackCanvasTargets } from './types';

export const CANVAS_ARGUMENT = 'Canvas id (F…), canvas link, or #channel for that channel\'s canvas';

const CANVAS_ID = /^F[A-Z0-9]{6,}$/;
const ACCESS_LEVELS: SlackCanvasAccessLevel[] = ['read', 'write', 'owner'];

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

/** The canvas `<canvas>` names: an id, a canvas link, or a channel for its canvas. */
export async function resolveCanvasId(client: SlackClient, input: string): Promise<string> {
  const id = canvasIdFrom(input);
  if (id) return id;
  const key = input.trim();
  if (!isChannelKey(key)) {
    throw new CliError('INVALID_PARAMS', `"${key}" is not a canvas id, a canvas link or a #channel`,
      'Canvas ids start with F; see: agentio slack canvases list');
  }
  const channel = await client.getChannel(key);
  const canvasId = await client.channelCanvasId(channel.id);
  if (!canvasId) {
    throw new CliError('NOT_FOUND', `#${channel.name} has no canvas`, `Create one with: agentio slack canvases create --channel ${channel.name}`);
  }
  return canvasId;
}

/** A canvas as Markdown, with the parts Markdown cannot carry back. */
export async function readCanvas(client: SlackClient, input: string): Promise<SlackCanvasContent> {
  const { downloadUrl, ...canvas } = await client.canvasInfo(await resolveCanvasId(client, input));
  return { ...canvas, ...htmlToCanvasMarkdown(await client.downloadCanvasHtml(downloadUrl)) };
}

/** Canvases for `list`: newest edit first, with their owners' names. */
export async function findCanvases(client: SlackClient, options: { channel?: string; mine?: boolean }): Promise<SlackCanvas[]> {
  const user = options.mine ? (await client.authTest()).userId : undefined;
  let canvases: SlackCanvas[];
  if (options.channel) {
    const channel = await client.getChannel(options.channel);
    const id = await client.channelCanvasId(channel.id);
    canvases = [];
    if (id) {
      const { downloadUrl: _, ...info } = await client.canvasInfo(id);
      if (!user || info.owner === user) canvases.push({ ...info, channelId: channel.id });
    }
  } else {
    canvases = await client.listCanvases(user ? { user } : {});
  }
  const names = new Map<string, string>();
  for (const owner of new Set(canvases.map((c) => c.owner).filter((o): o is string => !!o))) {
    try {
      const u = await client.getUser(owner);
      names.set(owner, u.displayName || u.realName || u.name);
    } catch (error) {
      if (!(error instanceof CliError) || error.code !== 'NOT_FOUND') throw error;
      names.set(owner, owner);
    }
  }
  return canvases
    .map((c) => (c.owner ? { ...c, ownerName: names.get(c.owner) } : c))
    .sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));
}

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
