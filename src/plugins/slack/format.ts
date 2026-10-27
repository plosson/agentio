/**
 * Slack's message markup made readable. In Slack's text, a literal <, > or &
 * is always escaped, so anything between < and > is markup:
 *
 *   <@U123> or <@U123|old>     →  @name
 *   <#C123|eng> or <#C123>      →  #eng
 *   <!here>, <!channel>, <!everyone>  →  @here, @channel, @everyone
 *   <!subteam^S123|@team>       →  @team
 *   <!date^1700000000^{date}|Nov 14>  →  Nov 14 (Slack's fallback text)
 *   <https://x.dev|the docs>    →  the docs (https://x.dev)
 *   <https://x.dev> or <https://x.dev|x.dev>  →  https://x.dev
 *   <mailto:a@x.dev|a@x.dev>    →  a@x.dev
 *
 * then &lt; &gt; &amp; become < > &.
 */

export interface SlackTextNames {
  /** User id to the name to show. */
  users: Map<string, string>;
  /** Channel id to its name, for channel links without one. */
  channels: Map<string, string>;
}

const MARKUP = /<([^<>]*)>/g;
const BROADCASTS = new Set(['here', 'channel', 'everyone']);

/** The link's text without its scheme and trailing slash, to tell a bare URL from a real label. */
const bare = (url: string) => url.replace(/^[a-z][a-z0-9+.-]*:(\/\/)?/i, '').replace(/\/$/, '');

function replaceOne(inner: string, names: SlackTextNames): string {
  const bar = inner.indexOf('|');
  const target = bar === -1 ? inner : inner.slice(0, bar);
  const label = bar === -1 ? '' : inner.slice(bar + 1);

  if (target.startsWith('@')) {
    const id = target.slice(1);
    return `@${names.users.get(id) ?? id}`;
  }
  if (target.startsWith('#')) {
    const id = target.slice(1);
    return `#${label || names.channels.get(id) || id}`;
  }
  if (target.startsWith('!')) {
    const command = target.slice(1);
    if (BROADCASTS.has(command)) return `@${command}`;
    if (label) return label;
    const group = /^subteam\^(.+)$/.exec(command);
    return `@${group ? group[1] : command.split('^')[0]}`;
  }
  if (!label || bare(label) === bare(target)) return target.startsWith('mailto:') ? target.slice('mailto:'.length) : target;
  return `${label} (${target})`;
}

export function formatSlackText(text: string, names: SlackTextNames): string {
  return text
    .replace(MARKUP, (_, inner: string) => replaceOne(inner, names))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
