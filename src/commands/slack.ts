import { Command } from 'commander';
import { createInterface } from 'readline';
import { readFile } from 'fs/promises';
import { setCredentials, removeCredentials, getCredentials } from '../auth/token-store';
import { setProfile, removeProfile, listProfiles, getProfile } from '../config/config-manager';
import { SlackClient } from '../services/slack/client';
import { CliError, handleError } from '../utils/errors';
import { readStdin } from '../utils/stdin';
import { printSlackSendResult } from '../utils/output';
import type { SlackCredentials, SlackWebhookCredentials } from '../types/slack';

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

async function getSlackClient(profileName?: string): Promise<{ client: SlackClient; profile: string }> {
  const profile = await getProfile('slack', profileName);

  if (!profile) {
    throw new CliError(
      'PROFILE_NOT_FOUND',
      profileName
        ? `Profile "${profileName}" not found for slack`
        : 'No default profile configured for slack',
      'Run: agentio slack profile add'
    );
  }

  const credentials = await getCredentials<SlackCredentials>('slack', profile);

  if (!credentials) {
    throw new CliError(
      'AUTH_FAILED',
      `No credentials found for slack profile "${profile}"`,
      `Run: agentio slack profile add --profile ${profile}`
    );
  }

  return {
    client: new SlackClient(credentials),
    profile,
  };
}

export function registerSlackCommands(program: Command): void {
  const slack = program
    .command('slack')
    .description('Slack operations');

  slack
    .command('send')
    .description('Send a message to Slack')
    .option('--profile <name>', 'Profile name')
    .option('--json [file]', 'Send Block Kit message from JSON file (or stdin if no file specified)')
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
              'Use either: agentio slack send "text" OR agentio slack send --json file.json'
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
                'Pipe JSON content: cat message.json | agentio slack send --json'
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

        const { client } = await getSlackClient(options.profile);
        const result = await client.send({
          text,
          payload,
        });

        printSlackSendResult(result);
      } catch (error) {
        handleError(error);
      }
    });

  // Profile management
  const profile = slack
    .command('profile')
    .description('Manage Slack profiles');

  profile
    .command('add')
    .description('Add a new Slack profile (webhook)')
    .option('--profile <name>', 'Profile name', 'default')
    .action(async (options) => {
      try {
        const profileName = options.profile;
        await setupWebhookProfile(profileName);
      } catch (error) {
        handleError(error);
      }
    });

  profile
    .command('list')
    .description('List Slack profiles')
    .action(async () => {
      try {
        const result = await listProfiles('slack');
        const { profiles, default: defaultProfile } = result[0];

        if (profiles.length === 0) {
          console.log('No profiles configured');
        } else {
          for (const name of profiles) {
            const marker = name === defaultProfile ? ' (default)' : '';
            const credentials = await getCredentials<SlackCredentials>('slack', name);
            const channelInfo = credentials?.channelName ? ` - #${credentials.channelName}` : ' - webhook';
            console.log(`${name}${marker}${channelInfo}`);
          }
        }
      } catch (error) {
        handleError(error);
      }
    });

  profile
    .command('remove')
    .description('Remove a Slack profile')
    .requiredOption('--profile <name>', 'Profile name')
    .action(async (options) => {
      try {
        const profileName = options.profile;

        const removed = await removeProfile('slack', profileName);
        await removeCredentials('slack', profileName);

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

async function setupWebhookProfile(profileName: string): Promise<void> {
  console.error('\nSlack Webhook Setup\n');
  console.error('1. Go to https://api.slack.com/apps and create a new app (or use existing)');
  console.error('2. Enable "Incoming Webhooks" in Features');
  console.error('3. Click "Add New Webhook to Workspace" and select a channel');
  console.error('4. Copy the Webhook URL\n');

  const webhookUrl = await prompt('? Paste your webhook URL: ');

  if (!webhookUrl) {
    throw new CliError('INVALID_PARAMS', 'Webhook URL is required');
  }

  if (!webhookUrl.startsWith('https://hooks.slack.com/')) {
    throw new CliError(
      'INVALID_PARAMS',
      'Invalid Slack webhook URL',
      'URL should start with https://hooks.slack.com/'
    );
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
      const error = await response.text();
      throw new CliError(
        'API_ERROR',
        `Webhook validation failed: ${response.status} ${error}`,
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

  const channelName = await prompt('? Channel name (optional, for display): ');

  const credentials: SlackWebhookCredentials = {
    type: 'webhook',
    webhookUrl: webhookUrl,
    channelName: channelName || undefined,
  };

  await setProfile('slack', profileName);
  await setCredentials('slack', profileName, credentials);

  console.log(`\nSuccess! Webhook profile "${profileName}" configured.`);
  console.log(`   Test with: agentio slack send --profile ${profileName} "Hello from agentio"`);
}
