import { Command } from 'commander';
import { setCredentials, getCredentials } from '../auth/token-store';
import { setProfile, resolveProfile, removeProfile } from '../config/config-manager';
import { CliError, handleError } from '../utils/errors';
import { readStdin, prompt, confirm } from '../utils/stdin';
import { getGatewayClient, isGatewayAvailable } from '../daemon/client';
import { enforceWriteAccess } from '../utils/read-only';
import {
  printInboxMessageList,
  printInboxMessage,
  printInboxStats,
  printInboxAckResult,
  printInboxReplyResult,
  printOutboxMessageList,
  printOutboxMessage,
  printOutboxSendResult,
  printWhatsAppGroupList,
  printWhatsAppGroup,
  printWhatsAppGroupCreated,
  printWhatsAppGroupInvite,
  printWhatsAppGroupJoined,
  printWhatsAppGroupLeft,
  printWhatsAppParticipantsResult,
} from '../utils/output';
import type { WhatsAppCredentials } from '../types/whatsapp';
import qrcode from 'qrcode-terminal';

/**
 * Run the WhatsApp pairing flow - polls for QR code until connected
 */
async function runPairingFlow(profileName: string): Promise<boolean> {
  const client = await getGatewayClient();
  let lastQr = '';

  console.log('\nWaiting for QR code... (Ctrl+C to cancel)\n');

  while (true) {
    const result = await client.whatsappPair(profileName);

    switch (result.status) {
      case 'connected':
        console.log(`\nConnected to WhatsApp!`);
        if (result.phoneNumber) {
          console.log(`Phone: ${result.phoneNumber}`);
        }
        if (result.displayName) {
          console.log(`Name: ${result.displayName}`);
        }
        return true;

      case 'waiting_qr':
        if (result.qrCode && result.qrCode !== lastQr) {
          lastQr = result.qrCode;
          console.clear();
          console.log('\nScan this QR code with WhatsApp on your phone:\n');
          console.log('1. Open WhatsApp on your phone');
          console.log('2. Tap Menu or Settings');
          console.log('3. Tap "Linked Devices"');
          console.log('4. Tap "Link a Device"');
          console.log('5. Point your phone at this screen\n');
          qrcode.generate(result.qrCode, { small: true });
          console.log('\nWaiting for scan...');
        }
        break;

      case 'connecting':
        console.error(`Status: ${result.message || 'Connecting...'}`);
        break;

      case 'not_configured':
        throw new CliError('CONFIG_ERROR', result.message || 'WhatsApp not configured');
    }

    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

export function registerWhatsAppCommands(program: Command): void {
  const whatsapp = program
    .command('whatsapp')
    .description('WhatsApp operations (requires gateway)');

  // Profile management
  const profile = whatsapp.command('profile').description('Manage WhatsApp profiles');

  profile
    .command('add')
    .description('Add a new WhatsApp profile and pair via QR code')
    .option('--profile <name>', 'Profile name')
    .option('--read-only', 'Create as read-only profile (blocks write operations)')
    .action(async (options) => {
      try {
        console.error('\nWhatsApp Profile Setup\n');

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

        await setProfile('whatsapp', profileName, { readOnly: options.readOnly });
        await setCredentials('whatsapp', profileName, credentials);

        console.log(`Profile "${profileName}" created.`);
        if (options.readOnly) {
          console.log(`   Access: read-only`);
        }

        // Check if gateway is running
        const gatewayRunning = await isGatewayAvailable();
        if (!gatewayRunning) {
          console.log('\nDaemon is not running.');
          console.log('Start the daemon first, then run this command again:');
          console.log('  agentio daemon start');
          console.log(`  agentio whatsapp profile add --profile ${profileName}`);
          return;
        }

        // Gateway is running - proceed with pairing
        await runPairingFlow(profileName);

        console.log(`\nProfile "${profileName}" is ready to use.`);
        console.log(`Try: agentio whatsapp inbox pull --profile ${profileName}`);
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

        for (const entry of profiles) {
          const creds = await getCredentials<WhatsAppCredentials>('whatsapp', entry.name);
          const status = creds?.paired ? 'paired' : 'not paired';
          const phone = creds?.phoneNumber ? ` (${creds.phoneNumber})` : '';
          const displayName = creds?.displayName ? ` - ${creds.displayName}` : '';
          const readOnlyIndicator = entry.readOnly ? ' [read-only]' : '';
          console.log(`  ${entry.name}${readOnlyIndicator}${phone}${displayName} [${status}]`);
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
        console.log('Note: if the daemon is running, it will stop reconnecting this profile within ~30 seconds.');
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
    .option('--conversation <id>', 'Filter by conversation/group (name or JID)')
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

        // Resolve conversation name to JID if needed
        let conversationId = options.conversation;
        if (conversationId && !conversationId.includes('@')) {
          const resolved = await client.whatsappGroupResolve(profileResult.profile, conversationId);
          if (resolved.groupId) {
            conversationId = resolved.groupId;
          }
          // If not found as group, keep original (might be a phone number)
        }

        const messages = await client.inboxPull({
          service: 'whatsapp',
          profile: profileResult.profile,
          conversationId,
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
        // Get the inbox message to determine the profile for read-only check
        const inboxMessage = await client.inboxGet(id);
        if (inboxMessage) {
          await enforceWriteAccess('whatsapp', inboxMessage.profile, 'reply to message');
        }
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
    .option('--group <name>', 'Destination group (name or JID)')
    .option('--attachment <path>', 'Path to file attachment (image, video, audio, or document)')
    .option('--type <type>', 'Media type: image, video, audio, document (auto-detected if not specified)')
    .argument('[message]', 'Message text or caption (or pipe via stdin)')
    .action(async (message: string | undefined, options) => {
      try {
        const profileResult = await resolveProfile('whatsapp', options.profile);
        if (!profileResult.profile) {
          if (profileResult.error === 'none') {
            throw new CliError('PROFILE_NOT_FOUND', 'No WhatsApp profiles configured', 'Run: agentio whatsapp profile add');
          }
          throw new CliError('INVALID_PARAMS', 'Multiple profiles exist. Use --profile to specify one.');
        }

        if (!options.to && !options.group) {
          throw new CliError('INVALID_PARAMS', 'Destination required. Use --to <phone> or --group <name>');
        }

        if (options.to && options.group) {
          throw new CliError('INVALID_PARAMS', 'Use either --to or --group, not both.');
        }

        let text = message;
        if (!text) {
          text = await readStdin() || undefined;
        }

        // Validate: need either text or attachment
        if (!text && !options.attachment) {
          throw new CliError('INVALID_PARAMS', 'Message or attachment is required.');
        }

        // Auto-detect media type from file extension if not specified
        let mediaType = options.type as 'image' | 'video' | 'audio' | 'document' | undefined;
        if (options.attachment && !mediaType) {
          const ext = options.attachment.toLowerCase().split('.').pop();
          if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext || '')) {
            mediaType = 'image';
          } else if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext || '')) {
            mediaType = 'video';
          } else if (['mp3', 'ogg', 'wav', 'm4a', 'opus'].includes(ext || '')) {
            mediaType = 'audio';
          } else {
            mediaType = 'document';
          }
        }

        await enforceWriteAccess('whatsapp', profileResult.profile, 'send message');
        const client = await getGatewayClient();

        // Resolve destination
        let conversationId = options.to;
        if (options.group) {
          // Resolve group name to JID
          if (options.group.includes('@g.us')) {
            conversationId = options.group;
          } else {
            const resolved = await client.whatsappGroupResolve(profileResult.profile, options.group);
            if (!resolved.groupId) {
              throw new CliError('NOT_FOUND', `Group not found: ${options.group}`, 'Run: agentio whatsapp group list');
            }
            conversationId = resolved.groupId;
            console.error(`Resolved group "${options.group}" to ${resolved.groupId}`);
          }
        }

        const result = await client.outboxSend({
          service: 'whatsapp',
          profile: profileResult.profile,
          conversationId,
          content: text,
          mediaPath: options.attachment,
          mediaType,
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

  // Group subcommands
  const group = whatsapp.command('group').description('Group management (requires gateway)');

  group
    .command('list')
    .description('List all groups')
    .option('--profile <name>', 'Profile name')
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
        const groups = await client.whatsappGroupList(profileResult.profile);
        printWhatsAppGroupList(groups);
      } catch (error) {
        handleError(error);
      }
    });

  group
    .command('get')
    .description('Get group details')
    .argument('<id>', 'Group ID or name')
    .option('--profile <name>', 'Profile name')
    .action(async (id: string, options) => {
      try {
        const profileResult = await resolveProfile('whatsapp', options.profile);
        if (!profileResult.profile) {
          if (profileResult.error === 'none') {
            throw new CliError('PROFILE_NOT_FOUND', 'No WhatsApp profiles configured', 'Run: agentio whatsapp profile add');
          }
          throw new CliError('INVALID_PARAMS', 'Multiple profiles exist. Use --profile to specify one.');
        }

        const client = await getGatewayClient();

        // Resolve name to ID if needed
        let groupId = id;
        if (!id.includes('@g.us')) {
          const resolved = await client.whatsappGroupResolve(profileResult.profile, id);
          if (!resolved.groupId) {
            throw new CliError('NOT_FOUND', `Group not found: ${id}`);
          }
          groupId = resolved.groupId;
        }

        const group = await client.whatsappGroupGet(profileResult.profile, groupId);
        printWhatsAppGroup(group);
      } catch (error) {
        handleError(error);
      }
    });

  group
    .command('create')
    .description('Create a new group')
    .argument('<name>', 'Group name')
    .option('--profile <name>', 'Profile name')
    .option('--participants <phones...>', 'Participant phone numbers')
    .option('--picture <path>', 'Path to group profile picture')
    .action(async (name: string, options) => {
      try {
        const profileResult = await resolveProfile('whatsapp', options.profile);
        if (!profileResult.profile) {
          if (profileResult.error === 'none') {
            throw new CliError('PROFILE_NOT_FOUND', 'No WhatsApp profiles configured', 'Run: agentio whatsapp profile add');
          }
          throw new CliError('INVALID_PARAMS', 'Multiple profiles exist. Use --profile to specify one.');
        }

        if (!options.participants || options.participants.length === 0) {
          throw new CliError('INVALID_PARAMS', 'At least one participant is required. Use --participants <phone...>');
        }

        await enforceWriteAccess('whatsapp', profileResult.profile, 'create group');
        const client = await getGatewayClient();
        const group = await client.whatsappGroupCreate(
          profileResult.profile,
          name,
          options.participants,
          options.picture
        );
        printWhatsAppGroupCreated(group);
      } catch (error) {
        handleError(error);
      }
    });

  group
    .command('update')
    .description('Update group info')
    .argument('<id>', 'Group ID or name')
    .option('--profile <name>', 'Profile name')
    .option('--name <name>', 'New group name')
    .option('--description <text>', 'New group description')
    .option('--picture <path>', 'Path to new group profile picture')
    .action(async (id: string, options) => {
      try {
        const profileResult = await resolveProfile('whatsapp', options.profile);
        if (!profileResult.profile) {
          if (profileResult.error === 'none') {
            throw new CliError('PROFILE_NOT_FOUND', 'No WhatsApp profiles configured', 'Run: agentio whatsapp profile add');
          }
          throw new CliError('INVALID_PARAMS', 'Multiple profiles exist. Use --profile to specify one.');
        }

        if (!options.name && options.description === undefined && !options.picture) {
          throw new CliError('INVALID_PARAMS', 'Provide --name, --description, or --picture to update.');
        }

        await enforceWriteAccess('whatsapp', profileResult.profile, 'update group');
        const client = await getGatewayClient();

        // Resolve name to ID if needed
        let groupId = id;
        if (!id.includes('@g.us')) {
          const resolved = await client.whatsappGroupResolve(profileResult.profile, id);
          if (!resolved.groupId) {
            throw new CliError('NOT_FOUND', `Group not found: ${id}`);
          }
          groupId = resolved.groupId;
        }

        await client.whatsappGroupUpdate(profileResult.profile, groupId, {
          subject: options.name,
          description: options.description,
          picture: options.picture,
        });
        console.log('Group updated');
      } catch (error) {
        handleError(error);
      }
    });

  group
    .command('add')
    .description('Add participants to group')
    .argument('<id>', 'Group ID or name')
    .argument('<phones...>', 'Phone numbers to add')
    .option('--profile <name>', 'Profile name')
    .action(async (id: string, phones: string[], options) => {
      try {
        const profileResult = await resolveProfile('whatsapp', options.profile);
        if (!profileResult.profile) {
          if (profileResult.error === 'none') {
            throw new CliError('PROFILE_NOT_FOUND', 'No WhatsApp profiles configured', 'Run: agentio whatsapp profile add');
          }
          throw new CliError('INVALID_PARAMS', 'Multiple profiles exist. Use --profile to specify one.');
        }

        await enforceWriteAccess('whatsapp', profileResult.profile, 'add participants');
        const client = await getGatewayClient();

        // Resolve name to ID if needed
        let groupId = id;
        if (!id.includes('@g.us')) {
          const resolved = await client.whatsappGroupResolve(profileResult.profile, id);
          if (!resolved.groupId) {
            throw new CliError('NOT_FOUND', `Group not found: ${id}`);
          }
          groupId = resolved.groupId;
        }

        const result = await client.whatsappGroupParticipants(
          profileResult.profile,
          groupId,
          phones,
          'add'
        );
        if (result.results) {
          printWhatsAppParticipantsResult('added', result.results);
        } else {
          console.log('Participants added');
        }
      } catch (error) {
        handleError(error);
      }
    });

  group
    .command('remove')
    .description('Remove participants from group')
    .argument('<id>', 'Group ID or name')
    .argument('<phones...>', 'Phone numbers to remove')
    .option('--profile <name>', 'Profile name')
    .action(async (id: string, phones: string[], options) => {
      try {
        const profileResult = await resolveProfile('whatsapp', options.profile);
        if (!profileResult.profile) {
          if (profileResult.error === 'none') {
            throw new CliError('PROFILE_NOT_FOUND', 'No WhatsApp profiles configured', 'Run: agentio whatsapp profile add');
          }
          throw new CliError('INVALID_PARAMS', 'Multiple profiles exist. Use --profile to specify one.');
        }

        await enforceWriteAccess('whatsapp', profileResult.profile, 'remove participants');
        const client = await getGatewayClient();

        // Resolve name to ID if needed
        let groupId = id;
        if (!id.includes('@g.us')) {
          const resolved = await client.whatsappGroupResolve(profileResult.profile, id);
          if (!resolved.groupId) {
            throw new CliError('NOT_FOUND', `Group not found: ${id}`);
          }
          groupId = resolved.groupId;
        }

        const result = await client.whatsappGroupParticipants(
          profileResult.profile,
          groupId,
          phones,
          'remove'
        );
        if (result.results) {
          printWhatsAppParticipantsResult('removed', result.results);
        } else {
          console.log('Participants removed');
        }
      } catch (error) {
        handleError(error);
      }
    });

  group
    .command('promote')
    .description('Promote participants to admin')
    .argument('<id>', 'Group ID or name')
    .argument('<phones...>', 'Phone numbers to promote')
    .option('--profile <name>', 'Profile name')
    .action(async (id: string, phones: string[], options) => {
      try {
        const profileResult = await resolveProfile('whatsapp', options.profile);
        if (!profileResult.profile) {
          if (profileResult.error === 'none') {
            throw new CliError('PROFILE_NOT_FOUND', 'No WhatsApp profiles configured', 'Run: agentio whatsapp profile add');
          }
          throw new CliError('INVALID_PARAMS', 'Multiple profiles exist. Use --profile to specify one.');
        }

        await enforceWriteAccess('whatsapp', profileResult.profile, 'promote participants');
        const client = await getGatewayClient();

        // Resolve name to ID if needed
        let groupId = id;
        if (!id.includes('@g.us')) {
          const resolved = await client.whatsappGroupResolve(profileResult.profile, id);
          if (!resolved.groupId) {
            throw new CliError('NOT_FOUND', `Group not found: ${id}`);
          }
          groupId = resolved.groupId;
        }

        const result = await client.whatsappGroupParticipants(
          profileResult.profile,
          groupId,
          phones,
          'promote'
        );
        if (result.results) {
          printWhatsAppParticipantsResult('promoted', result.results);
        } else {
          console.log('Participants promoted to admin');
        }
      } catch (error) {
        handleError(error);
      }
    });

  group
    .command('demote')
    .description('Demote admins to regular participants')
    .argument('<id>', 'Group ID or name')
    .argument('<phones...>', 'Phone numbers to demote')
    .option('--profile <name>', 'Profile name')
    .action(async (id: string, phones: string[], options) => {
      try {
        const profileResult = await resolveProfile('whatsapp', options.profile);
        if (!profileResult.profile) {
          if (profileResult.error === 'none') {
            throw new CliError('PROFILE_NOT_FOUND', 'No WhatsApp profiles configured', 'Run: agentio whatsapp profile add');
          }
          throw new CliError('INVALID_PARAMS', 'Multiple profiles exist. Use --profile to specify one.');
        }

        await enforceWriteAccess('whatsapp', profileResult.profile, 'demote participants');
        const client = await getGatewayClient();

        // Resolve name to ID if needed
        let groupId = id;
        if (!id.includes('@g.us')) {
          const resolved = await client.whatsappGroupResolve(profileResult.profile, id);
          if (!resolved.groupId) {
            throw new CliError('NOT_FOUND', `Group not found: ${id}`);
          }
          groupId = resolved.groupId;
        }

        const result = await client.whatsappGroupParticipants(
          profileResult.profile,
          groupId,
          phones,
          'demote'
        );
        if (result.results) {
          printWhatsAppParticipantsResult('demoted', result.results);
        } else {
          console.log('Admins demoted to regular participants');
        }
      } catch (error) {
        handleError(error);
      }
    });

  group
    .command('leave')
    .description('Leave a group')
    .argument('<id>', 'Group ID or name')
    .option('--profile <name>', 'Profile name')
    .action(async (id: string, options) => {
      try {
        const profileResult = await resolveProfile('whatsapp', options.profile);
        if (!profileResult.profile) {
          if (profileResult.error === 'none') {
            throw new CliError('PROFILE_NOT_FOUND', 'No WhatsApp profiles configured', 'Run: agentio whatsapp profile add');
          }
          throw new CliError('INVALID_PARAMS', 'Multiple profiles exist. Use --profile to specify one.');
        }

        await enforceWriteAccess('whatsapp', profileResult.profile, 'leave group');
        const client = await getGatewayClient();

        // Resolve name to ID if needed
        let groupId = id;
        if (!id.includes('@g.us')) {
          const resolved = await client.whatsappGroupResolve(profileResult.profile, id);
          if (!resolved.groupId) {
            throw new CliError('NOT_FOUND', `Group not found: ${id}`);
          }
          groupId = resolved.groupId;
        }

        // Confirm before leaving
        const confirmed = await confirm(`Leave group ${id}?`);
        if (!confirmed) {
          console.log('Cancelled');
          return;
        }

        await client.whatsappGroupLeave(profileResult.profile, groupId);
        printWhatsAppGroupLeft(groupId);
      } catch (error) {
        handleError(error);
      }
    });

  group
    .command('invite')
    .description('Get group invite link')
    .argument('<id>', 'Group ID or name')
    .option('--profile <name>', 'Profile name')
    .action(async (id: string, options) => {
      try {
        const profileResult = await resolveProfile('whatsapp', options.profile);
        if (!profileResult.profile) {
          if (profileResult.error === 'none') {
            throw new CliError('PROFILE_NOT_FOUND', 'No WhatsApp profiles configured', 'Run: agentio whatsapp profile add');
          }
          throw new CliError('INVALID_PARAMS', 'Multiple profiles exist. Use --profile to specify one.');
        }

        const client = await getGatewayClient();

        // Resolve name to ID if needed
        let groupId = id;
        if (!id.includes('@g.us')) {
          const resolved = await client.whatsappGroupResolve(profileResult.profile, id);
          if (!resolved.groupId) {
            throw new CliError('NOT_FOUND', `Group not found: ${id}`);
          }
          groupId = resolved.groupId;
        }

        const result = await client.whatsappGroupInvite(profileResult.profile, groupId);
        printWhatsAppGroupInvite(result);
      } catch (error) {
        handleError(error);
      }
    });

  group
    .command('join')
    .description('Join group via invite code or link')
    .argument('<code>', 'Invite code or full link (https://chat.whatsapp.com/...)')
    .option('--profile <name>', 'Profile name')
    .action(async (code: string, options) => {
      try {
        const profileResult = await resolveProfile('whatsapp', options.profile);
        if (!profileResult.profile) {
          if (profileResult.error === 'none') {
            throw new CliError('PROFILE_NOT_FOUND', 'No WhatsApp profiles configured', 'Run: agentio whatsapp profile add');
          }
          throw new CliError('INVALID_PARAMS', 'Multiple profiles exist. Use --profile to specify one.');
        }

        await enforceWriteAccess('whatsapp', profileResult.profile, 'join group');
        const client = await getGatewayClient();
        const groupId = await client.whatsappGroupJoin(profileResult.profile, code);
        printWhatsAppGroupJoined(groupId);
      } catch (error) {
        handleError(error);
      }
    });
}
