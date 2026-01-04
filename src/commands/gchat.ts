import { Command } from 'commander';
import { google } from 'googleapis';
import { createInterface } from 'readline';
import { setCredentials, removeCredentials, getCredentials } from '../auth/token-store';
import { setProfile, removeProfile, listProfiles, getProfile } from '../config/config-manager';
import { performOAuthFlow } from '../auth/oauth';
import { createGoogleAuth } from '../auth/token-manager';
import { GChatClient } from '../services/gchat/client';
import { CliError, handleError } from '../utils/errors';
import { readStdin } from '../utils/stdin';
import { printGChatSendResult, printGChatMessageList, printGChatMessage } from '../utils/output';
import type { GChatCredentials, GChatWebhookCredentials, GChatOAuthCredentials } from '../types/gchat';

function prompt(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function getGChatClient(profileName?: string): Promise<{ client: GChatClient; profile: string }> {
  const profile = await getProfile('gchat', profileName);

  if (!profile) {
    throw new CliError(
      'PROFILE_NOT_FOUND',
      profileName
        ? `Profile "${profileName}" not found for gchat`
        : 'No default profile configured for gchat',
      'Run: agentio gchat profile add'
    );
  }

  const credentials = await getCredentials<GChatCredentials>('gchat', profile);

  if (!credentials) {
    throw new CliError(
      'AUTH_FAILED',
      `No credentials found for gchat profile "${profile}"`,
      `Run: agentio gchat profile add --profile ${profile}`
    );
  }

  return {
    client: new GChatClient(credentials),
    profile,
  };
}

export function registerGChatCommands(program: Command): void {
  const gchat = program
    .command('gchat')
    .description('Google Chat operations');

  gchat
    .command('send')
    .description('Send a message to Google Chat')
    .option('--profile <name>', 'Profile name')
    .option('--space <id>', 'Space ID (required for OAuth profiles)')
    .option('--thread <id>', 'Thread ID (optional)')
    .argument('[message]', 'Message text (or pipe via stdin)')
    .action(async (message: string | undefined, options) => {
      try {
        let text = message;

        if (!text) {
          text = await readStdin() || undefined;
        }

        if (!text) {
          throw new CliError('INVALID_PARAMS', 'Message is required. Provide as argument or pipe via stdin.');
        }

        const { client } = await getGChatClient(options.profile);
        const result = await client.send({
          text,
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
    .option('--profile <name>', 'Profile name')
    .requiredOption('--space <id>', 'Space ID')
    .option('--limit <n>', 'Number of messages', '10')
    .action(async (options) => {
      try {
        const { client } = await getGChatClient(options.profile);
        const messages = await client.list({
          spaceId: options.space,
          limit: parseInt(options.limit, 10),
        });

        printGChatMessageList(messages);
      } catch (error) {
        handleError(error);
      }
    });

  gchat
    .command('get <message-id>')
    .description('Get a message from a Google Chat space (OAuth profiles only)')
    .option('--profile <name>', 'Profile name')
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

  // Profile management
  const profile = gchat
    .command('profile')
    .description('Manage Google Chat profiles');

  profile
    .command('add')
    .description('Add a new Google Chat profile (webhook or OAuth)')
    .option('--profile <name>', 'Profile name', 'default')
    .action(async (options) => {
      try {
        const profileName = options.profile;

        console.error('\nGoogle Chat Setup\n');

        const profileType = await prompt('Choose profile type (webhook/oauth): ');

        if (profileType.toLowerCase() === 'webhook') {
          await setupWebhookProfile(profileName);
        } else if (profileType.toLowerCase() === 'oauth') {
          await setupOAuthProfile(profileName);
        } else {
          throw new CliError('INVALID_PARAMS', 'Profile type must be "webhook" or "oauth"');
        }
      } catch (error) {
        handleError(error);
      }
    });

  profile
    .command('list')
    .description('List Google Chat profiles')
    .action(async () => {
      try {
        const result = await listProfiles('gchat');
        const { profiles, default: defaultProfile } = result[0];

        if (profiles.length === 0) {
          console.log('No profiles configured');
        } else {
          for (const name of profiles) {
            const marker = name === defaultProfile ? ' (default)' : '';
            const credentials = await getCredentials<GChatCredentials>('gchat', name);
            const typeInfo = credentials?.type === 'webhook' ? ' - webhook' : ' - oauth';
            console.log(`${name}${marker}${typeInfo}`);
          }
        }
      } catch (error) {
        handleError(error);
      }
    });

  profile
    .command('remove')
    .description('Remove a Google Chat profile')
    .requiredOption('--profile <name>', 'Profile name')
    .action(async (options) => {
      try {
        const profileName = options.profile;

        const removed = await removeProfile('gchat', profileName);
        await removeCredentials('gchat', profileName);

        if (removed) {
          console.log(`Removed profile "${profileName}"`);
        } else {
          console.error(`Profile "${profileName}" not found`);
        }
      } catch (error) {
        handleError(error);
      }
    });
}

function printProfileSetupSuccess(profileName: string, authType: 'webhook' | 'oauth'): void {
  const typeLabel = authType.charAt(0).toUpperCase() + authType.slice(1);
  console.log(`\nSuccess! ${typeLabel} profile "${profileName}" configured.`);
  console.log(`   Test with: agentio gchat send --profile ${profileName} "Hello from agentio"`);
}

async function setupWebhookProfile(profileName: string): Promise<void> {
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

  await setProfile('gchat', profileName);
  await setCredentials('gchat', profileName, credentials);

  printProfileSetupSuccess(profileName, 'webhook');
}

async function setupOAuthProfile(profileName: string): Promise<void> {
  console.error('OAuth Setup\n');
  console.error('Starting OAuth flow for Google Chat profile...\n');

  const tokens = await performOAuthFlow('gchat');

  // Optionally fetch user info - Chat API doesn't have a getProfile like Gmail
  // For now, just validate the token works
  try {
    const auth = createGoogleAuth(tokens);
    const chat = google.chat({ version: 'v1', auth });
    // Simple validation: list spaces
    await chat.spaces.list({ pageSize: 1 });
  } catch (error) {
    throw new CliError(
      'AUTH_FAILED',
      'Failed to validate Google Chat access. Check OAuth scopes.',
      'Try again with: agentio gchat profile add --profile ' + profileName
    );
  }

  const credentials: GChatOAuthCredentials = {
    type: 'oauth',
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiryDate: tokens.expiry_date,
    tokenType: tokens.token_type,
    scope: tokens.scope,
  };

  await setProfile('gchat', profileName);
  await setCredentials('gchat', profileName, credentials);

  printProfileSetupSuccess(profileName, 'oauth');
}
