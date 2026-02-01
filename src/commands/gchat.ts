import { Command } from 'commander';
import { chat as gchat } from '@googleapis/chat';
import { readFile } from 'fs/promises';
import { setCredentials } from '../auth/token-store';
import { setProfile, getProfile } from '../config/config-manager';
import { createProfileCommands } from '../utils/profile-commands';
import { createClientGetter } from '../utils/client-factory';
import { performOAuthFlow } from '../auth/oauth';
import { createGoogleAuth, fetchGoogleUserEmail } from '../auth/token-manager';
import { GChatClient } from '../services/gchat/client';
import { CliError, handleError } from '../utils/errors';
import { readStdin, prompt } from '../utils/stdin';
import { interactiveSelect } from '../utils/interactive';
import { printGChatSendResult, printGChatMessageList, printGChatMessage, printGChatSpaceList } from '../utils/output';
import { enforceWriteAccess } from '../utils/read-only';
import type { GChatCredentials, GChatWebhookCredentials, GChatOAuthCredentials } from '../types/gchat';

const getGChatClient = createClientGetter<GChatCredentials, GChatClient>({
  service: 'gchat',
  createClient: (credentials) => new GChatClient(credentials),
});

export function registerGChatCommands(program: Command): void {
  const gchat = program
    .command('gchat')
    .description('Google Chat operations');

  gchat
    .command('send')
    .description('Send a message to Google Chat')
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
    .option('--space <id>', 'Space ID (required for OAuth profiles)')
    .option('--thread <id>', 'Thread ID (optional)')
    .option('--json [file]', 'Send rich message from JSON file (or stdin if no file specified)')
    .argument('[message]', 'Message text (or pipe via stdin)')
    .action(async (message: string | undefined, options) => {
      try {
        let text: string | undefined = message;
        let payload: Record<string, unknown> | undefined;

        // Handle --json option
        if (options.json !== undefined) {
          // Check mutual exclusivity
          if (message) {
            throw new CliError(
              'INVALID_PARAMS',
              'Cannot use both text message and --json option',
              'Use either: agentio gchat send "text" OR agentio gchat send --json file.json'
            );
          }

          let jsonContent: string;

          if (typeof options.json === 'string') {
            // Read from file
            try {
              jsonContent = await readFile(options.json, 'utf-8');
            } catch (err) {
              throw new CliError(
                'INVALID_PARAMS',
                `Failed to read JSON file: ${options.json}`,
                'Check that the file exists and is readable'
              );
            }
          } else {
            // Read from stdin
            const stdinContent = await readStdin();
            if (!stdinContent) {
              throw new CliError(
                'INVALID_PARAMS',
                'No JSON provided via stdin',
                'Pipe JSON content: cat message.json | agentio gchat send --json'
              );
            }
            jsonContent = stdinContent;
          }

          // Parse JSON
          try {
            payload = JSON.parse(jsonContent) as Record<string, unknown>;
          } catch (err) {
            throw new CliError(
              'INVALID_PARAMS',
              `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
              'Check that the JSON is valid'
            );
          }
        } else {
          // Text message mode
          if (!text) {
            text = await readStdin() || undefined;
          }

          if (!text) {
            throw new CliError('INVALID_PARAMS', 'Message is required. Provide as argument or pipe via stdin.');
          }
        }

        const { client, profile } = await getGChatClient(options.profile);
        await enforceWriteAccess('gchat', profile, 'send message');
        const result = await client.send({
          text,
          payload,
          threadId: options.thread,
          spaceId: options.space,
        });

        printGChatSendResult(result);
      } catch (error) {
        handleError(error);
      }
    });

  gchat
    .command('list')
    .description('List messages from a Google Chat space (OAuth profiles only)')
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
    .requiredOption('--space <id>', 'Space ID')
    .option('--limit <n>', 'Number of messages', '10')
    .option('--thread <id>', 'Filter by thread ID')
    .option('--since <date>', 'Only messages after this date (YYYY-MM-DD)')
    .action(async (options) => {
      try {
        const { client } = await getGChatClient(options.profile);
        const messages = await client.list({
          spaceId: options.space,
          limit: parseInt(options.limit, 10),
          threadId: options.thread,
          since: options.since ? new Date(options.since) : undefined,
        });

        printGChatMessageList(messages);
      } catch (error) {
        handleError(error);
      }
    });

  gchat
    .command('get')
    .argument('<message-id>', 'Message ID')
    .description('Get a message from a Google Chat space (OAuth profiles only)')
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
    .requiredOption('--space <id>', 'Space ID')
    .action(async (messageId: string, options) => {
      try {
        const { client } = await getGChatClient(options.profile);
        const message = await client.get({
          spaceId: options.space,
          messageId: messageId,
        });

        printGChatMessage(message);
      } catch (error) {
        handleError(error);
      }
    });

  gchat
    .command('spaces')
    .description('List available Google Chat spaces (OAuth profiles only)')
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
    .option('--filter <text>', 'Filter spaces by name (case-insensitive)')
    .action(async (options) => {
      try {
        const { client } = await getGChatClient(options.profile);
        let spaces = await client.listSpaces();

        if (options.filter) {
          const filterLower = options.filter.toLowerCase();
          spaces = spaces.filter(s => s.displayName.toLowerCase().includes(filterLower));
        }

        printGChatSpaceList(spaces);
      } catch (error) {
        handleError(error);
      }
    });

  // Profile management
  const profile = createProfileCommands<GChatCredentials>(gchat, {
    service: 'gchat',
    displayName: 'Google Chat',
    getExtraInfo: (credentials) => credentials?.type === 'webhook' ? ' - webhook' : ' - oauth',
  });

  profile
    .command('add')
    .description('Add a new Google Chat profile (webhook or OAuth)')
    .option('--profile <name>', 'Profile name (required for webhook, auto-detected for OAuth)')
    .option('--read-only', 'Create as read-only profile (blocks write operations)')
    .action(async (options) => {
      try {
        console.error('\nGoogle Chat Setup\n');

        const profileType = await interactiveSelect({
          message: 'Choose profile type:',
          choices: [
            { name: 'Webhook', value: 'webhook', description: 'Simple incoming webhook URL' },
            { name: 'OAuth', value: 'oauth', description: 'Full API access with Google Workspace account' },
          ],
        });

        if (profileType === 'webhook') {
          if (!options.profile) {
            throw new CliError(
              'INVALID_PARAMS',
              'Profile name is required for webhook profiles',
              'Run: agentio gchat profile add --profile <name>'
            );
          }
          await setupWebhookProfile(options.profile, options.readOnly);
        } else {
          await setupOAuthProfile(options.profile, options.readOnly);
        }
      } catch (error) {
        handleError(error);
      }
    });
}

function printProfileSetupSuccess(profileName: string, authType: 'webhook' | 'oauth', readOnly?: boolean): void {
  const typeLabel = authType.charAt(0).toUpperCase() + authType.slice(1);
  console.log(`\nSuccess! ${typeLabel} profile "${profileName}" configured.`);
  if (readOnly) {
    console.log(`   Access: read-only`);
  }
  console.log(`   Test with: agentio gchat send --profile ${profileName} "Hello from agentio"`);
}

async function setupWebhookProfile(profileName: string, readOnly?: boolean): Promise<void> {
  console.error('Webhook Setup\n');
  console.error('1. In Google Chat, find or create a space');
  console.error('2. Go to Space Settings → Webhooks');
  console.error('3. Create a new webhook and copy the URL\n');

  const webhookUrl = await prompt('? Paste your webhook URL: ');

  if (!webhookUrl) {
    throw new CliError('INVALID_PARAMS', 'Webhook URL is required');
  }

  // Validate webhook with a test request
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: 'Test message from agentio setup' }),
    });

    if (!response.ok) {
      throw new CliError(
        'API_ERROR',
        `Webhook validation failed: ${response.status}`,
        'Check the webhook URL and try again'
      );
    }
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(
      'API_ERROR',
      `Failed to validate webhook: ${err instanceof Error ? err.message : String(err)}`,
      'Check that the URL is correct and accessible'
    );
  }

  const credentials: GChatWebhookCredentials = {
    type: 'webhook',
    webhookUrl: webhookUrl,
  };

  await setProfile('gchat', profileName, { readOnly });
  await setCredentials('gchat', profileName, credentials);

  printProfileSetupSuccess(profileName, 'webhook', readOnly);
}

async function setupOAuthProfile(profileNameOverride?: string, readOnly?: boolean): Promise<void> {
  console.error('OAuth Setup\n');
  console.error('Starting OAuth flow for Google Chat profile...\n');

  const tokens = await performOAuthFlow('gchat');
  const auth = createGoogleAuth(tokens);

  // Fetch user email for profile naming
  let userEmail: string;
  try {
    userEmail = await fetchGoogleUserEmail(tokens.access_token);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new CliError(
      'AUTH_FAILED',
      `Failed to fetch user email: ${errorMessage}`,
      'Ensure the account has an email address'
    );
  }

  // Validate the token works with Chat API
  try {
    const chatApi = gchat({ version: 'v1', auth: auth as any });
    await chatApi.spaces.list({ pageSize: 1 });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new CliError(
      'AUTH_FAILED',
      `Failed to validate Google Chat access: ${errorMessage}`,
      'Google Chat API requires a Google Workspace account. Personal Gmail accounts cannot use the Chat API.'
    );
  }

  // Determine profile name: use explicit override, or email, or email-readonly if conflict
  let profileName: string;
  if (profileNameOverride) {
    profileName = profileNameOverride;
  } else if (readOnly && await getProfile('gchat', userEmail)) {
    // Profile with email already exists, use -readonly suffix
    profileName = `${userEmail}-readonly`;
  } else {
    profileName = userEmail;
  }

  const credentials: GChatOAuthCredentials = {
    type: 'oauth',
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiryDate: tokens.expiry_date,
    tokenType: tokens.token_type,
    scope: tokens.scope,
    email: userEmail,
  };

  await setProfile('gchat', profileName, { readOnly });
  await setCredentials('gchat', profileName, credentials);

  printProfileSetupSuccess(profileName, 'oauth', readOnly);
}
