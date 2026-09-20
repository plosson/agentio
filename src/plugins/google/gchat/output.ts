import type { GChatMessage, GChatSpace, GChatMember, GChatUser } from './types';

// Google Chat specific formatters
export function printGChatSendResult(result: { messageId: string; spaceId?: string; isJsonPayload?: boolean }): void {
  console.log('Message sent');
  console.log(`ID: ${result.messageId}`);
  if (result.spaceId) {
    console.log(`Space: ${result.spaceId}`);
  }
  if (result.isJsonPayload) {
    console.log('Type: JSON payload');
  }
}

export function printGChatMessageList(messages: GChatMessage[]): void {
  if (messages.length === 0) {
    console.log('No messages found');
    return;
  }

  console.log(`Messages (${messages.length})\n`);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    console.log(`[${i + 1}] ${msg.name}`);
    if (msg.sender) {
      const from = msg.sender.email
        ? `${msg.sender.displayName} <${msg.sender.email}>`
        : msg.sender.displayName || 'Unknown';
      console.log(`    From: ${from}`);
    }
    if (msg.text) {
      const snippet = msg.text.length > 100 ? msg.text.substring(0, 100) + '...' : msg.text;
      console.log(`    > ${snippet}`);
    }
    console.log(`    Date: ${msg.createTime}`);
    console.log('');
  }
}

export function printGChatMessage(msg: GChatMessage): void {
  console.log(`ID: ${msg.name}`);
  if (msg.sender) {
    const from = msg.sender.email
      ? `${msg.sender.displayName} <${msg.sender.email}>`
      : msg.sender.displayName || 'Unknown';
    console.log(`From: ${from}`);
  }
  console.log(`Date: ${msg.createTime}`);
  if (msg.thread) {
    console.log(`Thread: ${msg.thread.name}`);
  }
  if (msg.text) {
    console.log('---');
    console.log(msg.text);
  }
}

export function printGChatSpaceList(spaces: GChatSpace[]): void {
  if (spaces.length === 0) {
    console.log('No spaces found');
    return;
  }

  console.log(`Spaces (${spaces.length})\n`);

  for (const space of spaces) {
    const spaceId = space.name.replace('spaces/', '');
    const name = space.displayName || 'Unnamed';
    const desc = space.description ? `  - ${space.description}` : '';
    console.log(`[${space.type}] ${spaceId}  ${name}${desc}`);
  }
}

export function printGChatMemberList(members: GChatMember[]): void {
  if (members.length === 0) {
    console.log('No members found');
    return;
  }

  console.log(`Members (${members.length})\n`);

  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    const label = m.user?.displayName || m.user?.name || '(unknown)';
    const email = m.user?.email ? ` <${m.user.email}>` : '';
    const roleTag = m.role === 'ROLE_MANAGER' ? ' [MANAGER]' : '';
    const typeTag = m.memberType === 'BOT' ? ' [BOT]' : '';
    const stateTag = m.state !== 'JOINED' ? ` [${m.state}]` : '';
    console.log(`[${i + 1}] ${label}${email}${roleTag}${typeTag}${stateTag}`);
    if (m.user?.name) {
      console.log(`    User ID: ${m.user.name}`);
    }
    if (m.user?.organizations?.length) {
      const org = m.user.organizations[0];
      const parts = [org.title, org.department, org.name].filter(Boolean);
      if (parts.length) console.log(`    ${parts.join(' · ')}`);
    }
  }
}

export function printGChatUser(user: GChatUser): void {
  console.log(`ID: ${user.name}`);
  if (user.displayName) console.log(`Name: ${user.displayName}`);
  if (user.email) console.log(`Email: ${user.email}`);
  if (user.phoneNumbers?.length) {
    console.log(`Phone: ${user.phoneNumbers.join(', ')}`);
  }
  if (user.organizations?.length) {
    console.log('Organizations:');
    for (const org of user.organizations) {
      const parts = [org.title, org.department, org.name].filter(Boolean);
      if (parts.length) console.log(`  - ${parts.join(' · ')}`);
    }
  }
  if (user.locations?.length) {
    console.log(`Location: ${user.locations.join(', ')}`);
  }
  if (user.photoUrl) {
    console.log(`Photo: ${user.photoUrl}`);
  }
}
