import { writeJson } from '../../utils/output';
import { countMessages } from './messages';
import type {
  SlackAttachmentsResult,
  SlackChannelChange,
  SlackChannel,
  SlackFile,
  SlackConversationMessages,
  SlackMembershipResult,
  SlackMessage,
  SlackMessagesResult,
  SlackSendResult,
  SlackThreadParent,
  SlackUser,
} from './types';

export function printSlackSendResult(result: SlackSendResult): void {
  console.log('Message sent');
  if (result.isJsonPayload) {
    console.log('Type: Block Kit payload');
  }
}

/** `--json` writes `data`; otherwise `text` prints for people. */
function emit(json: boolean | undefined, data: unknown, text: () => void): void {
  if (json) writeJson(data, 2);
  else text();
}

function userFlags(user: SlackUser): string {
  const flags: string[] = [];
  if (user.isOwner) flags.push('owner');
  else if (user.isAdmin) flags.push('admin');
  if (user.isRestricted) flags.push('guest');
  if (user.isBot) flags.push('bot');
  if (user.deleted) flags.push('deactivated');
  return flags.length > 0 ? ` [${flags.join(', ')}]` : '';
}

function userLines(user: SlackUser): void {
  console.log(`${user.realName || user.name}${userFlags(user)}`);
  console.log(`  ID: ${user.id}`);
  console.log(`  Display name: ${user.displayName ?? '(none)'}`);
  if (user.email) console.log(`  Email: ${user.email}`);
  if (user.title) console.log(`  Title: ${user.title}`);
}

export function printSlackUserList(users: SlackUser[], json?: boolean): void {
  emit(json, { users }, () => {
    if (users.length === 0) {
      console.log('No users found');
      return;
    }
    console.log(`Users (${users.length})\n`);
    for (const user of users) userLines(user);
  });
}

export function printSlackUser(user: SlackUser, json?: boolean): void {
  emit(json, { user }, () => userLines(user));
}

function channelLines(channel: SlackChannel): void {
  const flags = [channel.isPrivate ? 'private' : 'public'];
  if (channel.isArchived) flags.push('archived');
  if (channel.isMember) flags.push('member');
  console.log(`#${channel.name} [${flags.join(', ')}]`);
  console.log(`  ID: ${channel.id}`);
  if (channel.numMembers !== undefined) console.log(`  Members: ${channel.numMembers}`);
  if (channel.topic) console.log(`  Topic: ${channel.topic}`);
  if (channel.purpose) console.log(`  Purpose: ${channel.purpose}`);
}

export function printSlackChannelList(channels: SlackChannel[], json?: boolean): void {
  emit(json, { channels }, () => {
    if (channels.length === 0) {
      console.log('No channels found');
      return;
    }
    console.log(`Channels (${channels.length})\n`);
    for (const channel of channels) channelLines(channel);
  });
}

export function printSlackChannel(channel: SlackChannel, json?: boolean, heading?: string): void {
  emit(json, { channel }, () => {
    if (heading) console.log(heading);
    channelLines(channel);
  });
}

export function printSlackChannelMembers(channel: SlackChannel, members: SlackUser[], json?: boolean): void {
  emit(json, { channel, members }, () => {
    console.log(`Members of #${channel.name} (${members.length})\n`);
    for (const user of members) console.log(`${user.id}  ${user.realName || user.name}${user.email ? ` <${user.email}>` : ''}${userFlags(user)}`);
  });
}

const who = (user: SlackUser) => user.email ?? user.id;

export function printSlackMembership(result: SlackMembershipResult, verb: 'Invited' | 'Uninvited', json?: boolean): void {
  emit(json, result, () => {
    const [preposition, skippedReason] = verb === 'Invited' ? ['to', 'already a member'] : ['from', 'not a member'];
    if (result.changed.length > 0) console.log(`${verb} ${preposition} #${result.channel.name}: ${result.changed.map(who).join(', ')}`);
    for (const user of result.skipped) console.log(`Skipped ${who(user)}: ${skippedReason}`);
    if (result.changed.length === 0) console.log('Nothing was changed');
  });
}

export function printSlackArchive(result: SlackChannelChange, verb: 'Archived' | 'Unarchived', json?: boolean): void {
  emit(json, result, () => {
    if (result.changed) console.log(`${verb} #${result.channel.name} (${result.channel.id})`);
    else console.log(`#${result.channel.name} is ${verb === 'Archived' ? 'already' : 'not'} archived; nothing was changed`);
  });
}

export function printSlackLeave(results: SlackChannelChange[], json?: boolean): void {
  emit(json, { results }, () => {
    for (const { channel, changed } of results) {
      console.log(changed ? `Left #${channel.name} (${channel.id})` : `Skipped #${channel.name}: not a member`);
    }
  });
}

const pad = (n: number) => String(n).padStart(2, '0');
/** A Slack timestamp as MM-DD HH:MM, local time. */
function when(ts: string): string {
  const d = new Date(Number(ts) * 1000);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** Text and file names; continuation lines are indented under the first. */
function body(m: SlackMessage, indent: number): string {
  return [m.text, ...m.files.map((f) => `[file: ${f.name}]`)].filter(Boolean).join(' ').replace(/\n/g, `\n${' '.repeat(indent)}`);
}
/** An older thread's first words; undefined text means the parent could not be read. */
function preview(parent: SlackThreadParent): string {
  if (parent.text === undefined) return '(no longer available)';
  const words = parent.text.split(/\s+/).filter(Boolean);
  const files = (parent.files ?? []).map((f) => `[file: ${f.name}]`);
  if (words.length === 0) return files.join(' ') || '(no text)';
  return `"${words.slice(0, 6).join(' ')}${words.length > 6 ? ' …' : ''}"`;
}
function headingOf(c: SlackConversationMessages): string {
  if (c.type === 'dm') return `@${c.name}`;
  if (c.type === 'group') return c.name;
  return `#${c.name}`;
}

export function printSlackMessages(result: SlackMessagesResult, json?: boolean): void {
  emit(json, result, () => {
    const all = result.conversations.flatMap((c) => c.messages);
    const topLevel = all.filter((m) => !m.parent).length;
    const replies = all.reduce((n, m) => n + m.replies.length, 0) + all.filter((m) => m.parent).length;
    console.log(`Slack messages ${result.since.slice(0, 10)} → ${result.until.slice(0, 10)}: `
      + `${plural(result.conversations.length, 'conversation')}, ${plural(topLevel, 'message')}, ${plural(replies, 'reply', 'replies')}`);
    for (const c of result.conversations) {
      console.log(`\n${headingOf(c)}  (${plural(countMessages(c), 'message')})`);
      let thread: string | undefined;
      for (const m of c.messages) {
        if (m.parent) {
          if (m.parent.ts !== thread) {
            thread = m.parent.ts;
            console.log(`${when(m.parent.ts)}  thread by ${m.parent.userName ?? 'unknown'}: ${preview(m.parent)}`);
          }
        } else {
          console.log(`${when(m.ts)}  ${m.userName}: ${body(m, 13)}`);
        }
        const replyLines = m.parent ? [m] : m.replies;
        for (const r of replyLines) console.log(`  ↳ ${when(r.ts)}  ${r.userName}: ${body(r, 17)}`);
      }
    }
  });
}

export function printSlackDownload(path: string, bytes: number, file: SlackFile, json?: boolean): void {
  emit(json, { path, bytes, file }, () => {
    console.log(`Saved: ${path}`);
    console.log(`Bytes: ${bytes}`);
    if (file.mimetype) console.log(`Type: ${file.mimetype}`);
  });
}

export function printSlackAttachments(result: SlackAttachmentsResult, dryRun: boolean, json?: boolean): void {
  const { entries: _entries, ...summary } = result;
  emit(json, summary, () => {
    console.log(`${dryRun ? 'Would save' : 'Saved'} ${dryRun ? result.files - result.skipped : result.saved} of ${plural(result.files, 'file')} `
      + `from ${plural(result.messagesWithFiles, 'message')} into ${result.outDir}`);
    if (result.skipped > 0) console.log(`Skipped: ${result.skipped} (deleted, hidden or stored outside Slack)`);
    if (result.failed > 0) console.log(`Failed: ${result.failed} (see the error column in the manifest)`);
    console.log(`Manifest: ${result.manifestJson}, ${result.manifestCsv}`);
  });
}
