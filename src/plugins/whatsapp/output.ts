import type { ChatSummary, ContactView, MessageView, ReadResult, SendResult, WhatsAppStatus } from './types';

// WhatsApp specific formatters

const when = (at: number | undefined) => (at ? new Date(at * 1000).toISOString().replace('.000Z', 'Z') : 'unknown');

/** How a chat or person reads: its name and number, or its hidden ID when no number is known. */
function who(item: { name?: string; phone?: string; id: string }): string {
  const handle = item.phone ?? item.id;
  return item.name ? `${item.name} (${handle})` : handle;
}

export function printWhatsAppStatus(profile: string, where: string, status: WhatsAppStatus): void {
  console.log(`Profile: ${profile}${status.readOnly ? ' [read-only]' : ''}`);
  console.log(`Daemon: ${where}`);
  console.log(`Session: ${status.state}`);
  if (status.account) console.log(`Account: ${status.account}`);
  if (status.detail) console.log(`Detail: ${status.detail}`);
}

export function printConversations(chats: ChatSummary[]): void {
  if (chats.length === 0) {
    console.log('No conversations found');
    return;
  }
  console.log(`Conversations (${chats.length})\n`);
  chats.forEach((chat, i) => {
    console.log(`[${i + 1}] ${who(chat)}${chat.isGroup ? ' [group]' : ''}${chat.unread ? ` - ${chat.unread} unread` : ''}`);
    console.log(`    ID: ${chat.id}`);
    if (chat.lastMessage !== undefined) console.log(`    > ${chat.lastMessage}`);
    console.log(`    Date: ${when(chat.lastMessageAt)}`);
    console.log('');
  });
}

function printMessage(message: MessageView): void {
  const from = message.fromMe ? 'me' : message.senderName ? `${message.senderName} (${message.sender})` : message.sender;
  console.log(`[${when(message.at)}] ${from}: ${message.text}`);
}

export function printReadResult(result: ReadResult): void {
  console.log(`Chat: ${who(result.chat)}${result.chat.isGroup ? ' [group]' : ''}`);
  console.log(`ID: ${result.chat.id}`);
  if (result.messages.length === 0) {
    console.log('\nNo messages stored for this chat');
    return;
  }
  console.log(`Messages (${result.messages.length}), oldest first\n`);
  result.messages.forEach(printMessage);
  if (result.receiptsSent > 0) console.error(`\nMarked ${result.receiptsSent} message(s) as read`);
}

export function printSendResult(result: SendResult): void {
  console.log('Message sent');
  console.log(`ID: ${result.id}`);
  console.log(`To: ${result.toName ? `${result.toName} (${result.to})` : result.to}`);
  console.log(`Date: ${when(result.timestamp)}`);
}

export function printContacts(contacts: ContactView[], query?: string): void {
  if (contacts.length === 0) {
    console.log(query ? `No known name matches "${query}"` : 'No names known yet');
    return;
  }
  console.log(`Known names (${contacts.length})\n`);
  for (const contact of contacts) {
    console.log(`${contact.name}  ${contact.phone ?? contact.jid}  ${contact.source}`);
  }
}

/** The 8 characters WhatsApp returns, grouped the way the phone shows them. */
export function formatPairingCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}
