import { writeJson } from '../../utils/output';
import type { SlackChannelChange, SlackChannel, SlackMembershipResult, SlackSendResult, SlackUser } from './types';

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
