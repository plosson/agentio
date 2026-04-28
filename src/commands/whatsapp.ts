import { Command } from 'commander';
import { setCredentials, getCredentials } from '../auth/token-store';
import { setProfile, resolveProfile, removeProfile } from '../config/config-manager';
import { CliError, handleError, multipleProfilesError } from '../utils/errors';
import { readStdin, prompt, confirm } from '../utils/stdin';
import { getDaemonClient, isDaemonAvailable } from '../daemon/client';
import { ensureDaemonRunning } from '../utils/daemon-ensure';
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
import { addExamples } from '../utils/command-tree';
import type { WhatsAppCredentials } from '../types/whatsapp';
import qrcode from 'qrcode-terminal';

/**
 * Run the WhatsApp pairing flow - polls for QR code until connected
 */
async function runPairingFlow(profileName: string): Promise<boolean> {
  const client = await getDaemonClient();
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
    .description('WhatsApp operations');

  // Profile management
  const profile = whatsapp.command('profile').description('Manage WhatsApp profiles');

  profile
    .command('add')
    .description('Add a new WhatsApp profile and pair via QR code')
    .option('--profile <name>', 'Profile name')
    .option('--read-only', 'Create as read-only profile (blocks write operations)')
    .action(async (options) => {
      try {
        await whatsappProfileAdd(options);
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
        if (profileResult.profile === null) {
          if (profileResult.error === 'none') {
            throw new CliError('PROFILE_NOT_FOUND', 'No WhatsApp profiles configured');
          }
          throw multipleProfilesError('whatsapp', profileResult.names);
        }

        const profileName = profileResult.profile;
        const confirmed = await confirm(`Remove profile "${profileName}"? This will delete the session.`);

        if (!confirmed) {
          console.log('Cancelled');
          return;
        }

        await removeProfile('whatsapp', profileName);
        // Note: Auth state in daemon DB will be cleaned up when daemon restarts
        // or we could add a direct cleanup call here

        console.log(`Profile "${profileName}" removed`);
        console.log('Note: if the daemon is running, it will stop reconnecting this profile within ~30 seconds.');
      } catch (error) {
        handleError(error);
      }
    });

  // Inbox subcommands (requires daemon)
  const inbox = whatsapp.command('inbox').description('Inbox operations (requires daemon)');

  addExamples(
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
        if (profileResult.profile === null) {
          if (profileResult.error === 'none') {
            throw new CliError('PROFILE_NOT_FOUND', 'No WhatsApp profiles configured', 'Run: agentio whatsapp profile add');
          }
          throw multipleProfilesError('whatsapp', profileResult.names);
        }

        const client = await getDaemonClient();

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
    }),
    `Examples:

  # pending messages on the default profile
  agentio whatsapp inbox pull

  # last 100 already-acked messages
  agentio whatsapp inbox pull --status done --limit 100

  # pending messages from one group, by name
  agentio whatsapp inbox pull --conversation "Family Chat"

  # pending messages from one direct chat, by phone JID
  agentio whatsapp inbox pull --conversation 15551234567@s.whatsapp.net`,
  );

  addExamples(
    inbox
      .command('get')
      .description('Get a specific inbox message')
      .argument('<id>', 'Message ID')
      .action(async (id: string) => {
      try {
        const client = await getDaemonClient();
        const message = await client.inboxGet(id);
        if (!message) {
          throw new CliError('NOT_FOUND', `Message not found: ${id}`);
        }
        printInboxMessage(message);
      } catch (error) {
        handleError(error);
      }
    }),
    `Examples:

  # fetch one inbox message in full
  agentio whatsapp inbox get wa_abc123`,
  );

  addExamples(
    inbox
      .command('ack')
      .description('Mark a message as done')
      .argument('<id>', 'Message ID')
      .action(async (id: string) => {
      try {
        const client = await getDaemonClient();
        const success = await client.inboxAck(id);
        printInboxAckResult(success, id);
      } catch (error) {
        handleError(error);
      }
    }),
    `Examples:

  # mark a message as done so it stops appearing in pending pulls
  agentio whatsapp inbox ack wa_abc123`,
  );

  addExamples(
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

        const client = await getDaemonClient();
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
    }),
    `Examples:

  # quick text reply to an incoming message
  agentio whatsapp inbox reply wa_abc123 "on my way"

  # pipe a longer reply via stdin
  cat draft.txt | agentio whatsapp inbox reply wa_abc123`,
  );

  addExamples(
    inbox
      .command('stats')
      .description('Get inbox statistics')
      .option('--profile <name>', 'Profile name')
      .action(async (options) => {
      try {
        const profileResult = await resolveProfile('whatsapp', options.profile);
        const client = await getDaemonClient();
        const stats = await client.inboxStats({
          service: 'whatsapp',
          profile: profileResult.profile ?? undefined,
        });
        printInboxStats(stats);
      } catch (error) {
        handleError(error);
      }
    }),
    `Examples:

  # totals across all whatsapp profiles
  agentio whatsapp inbox stats

  # totals for a single profile
  agentio whatsapp inbox stats --profile personal`,
  );

  // Outbox subcommands (requires daemon)
  const outbox = whatsapp.command('outbox').description('Outbox operations (requires daemon)');

  addExamples(
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
        if (profileResult.profile === null) {
          if (profileResult.error === 'none') {
            throw new CliError('PROFILE_NOT_FOUND', 'No WhatsApp profiles configured', 'Run: agentio whatsapp profile add');
          }
          throw multipleProfilesError('whatsapp', profileResult.names);
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
        const client = await getDaemonClient();

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
    }),
    `Examples:

  # text message to a phone number
  agentio whatsapp outbox send --to +15551234567 "running late, 10 min"

  # text message to a group by name
  agentio whatsapp outbox send --group "Family Chat" "dinner at 7?"

  # send a photo with caption
  agentio whatsapp outbox send --to +15551234567 --attachment ./photo.jpg "from the trail"

  # send a document (PDF) auto-detected
  agentio whatsapp outbox send --group "Project Team" --attachment ./report.pdf

  # pipe message body via stdin
  echo "build complete" | agentio whatsapp outbox send --to +15551234567`,
  );

  addExamples(
    outbox
      .command('status')
      .description('Check send status of a message')
      .argument('<id>', 'Outbox message ID')
      .action(async (id: string) => {
      try {
        const client = await getDaemonClient();
        const message = await client.outboxStatus(id);
        if (!message) {
          throw new CliError('NOT_FOUND', `Message not found: ${id}`);
        }
        printOutboxMessage(message);
      } catch (error) {
        handleError(error);
      }
    }),
    `Examples:

  # check delivery state of a queued message
  agentio whatsapp outbox status ob_abc123`,
  );

  addExamples(
    outbox
      .command('list')
      .description('List outbox messages')
      .option('--profile <name>', 'Profile name')
      .option('--status <status>', 'Filter by status: pending, sending, sent, or failed')
      .option('--limit <n>', 'Maximum messages to retrieve', '50')
      .action(async (options) => {
      try {
        const profileResult = await resolveProfile('whatsapp', options.profile);
        const client = await getDaemonClient();
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
    }),
    `Examples:

  # last 50 outbox messages across all profiles
  agentio whatsapp outbox list

  # only failed messages
  agentio whatsapp outbox list --status failed

  # in-flight messages on a single profile
  agentio whatsapp outbox list --profile personal --status sending --limit 100`,
  );

  // Group subcommands
  const group = whatsapp.command('group').description('Group management (requires daemon)');

  addExamples(
    group
      .command('list')
      .description('List all groups')
      .option('--profile <name>', 'Profile name')
      .action(async (options) => {
      try {
        const profileResult = await resolveProfile('whatsapp', options.profile);
        if (profileResult.profile === null) {
          if (profileResult.error === 'none') {
            throw new CliError('PROFILE_NOT_FOUND', 'No WhatsApp profiles configured', 'Run: agentio whatsapp profile add');
          }
          throw multipleProfilesError('whatsapp', profileResult.names);
        }

        const client = await getDaemonClient();
        const groups = await client.whatsappGroupList(profileResult.profile);
        printWhatsAppGroupList(groups);
      } catch (error) {
        handleError(error);
      }
    }),
    `Examples:

  # all groups visible to the default profile
  agentio whatsapp group list

  # groups on a named profile
  agentio whatsapp group list --profile personal`,
  );

  addExamples(
    group
      .command('get')
      .description('Get group details')
      .argument('<id>', 'Group ID or name')
      .option('--profile <name>', 'Profile name')
      .action(async (id: string, options) => {
      try {
        const profileResult = await resolveProfile('whatsapp', options.profile);
        if (profileResult.profile === null) {
          if (profileResult.error === 'none') {
            throw new CliError('PROFILE_NOT_FOUND', 'No WhatsApp profiles configured', 'Run: agentio whatsapp profile add');
          }
          throw multipleProfilesError('whatsapp', profileResult.names);
        }

        const client = await getDaemonClient();

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
    }),
    `Examples:

  # look up a group by name (fuzzy match)
  agentio whatsapp group get "Family Chat"

  # look up by JID
  agentio whatsapp group get 120363123456789012@g.us`,
  );

  addExamples(
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
        if (profileResult.profile === null) {
          if (profileResult.error === 'none') {
            throw new CliError('PROFILE_NOT_FOUND', 'No WhatsApp profiles configured', 'Run: agentio whatsapp profile add');
          }
          throw multipleProfilesError('whatsapp', profileResult.names);
        }

        if (!options.participants || options.participants.length === 0) {
          throw new CliError('INVALID_PARAMS', 'At least one participant is required. Use --participants <phone...>');
        }

        await enforceWriteAccess('whatsapp', profileResult.profile, 'create group');
        const client = await getDaemonClient();
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
    }),
    `Examples:

  # create a group with two participants
  agentio whatsapp group create "Project Team" --participants +15551234567 +15557654321

  # create a group with a profile picture
  agentio whatsapp group create "Book Club" \\
    --participants +15551234567 +15557654321 \\
    --picture ./logo.png`,
  );

  addExamples(
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
        if (profileResult.profile === null) {
          if (profileResult.error === 'none') {
            throw new CliError('PROFILE_NOT_FOUND', 'No WhatsApp profiles configured', 'Run: agentio whatsapp profile add');
          }
          throw multipleProfilesError('whatsapp', profileResult.names);
        }

        if (!options.name && options.description === undefined && !options.picture) {
          throw new CliError('INVALID_PARAMS', 'Provide --name, --description, or --picture to update.');
        }

        await enforceWriteAccess('whatsapp', profileResult.profile, 'update group');
        const client = await getDaemonClient();

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
    }),
    `Examples:

  # rename a group
  agentio whatsapp group update "Old Name" --name "New Name"

  # change description
  agentio whatsapp group update "Project Team" --description "Q2 planning"

  # change profile picture
  agentio whatsapp group update "Book Club" --picture ./new-logo.png`,
  );

  addExamples(
    group
      .command('add')
      .description('Add participants to group')
      .argument('<id>', 'Group ID or name')
      .argument('<phones...>', 'Phone numbers to add')
      .option('--profile <name>', 'Profile name')
      .action(async (id: string, phones: string[], options) => {
      try {
        const profileResult = await resolveProfile('whatsapp', options.profile);
        if (profileResult.profile === null) {
          if (profileResult.error === 'none') {
            throw new CliError('PROFILE_NOT_FOUND', 'No WhatsApp profiles configured', 'Run: agentio whatsapp profile add');
          }
          throw multipleProfilesError('whatsapp', profileResult.names);
        }

        await enforceWriteAccess('whatsapp', profileResult.profile, 'add participants');
        const client = await getDaemonClient();

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
    }),
    `Examples:

  # add one participant by group name
  agentio whatsapp group add "Project Team" +15551234567

  # add several participants at once
  agentio whatsapp group add "Project Team" +15551234567 +15557654321`,
  );

  addExamples(
    group
      .command('remove')
      .description('Remove participants from group')
      .argument('<id>', 'Group ID or name')
      .argument('<phones...>', 'Phone numbers to remove')
      .option('--profile <name>', 'Profile name')
      .action(async (id: string, phones: string[], options) => {
      try {
        const profileResult = await resolveProfile('whatsapp', options.profile);
        if (profileResult.profile === null) {
          if (profileResult.error === 'none') {
            throw new CliError('PROFILE_NOT_FOUND', 'No WhatsApp profiles configured', 'Run: agentio whatsapp profile add');
          }
          throw multipleProfilesError('whatsapp', profileResult.names);
        }

        await enforceWriteAccess('whatsapp', profileResult.profile, 'remove participants');
        const client = await getDaemonClient();

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
    }),
    `Examples:

  # remove one participant
  agentio whatsapp group remove "Project Team" +15551234567

  # remove several at once
  agentio whatsapp group remove "Project Team" +15551234567 +15557654321`,
  );

  addExamples(
    group
      .command('promote')
      .description('Promote participants to admin')
      .argument('<id>', 'Group ID or name')
      .argument('<phones...>', 'Phone numbers to promote')
      .option('--profile <name>', 'Profile name')
      .action(async (id: string, phones: string[], options) => {
      try {
        const profileResult = await resolveProfile('whatsapp', options.profile);
        if (profileResult.profile === null) {
          if (profileResult.error === 'none') {
            throw new CliError('PROFILE_NOT_FOUND', 'No WhatsApp profiles configured', 'Run: agentio whatsapp profile add');
          }
          throw multipleProfilesError('whatsapp', profileResult.names);
        }

        await enforceWriteAccess('whatsapp', profileResult.profile, 'promote participants');
        const client = await getDaemonClient();

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
    }),
    `Examples:

  # promote one participant to admin
  agentio whatsapp group promote "Project Team" +15551234567

  # promote several at once
  agentio whatsapp group promote "Project Team" +15551234567 +15557654321`,
  );

  addExamples(
    group
      .command('demote')
      .description('Demote admins to regular participants')
      .argument('<id>', 'Group ID or name')
      .argument('<phones...>', 'Phone numbers to demote')
      .option('--profile <name>', 'Profile name')
      .action(async (id: string, phones: string[], options) => {
      try {
        const profileResult = await resolveProfile('whatsapp', options.profile);
        if (profileResult.profile === null) {
          if (profileResult.error === 'none') {
            throw new CliError('PROFILE_NOT_FOUND', 'No WhatsApp profiles configured', 'Run: agentio whatsapp profile add');
          }
          throw multipleProfilesError('whatsapp', profileResult.names);
        }

        await enforceWriteAccess('whatsapp', profileResult.profile, 'demote participants');
        const client = await getDaemonClient();

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
    }),
    `Examples:

  # demote one admin
  agentio whatsapp group demote "Project Team" +15551234567

  # demote several at once
  agentio whatsapp group demote "Project Team" +15551234567 +15557654321`,
  );

  addExamples(
    group
      .command('leave')
      .description('Leave a group')
      .argument('<id>', 'Group ID or name')
      .option('--profile <name>', 'Profile name')
      .action(async (id: string, options) => {
      try {
        const profileResult = await resolveProfile('whatsapp', options.profile);
        if (profileResult.profile === null) {
          if (profileResult.error === 'none') {
            throw new CliError('PROFILE_NOT_FOUND', 'No WhatsApp profiles configured', 'Run: agentio whatsapp profile add');
          }
          throw multipleProfilesError('whatsapp', profileResult.names);
        }

        await enforceWriteAccess('whatsapp', profileResult.profile, 'leave group');
        const client = await getDaemonClient();

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
    }),
    `Examples:

  # leave a group by name (asks for confirmation)
  agentio whatsapp group leave "Old Project"

  # leave by JID
  agentio whatsapp group leave 120363123456789012@g.us`,
  );

  addExamples(
    group
      .command('invite')
      .description('Get group invite link')
      .argument('<id>', 'Group ID or name')
      .option('--profile <name>', 'Profile name')
      .action(async (id: string, options) => {
      try {
        const profileResult = await resolveProfile('whatsapp', options.profile);
        if (profileResult.profile === null) {
          if (profileResult.error === 'none') {
            throw new CliError('PROFILE_NOT_FOUND', 'No WhatsApp profiles configured', 'Run: agentio whatsapp profile add');
          }
          throw multipleProfilesError('whatsapp', profileResult.names);
        }

        const client = await getDaemonClient();

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
    }),
    `Examples:

  # get the share link for a group (admin only)
  agentio whatsapp group invite "Project Team"`,
  );

  addExamples(
    group
      .command('join')
      .description('Join group via invite code or link')
      .argument('<code>', 'Invite code or full link (https://chat.whatsapp.com/...)')
      .option('--profile <name>', 'Profile name')
      .action(async (code: string, options) => {
      try {
        const profileResult = await resolveProfile('whatsapp', options.profile);
        if (profileResult.profile === null) {
          if (profileResult.error === 'none') {
            throw new CliError('PROFILE_NOT_FOUND', 'No WhatsApp profiles configured', 'Run: agentio whatsapp profile add');
          }
          throw multipleProfilesError('whatsapp', profileResult.names);
        }

        await enforceWriteAccess('whatsapp', profileResult.profile, 'join group');
        const client = await getDaemonClient();
        const groupId = await client.whatsappGroupJoin(profileResult.profile, code);
        printWhatsAppGroupJoined(groupId);
      } catch (error) {
        handleError(error);
      }
    }),
    `Examples:

  # join via the invite code (last segment of the URL)
  agentio whatsapp group join AbCdEf1234567890

  # join via the full invite URL
  agentio whatsapp group join https://chat.whatsapp.com/AbCdEf1234567890`,
  );
}

export async function whatsappProfileAdd(options: { profile?: string; readOnly?: boolean }): Promise<void> {
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

  // Check if gateway is running (offer to install/start if not)
  const daemonRunning = await ensureDaemonRunning();
  if (!daemonRunning) {
    console.log('\nCannot proceed without the daemon. Re-run after starting it:');
    console.log(`  agentio whatsapp profile add --profile ${profileName}`);
    return;
  }

  // Gateway is running - proceed with pairing
  await runPairingFlow(profileName);

  console.log(`\nProfile "${profileName}" is ready to use.`);
  console.log(`Try: agentio whatsapp inbox pull --profile ${profileName}`);
}
