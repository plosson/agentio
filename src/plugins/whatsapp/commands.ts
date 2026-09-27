import type { Command } from 'commander';
import qrcode from 'qrcode-terminal';
import { addExamples } from '../../utils/command-tree';
import { requireProfile } from '../../utils/client-factory';
import { CliError, exitCodeForError, handleError } from '../../utils/errors';
import { addJsonOption, printJson } from '../../utils/output';
import { createProfileCommands } from '../../utils/profile-commands';
import { enforceWriteAccess } from '../../utils/read-only';
import { readStdin } from '../../utils/stdin';
import { sleep } from '../../utils/batch';
import { newProfileName } from '../profile-host';
import { isProfileReadOnly } from '../../config/config-manager';
import { sessionTarget } from '../../daemon/client';
import { cancelPairing, pollPairing, startPairing, WhatsAppClient } from './client';
import { parseRecipient } from './records';
import {
  formatPairingCode,
  printContacts,
  printConversations,
  printReadResult,
  printSendResult,
  printWhatsAppStatus,
} from './output';
import type { WhatsAppCredentials } from './types';

const PROFILE_OPTION = 'Profile name (optional if only one profile exists)';

function positiveInteger(name: string) {
  return (raw: string): number => {
    const value = Number(raw);
    if (!/^\d+$/.test(raw.trim()) || !Number.isInteger(value) || value < 1 || value > 500) {
      throw new CliError('INVALID_PARAMS', `${name} must be a whole number from 1 to 500`);
    }
    return value;
  };
}

async function clientFor(profileName?: string): Promise<WhatsAppClient> {
  return new WhatsAppClient(await requireProfile('whatsapp', profileName));
}

/** A pairing that ended without a link: nobody finished it in time. */
export class PairingExpired extends CliError {
  constructor() {
    super('AUTH_FAILED', 'The pairing expired before the phone linked', 'Run the command again, and scan or type the code within two minutes');
    this.name = 'PairingExpired';
  }
}

export interface PairOptions {
  profile?: string;
  phone?: string;
  readOnly?: boolean;
  json?: boolean;
  /** Tests poll faster than a person needs. */
  pollMs?: number;
}

/** Draw a QR code on stderr, over the previous one when the terminal allows. */
function qrDrawer(): (qr: string) => void {
  let lines = 0;
  return (qr) => {
    qrcode.generate(qr, { small: true }, (art) => {
      if (lines > 0 && process.stderr.isTTY) process.stderr.write(`\x1b[${lines}A\x1b[0J`);
      const text = `${art}\nWaiting for the scan… (the code refreshes; Ctrl-C to stop)\n`;
      process.stderr.write(text);
      lines = text.split('\n').length - 1;
    });
  };
}

/**
 * `profile add`: the daemon pairs, and this draws what it hands back. With
 * `json`, stdout carries only events, one per line: a `qr` for every code
 * WhatsApp rotates in, or one `code`, then `paired`, `expired` or `error`.
 */
export async function pairWhatsAppProfile(options: PairOptions): Promise<void> {
  let phone: string | undefined;
  if (options.phone !== undefined) {
    const recipient = parseRecipient(options.phone);
    if (recipient.kind !== 'phone') throw new CliError('INVALID_PARAMS', '--phone must be a number in international format', 'For example: --phone +33612345678');
    phone = recipient.digits;
  }
  const profile = await newProfileName('whatsapp', options, phone ? `+${phone}` : 'whatsapp');
  await startPairing(profile, { ...(phone ? { phone: `+${phone}` } : {}), ...(options.readOnly ? { readOnly: true } : {}) });

  const draw = qrDrawer();
  let lastQr: string | undefined;
  let codeShown = false;
  if (!options.json) {
    console.error(phone
      ? 'On the phone: WhatsApp > Settings > Linked devices > Link a device > Link with phone number instead.'
      : 'On the phone: WhatsApp > Settings > Linked devices > Link a device, then scan this code.');
  }
  const onInterrupt = () => {
    void cancelPairing(profile).catch(() => {}).finally(() => process.exit(130));
  };
  process.once('SIGINT', onInterrupt);
  try {
    for (;;) {
      const state = await pollPairing(profile);
      if (state.state === 'paired') {
        if (options.json) printJson({ event: 'paired', profile, number: state.account });
        else {
          console.log(`Profile "${profile}" paired with ${state.account ?? 'WhatsApp'}`);
          if (options.readOnly) console.log('Access: read-only');
        }
        return;
      }
      if (state.state === 'expired') throw new PairingExpired();
      if (state.state === 'error') throw new CliError('API_ERROR', `Pairing failed: ${state.message}`, 'Run the command again');
      if (state.qr && state.qr !== lastQr) {
        lastQr = state.qr;
        if (options.json) printJson({ event: 'qr', qr: state.qr });
        else draw(state.qr);
      }
      if (state.code && !codeShown) {
        codeShown = true;
        if (options.json) printJson({ event: 'code', code: formatPairingCode(state.code) });
        else console.error(`Enter this code on the phone: ${formatPairingCode(state.code)}`);
      }
      await sleep(options.pollMs ?? 2000);
    }
  } finally {
    process.off('SIGINT', onInterrupt);
  }
}

export function registerWhatsAppCommands(program: Command): void {
  const whatsapp = program
    .command('whatsapp')
    .description('WhatsApp operations, through the agentio daemon');

  addExamples(
    whatsapp
      .command('status')
      .description('Show the daemon, the profile, and its WhatsApp session state')
      .option('--profile <name>', PROFILE_OPTION)
      .action(async (options) => {
        try {
          const client = await clientFor(options.profile);
          const target = sessionTarget();
          printWhatsAppStatus(client.profile, `${target.url} (${target.remote ? 'hub' : 'this machine'})`, await client.status());
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  agentio whatsapp status
  agentio whatsapp status --profile work`,
  );

  addExamples(
    whatsapp
      .command('conversations')
      .aliases(['chats', 'inbox'])
      .description('List conversations, most recent first, with their unread counts')
      .option('--limit <n>', 'How many conversations (1-500)', positiveInteger('--limit'), 20)
      .option('--unread-only', 'Only conversations with unread messages')
      .option('--profile <name>', PROFILE_OPTION)
      .action(async (options) => {
        try {
          const client = await clientFor(options.profile);
          printConversations(await client.conversations({ limit: options.limit, unreadOnly: !!options.unreadOnly }));
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # what is waiting to be read
  agentio whatsapp conversations --unread-only

  # the 5 most recent chats
  agentio whatsapp chats --limit 5`,
  );

  addExamples(
    whatsapp
      .command('send')
      .description('Send a text message to a phone number, a JID, or a known name')
      .argument('<recipient>', 'A number in international format (+33612345678), a JID, or a known name')
      .argument('[message]', 'Message text (or pipe via stdin)')
      .option('--profile <name>', PROFILE_OPTION)
      .action(async (recipient: string, message: string | undefined, options) => {
        try {
          const text = message ?? (await readStdin()) ?? undefined;
          if (!text) throw new CliError('INVALID_PARAMS', 'Message is required. Provide it as an argument or pipe it via stdin.');
          const client = await clientFor(options.profile);
          await enforceWriteAccess('whatsapp', client.profile, 'send message');
          printSendResult(await client.send(recipient, text));
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  agentio whatsapp send +33612345678 "On my way"

  # a name must match exactly one known name; see: agentio whatsapp contacts
  agentio whatsapp send "Alice Martin" "Lunch at 1?"

  # message body from stdin
  echo "Build is green" | agentio whatsapp send 120363000000000000@g.us`,
  );

  addExamples(
    whatsapp
      .command('read')
      .description('Show the last messages of a chat, and mark them as read')
      .argument('<chat>', 'A number in international format, a JID, or a known name')
      .option('--last <n>', 'How many messages (1-500)', positiveInteger('--last'), 20)
      .option('--no-read-receipts', 'Do not mark the messages as read (no blue ticks)')
      .option('--profile <name>', PROFILE_OPTION)
      .action(async (chat: string, options) => {
        try {
          const client = await clientFor(options.profile);
          // A read-only profile never sends receipts; the daemon enforces it too.
          const receipts = options.readReceipts !== false && !(await isProfileReadOnly('whatsapp', client.profile));
          printReadResult(await client.read(chat, { last: options.last, receipts }));
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  agentio whatsapp read +33612345678 --last 10

  # look without the sender seeing blue ticks
  agentio whatsapp read "Alice Martin" --no-read-receipts`,
  );

  addExamples(
    whatsapp
      .command('contacts')
      .description('List the names send and read resolve against, with their number or hidden ID')
      .argument('[query]', 'Part of a name; case and accents are ignored')
      .option('--profile <name>', PROFILE_OPTION)
      .action(async (query: string | undefined, options) => {
        try {
          const client = await clientFor(options.profile);
          printContacts(await client.contacts(query), query);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  agentio whatsapp contacts
  agentio whatsapp contacts alice`,
  );

  const profile = createProfileCommands<WhatsAppCredentials>(whatsapp, {
    service: 'whatsapp',
    displayName: 'WhatsApp',
    getExtraInfo: (credentials) => (credentials?.account ? ` - ${credentials.account}` : ''),
  });

  addExamples(
    addJsonOption(
      profile
        .command('add')
        .description('Link a WhatsApp account to the daemon, with a QR code or a pairing code')
        .option('--profile <name>', 'Profile name; pairing an existing one replaces its account')
        .option('--phone <number>', 'Pair with an 8-character code for this number instead of a QR code')
        .option('--read-only', 'Create as read-only profile (no sending, no read receipts)'),
      'Print one JSON event per line (qr or code, then paired, expired or error); never draws or prompts',
    ).action(async (options: PairOptions) => {
      try {
        await pairWhatsAppProfile(options);
      } catch (error) {
        if (options.json && error instanceof PairingExpired) {
          printJson({ event: 'expired', message: error.message, suggestion: error.suggestion });
          process.exit(exitCodeForError(error.code));
        }
        handleError(error);
      }
    }),
    `Examples:

  # scan a QR code drawn in this terminal
  agentio whatsapp profile add --profile work

  # over SSH: type an 8-character code on the phone instead
  agentio whatsapp profile add --profile work --phone +33612345678

  # from a program: one JSON event per line on stdout
  agentio whatsapp profile add --profile work --json`,
  );
}
