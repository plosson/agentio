import { Command } from 'commander';
import { join } from 'path';
import { setCredentials } from '../auth/token-store';
import { setProfile, CONFIG_DIR } from '../config/config-manager';
import { createProfileCommands } from '../utils/profile-commands';
import { createClientGetter } from '../utils/client-factory';
import { WhatsAppClient, createWhatsAppSession } from '../services/whatsapp/client';
import { CliError, handleError } from '../utils/errors';
import { readStdin } from '../utils/stdin';
import { printWhatsAppSendResult, printWhatsAppChatList, printWhatsAppCheckResult } from '../utils/output';
import type { WhatsAppCredentials } from '../types/whatsapp';

const getWhatsAppClient = createClientGetter<WhatsAppCredentials, WhatsAppClient>({
  service: 'whatsapp',
  createClient: (credentials) => new WhatsAppClient(credentials),
});

// Simple QR code renderer for terminal (uses Unicode block characters)
function renderQRToTerminal(qrString: string): void {
  // qrString is a compact format, we need to render it using qrcode-terminal style
  // For simplicity, we'll instruct user to use a QR code library or provide the raw string
  // In production, you'd use a package like 'qrcode-terminal' or 'qrcode'

  console.error('\n┌────────────────────────────────────────┐');
  console.error('│       Scan this QR code with           │');
  console.error('│       WhatsApp on your phone           │');
  console.error('│                                        │');
  console.error('│  1. Open WhatsApp                      │');
  console.error('│  2. Tap Menu ⋮ or Settings             │');
  console.error('│  3. Tap "Linked Devices"               │');
  console.error('│  4. Tap "Link a Device"                │');
  console.error('│  5. Point your phone at this QR code   │');
  console.error('└────────────────────────────────────────┘\n');

  // We'll use the qrcode package to render - need to dynamically import
  import('qrcode').then((QRCode) => {
    QRCode.toString(qrString, { type: 'terminal', small: true }, (err: Error | null | undefined, code: string) => {
      if (err) {
        console.error('QR Data (scan with QR app):', qrString);
      } else {
        console.error(code);
      }
    });
  }).catch(() => {
    // Fallback: print raw QR data
    console.error('QR Data:', qrString);
    console.error('\nTip: Install qrcode package for visual QR: bun add qrcode');
  });
}

export function registerWhatsAppCommands(program: Command): void {
  const whatsapp = program
    .command('whatsapp')
    .description('WhatsApp operations');

  // Send command
  whatsapp
    .command('send')
    .description('Send a message to a phone number or group')
    .requiredOption('--to <recipient>', 'Phone number (e.g., +1234567890) or group JID')
    .option('--profile <name>', 'Profile name')
    .option('--media <path>', 'Path to media file to attach')
    .option('--caption <text>', 'Caption for media')
    .argument('[message]', 'Message text (or pipe via stdin)')
    .action(async (message: string | undefined, options) => {
      try {
        let text = message;

        if (!text && !options.media) {
          text = await readStdin() || undefined;
        }

        if (!text && !options.media) {
          throw new CliError(
            'INVALID_PARAMS',
            'Message is required. Provide as argument, pipe via stdin, or attach media.',
          );
        }

        const { client } = await getWhatsAppClient(options.profile);
        const result = await client.send({
          to: options.to,
          text,
          mediaPath: options.media,
          caption: options.caption,
        });

        printWhatsAppSendResult(result);
      } catch (error) {
        handleError(error);
      }
    });

  // List chats command
  whatsapp
    .command('chats')
    .description('List WhatsApp chats (groups)')
    .option('--profile <name>', 'Profile name')
    .option('--limit <n>', 'Maximum number of chats to show', '20')
    .action(async (options) => {
      try {
        const { client } = await getWhatsAppClient(options.profile);
        const chats = await client.getChats({
          limit: parseInt(options.limit, 10),
        });

        printWhatsAppChatList(chats);
      } catch (error) {
        handleError(error);
      }
    });

  // Check if number is on WhatsApp
  whatsapp
    .command('check')
    .description('Check if a phone number is registered on WhatsApp')
    .argument('<phone>', 'Phone number to check (e.g., +1234567890)')
    .option('--profile <name>', 'Profile name')
    .action(async (phone: string, options) => {
      try {
        const { client } = await getWhatsAppClient(options.profile);
        const result = await client.checkNumberExists(phone);

        printWhatsAppCheckResult(phone, result);
      } catch (error) {
        handleError(error);
      }
    });

  // Profile management
  const profile = createProfileCommands<WhatsAppCredentials>(whatsapp, {
    service: 'whatsapp',
    displayName: 'WhatsApp',
    getExtraInfo: (credentials) => {
      if (credentials?.pushName) {
        return ` - ${credentials.pushName}`;
      }
      if (credentials?.phoneNumber) {
        return ` - ${credentials.phoneNumber}`;
      }
      return '';
    },
  });

  profile
    .command('add')
    .description('Add a new WhatsApp profile by linking your device')
    .option('--profile <name>', 'Profile name (default: whatsapp)')
    .action(async (options) => {
      try {
        console.error('\nWhatsApp Device Linking\n');
        console.error('This will link your WhatsApp account to agentio.');
        console.error('Your phone must stay connected to the internet.\n');

        const profileName = options.profile || 'whatsapp';
        const authPath = join(CONFIG_DIR, 'whatsapp-auth', profileName);

        let pushName = 'Unknown';

        await createWhatsAppSession(
          authPath,
          (qr) => {
            renderQRToTerminal(qr);
          },
          (name) => {
            pushName = name;
            console.error(`\nConnected as: ${name}\n`);
          }
        );

        // Save credentials
        const credentials: WhatsAppCredentials = {
          authStatePath: authPath,
          pushName,
        };

        await setProfile('whatsapp', profileName);
        await setCredentials('whatsapp', profileName, credentials);

        console.log(`\nProfile "${profileName}" configured!`);
        console.log(`   Test with: agentio whatsapp send --to +1234567890 --profile ${profileName} "Hello"`);
      } catch (error) {
        handleError(error);
      }
    });
}
