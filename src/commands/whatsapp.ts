import { Command } from 'commander';
import { setCredentials, getCredentials } from '../auth/token-store';
import { setProfile, resolveProfile, removeProfile } from '../config/config-manager';
import { CliError, handleError } from '../utils/errors';
import { readStdin, prompt, confirm } from '../utils/stdin';
import { getGatewayClient } from '../gateway/client';
import {
  printInboxMessageList,
  printInboxMessage,
  printInboxStats,
  printInboxAckResult,
  printInboxReplyResult,
  printOutboxMessageList,
  printOutboxMessage,
  printOutboxSendResult,
} from '../utils/output';
import type { WhatsAppCredentials } from '../types/whatsapp';

export function registerWhatsAppCommands(program: Command): void {
  const whatsapp = program
    .command('whatsapp')
    .description('WhatsApp operations (requires gateway)');

  // Profile management
  const profile = whatsapp.command('profile').description('Manage WhatsApp profiles');

  profile
    .command('add')
    .description('Add a new WhatsApp profile')
    .option('--profile <name>', 'Profile name')
    .action(async (options) => {
      try {
        console.error('\nWhatsApp Profile Setup\n');
        console.error('WhatsApp requires the gateway to be running for pairing.');
        console.error('The gateway maintains a persistent connection to WhatsApp.\n');

        const profileName = options.profile || await prompt('? Profile name: ');

        if (!profileName) {
          throw new CliError('INVALID_PARAMS', 'Profile name is required');
        }

        // Check if profile already exists
        const existing = await getCredentials<WhatsAppCredentials>('whatsapp', profileName);
        if (existing?.paired) {
          const overwrite = await confirm(`Profile "${profileName}" already exists and is paired. Overwrite?`);
          if (!overwrite) {
            console.log('Cancelled');
            return;
          }
        }

        // Create initial credentials (not yet paired)
        const credentials: WhatsAppCredentials = {
          paired: false,
        };

        await setProfile('whatsapp', profileName);
        await setCredentials('whatsapp', profileName, credentials);

        console.log(`\nProfile "${profileName}" created!`);
        console.log('\nNext steps:');
        console.log('  1. Start the gateway: agentio gateway start');
        console.log('  2. The gateway will display a QR code for pairing');
        console.log('  3. Scan the QR code with WhatsApp on your phone');
        console.log('  4. Once paired, use: agentio whatsapp inbox pull --profile ' + profileName);
      } catch (error) {
        handleError(error);
      }
    });

  profile
    .command('list')
    .description('List WhatsApp profiles')
    .action(async () => {
      try {
        const { profiles } = await import('../config/config-manager').then(m => m.listProfiles('whatsapp').then(r => r[0]));

        if (profiles.length === 0) {
          console.log('No WhatsApp profiles configured');
          console.log('Run: agentio whatsapp profile add');
          return;
        }

        console.log(`WhatsApp profiles (${profiles.length}):\n`);

        for (const name of profiles) {
          const creds = await getCredentials<WhatsAppCredentials>('whatsapp', name);
          const status = creds?.paired ? 'paired' : 'not paired';
          const phone = creds?.phoneNumber ? ` (${creds.phoneNumber})` : '';
          const displayName = creds?.displayName ? ` - ${creds.displayName}` : '';
          console.log(`  ${name}${phone}${displayName} [${status}]`);
        }
      } catch (error) {
        handleError(error);
      }
    });

  profile
    .command('remove')
    .description('Remove a WhatsApp profile')
    .option('--profile <name>', 'Profile name to remove')
    .action(async (options) => {
      try {
        const profileResult = await resolveProfile('whatsapp', options.profile);
        if (!profileResult.profile) {
          if (profileResult.error === 'none') {
            throw new CliError('PROFILE_NOT_FOUND', 'No WhatsApp profiles configured');
          }
          throw new CliError('INVALID_PARAMS', 'Multiple profiles exist. Use --profile to specify one.');
        }

        const profileName = profileResult.profile;
        const confirmed = await confirm(`Remove profile "${profileName}"? This will delete the session.`);

        if (!confirmed) {
          console.log('Cancelled');
          return;
        }

        await removeProfile('whatsapp', profileName);
        // Note: Auth state in gateway DB will be cleaned up when gateway restarts
        // or we could add a direct cleanup call here

        console.log(`Profile "${profileName}" removed`);
        console.log('Note: Restart the gateway to fully disconnect this session.');
      } catch (error) {
        handleError(error);
      }
    });

  // Inbox subcommands (requires gateway)
  const inbox = whatsapp.command('inbox').description('Inbox operations (requires gateway)');

  inbox
    .command('pull')
    .description('Get pending messages from inbox')
    .option('--profile <name>', 'Profile name')
    .option('--limit <n>', 'Maximum messages to retrieve', '50')
    .option('--status <status>', 'Filter by status: pending or done', 'pending')
    .action(async (options) => {
      try {
        const profileResult = await resolveProfile('whatsapp', options.profile);
        if (!profileResult.profile) {
          if (profileResult.error === 'none') {
            throw new CliError('PROFILE_NOT_FOUND', 'No WhatsApp profiles configured', 'Run: agentio whatsapp profile add');
          }
          throw new CliError('INVALID_PARAMS', 'Multiple profiles exist. Use --profile to specify one.');
        }

        const client = await getGatewayClient();
        const messages = await client.inboxPull({
          service: 'whatsapp',
          profile: profileResult.profile,
          limit: parseInt(options.limit, 10),
          status: options.status as 'pending' | 'done',
        });
        printInboxMessageList(messages);
      } catch (error) {
        handleError(error);
      }
    });

  inbox
    .command('get')
    .description('Get a specific inbox message')
    .argument('<id>', 'Message ID')
    .action(async (id: string) => {
      try {
        const client = await getGatewayClient();
        const message = await client.inboxGet(id);
        if (!message) {
          throw new CliError('NOT_FOUND', `Message not found: ${id}`);
        }
        printInboxMessage(message);
      } catch (error) {
        handleError(error);
      }
    });

  inbox
    .command('ack')
    .description('Mark a message as done')
    .argument('<id>', 'Message ID')
    .action(async (id: string) => {
      try {
        const client = await getGatewayClient();
        const success = await client.inboxAck(id);
        printInboxAckResult(success, id);
      } catch (error) {
        handleError(error);
      }
    });

  inbox
    .command('reply')
    .description('Reply to an inbox message')
    .argument('<id>', 'Message ID to reply to')
    .argument('[message]', 'Reply text (or pipe via stdin)')
    .action(async (id: string, message: string | undefined) => {
      try {
        let text = message;
        if (!text) {
          text = await readStdin() || undefined;
        }
        if (!text) {
          throw new CliError('INVALID_PARAMS', 'Message is required. Provide as argument or pipe via stdin.');
        }

        const client = await getGatewayClient();
        const result = await client.inboxReply(id, text);
        printInboxReplyResult(result);
      } catch (error) {
        handleError(error);
      }
    });

  inbox
    .command('stats')
    .description('Get inbox statistics')
    .option('--profile <name>', 'Profile name')
    .action(async (options) => {
      try {
        const profileResult = await resolveProfile('whatsapp', options.profile);
        const client = await getGatewayClient();
        const stats = await client.inboxStats({
          service: 'whatsapp',
          profile: profileResult.profile ?? undefined,
        });
        printInboxStats(stats);
      } catch (error) {
        handleError(error);
      }
    });

  // Outbox subcommands (requires gateway)
  const outbox = whatsapp.command('outbox').description('Outbox operations (requires gateway)');

  outbox
    .command('send')
    .description('Queue a message for sending')
    .option('--profile <name>', 'Profile name')
    .option('--to <phone>', 'Destination phone number (with country code, e.g., +1234567890)')
    .argument('[message]', 'Message text (or pipe via stdin)')
    .action(async (message: string | undefined, options) => {
      try {
        const profileResult = await resolveProfile('whatsapp', options.profile);
        if (!profileResult.profile) {
          if (profileResult.error === 'none') {
            throw new CliError('PROFILE_NOT_FOUND', 'No WhatsApp profiles configured', 'Run: agentio whatsapp profile add');
          }
          throw new CliError('INVALID_PARAMS', 'Multiple profiles exist. Use --profile to specify one.');
        }

        if (!options.to) {
          throw new CliError('INVALID_PARAMS', 'Destination phone number is required. Use --to <phone>');
        }

        let text = message;
        if (!text) {
          text = await readStdin() || undefined;
        }
        if (!text) {
          throw new CliError('INVALID_PARAMS', 'Message is required. Provide as argument or pipe via stdin.');
        }

        const client = await getGatewayClient();
        const result = await client.outboxSend({
          service: 'whatsapp',
          profile: profileResult.profile,
          conversationId: options.to,
          content: text,
        });
        printOutboxSendResult(result);
      } catch (error) {
        handleError(error);
      }
    });

  outbox
    .command('status')
    .description('Check send status of a message')
    .argument('<id>', 'Outbox message ID')
    .action(async (id: string) => {
      try {
        const client = await getGatewayClient();
        const message = await client.outboxStatus(id);
        if (!message) {
          throw new CliError('NOT_FOUND', `Message not found: ${id}`);
        }
        printOutboxMessage(message);
      } catch (error) {
        handleError(error);
      }
    });

  outbox
    .command('list')
    .description('List outbox messages')
    .option('--profile <name>', 'Profile name')
    .option('--status <status>', 'Filter by status: pending, sending, sent, or failed')
    .option('--limit <n>', 'Maximum messages to retrieve', '50')
    .action(async (options) => {
      try {
        const profileResult = await resolveProfile('whatsapp', options.profile);
        const client = await getGatewayClient();
        const messages = await client.outboxList({
          service: 'whatsapp',
          profile: profileResult.profile ?? undefined,
          status: options.status as 'pending' | 'sending' | 'sent' | 'failed' | undefined,
          limit: parseInt(options.limit, 10),
        });
        printOutboxMessageList(messages);
      } catch (error) {
        handleError(error);
      }
    });
}
