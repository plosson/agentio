import type { Command } from 'commander';
import { readFile } from 'fs/promises';
import { addProfileWithSetup } from '../profile-host';
import { addExamples } from '../../utils/command-tree';
import { createClientGetter } from '../../utils/client-factory';
import { CliError, handleError } from '../../utils/errors';
import { createProfileCommands } from '../../utils/profile-commands';
import { enforceWriteAccess } from '../../utils/read-only';
import { readStdin } from '../../utils/stdin';
import { SlackClient } from './client';
import { checkWebhookUrl } from '../webhook-check';
import { printSlackSendResult } from './output';
import type { SlackCredentials, SlackWebhookCredentials } from './types';
import type { InputSpec, SetupContext, SetupResult } from '../../plugin-sdk';

const SLACK_WEBHOOK_INPUT: InputSpec = {
  label: 'Webhook URL', kind: 'secret',
  help: 'From your Slack app: Incoming Webhooks, Add New Webhook to Workspace (https://api.slack.com/apps)',
};
const SLACK_CHANNEL_INPUT: InputSpec = { label: 'Channel name', kind: 'text', required: false, help: 'Only for display; also the default profile name' };

const getSlackClient = createClientGetter<SlackCredentials, SlackClient>({
  service: 'slack',
  createClient: (credentials) => new SlackClient(credentials),
});

export function registerSlackCommands(program: Command): void {
  const slack = program
    .command('slack')
    .description('Slack operations');

  addExamples(
    slack
      .command('send')
      .description('Send a message to Slack')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .option('--json [file]', 'Send Block Kit message from JSON file (or stdin if no file specified)')
      .argument('[message]', 'Message text (or pipe via stdin)')
      .action(async (message: string | undefined, options) => {
        try {
          let text: string | undefined = message;
          let payload: Record<string, unknown> | undefined;

          if (options.json !== undefined) {
            if (message) {
              throw new CliError(
                'INVALID_PARAMS',
                'Cannot use both text message and --json option',
                'Use either: agentio slack send "text" OR agentio slack send --json file.json',
              );
            }

            let jsonContent: string;

            if (typeof options.json === 'string') {
              try {
                jsonContent = await readFile(options.json, 'utf-8');
              } catch {
                throw new CliError(
                  'INVALID_PARAMS',
                  `Failed to read JSON file: ${options.json}`,
                  'Check that the file exists and is readable',
                );
              }
            } else {
              const stdinContent = await readStdin();
              if (!stdinContent) {
                throw new CliError(
                  'INVALID_PARAMS',
                  'No JSON provided via stdin',
                  'Pipe JSON content: cat message.json | agentio slack send --json',
                );
              }
              jsonContent = stdinContent;
            }

            try {
              payload = JSON.parse(jsonContent) as Record<string, unknown>;
            } catch (err) {
              throw new CliError(
                'INVALID_PARAMS',
                `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
                'Check that the JSON is valid',
              );
            }
          } else {
            if (!text) {
              text = await readStdin() || undefined;
            }

            if (!text) {
              throw new CliError('INVALID_PARAMS', 'Message is required. Provide as argument or pipe via stdin.');
            }
          }

          const { client, profile } = await getSlackClient(options.profile);
          await enforceWriteAccess('slack', profile, 'send message');
          const result = await client.send({ text, payload });
          printSlackSendResult(result);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # send a quick text message to the default profile
  agentio slack send "deploy finished"

  # pipe message body via stdin
  echo "build failed: see logs" | agentio slack send

  # send a Block Kit payload from a JSON file
  agentio slack send --json ./alert.json

  # send to a specific profile
  agentio slack send --profile alerts "incident opened"`,
  );

  const profile = createProfileCommands<SlackCredentials>(slack, {
    service: 'slack',
    displayName: 'Slack',
    getExtraInfo: (credentials) => credentials?.channelName ? ` - #${credentials.channelName}` : ' - webhook',
  });

  profile
    .command('add')
    .description('Add a new Slack profile (webhook)')
    .option('--profile <name>', 'Profile name (default: the channel name, else "webhook")')
    .option('--read-only', 'Create as read-only profile (blocks write operations)')
    .action(async (options) => {
        try {
          await addProfileWithSetup('slack', slackProfileAdd, options);
        } catch (error) {
          handleError(error);
        }
      });
}

export async function slackProfileAdd(_options: { profile?: string; readOnly?: boolean }, context: SetupContext): Promise<SetupResult<SlackCredentials>> {
  context.log('\nSlack Webhook Setup\n');
  context.log('1. Go to https://api.slack.com/apps and create a new app (or use existing)');
  context.log('2. Enable "Incoming Webhooks" in Features');
  context.log('3. Click "Add New Webhook to Workspace" and select a channel');
  context.log('4. Copy the Webhook URL\n');

  const webhookUrl = await context.ask(SLACK_WEBHOOK_INPUT);

  await checkWebhookUrl(webhookUrl, {
    prefix: 'https://hooks.slack.com/',
    invalidMessage: 'Invalid Slack webhook URL',
    invalidSuggestion: 'URL should start with https://hooks.slack.com/',
    showResponseBody: true,
  }, context);

  const channelName = await context.ask(SLACK_CHANNEL_INPUT);

  const credentials: SlackWebhookCredentials = {
    type: 'webhook',
    webhookUrl,
    channelName: channelName || undefined,
  };

  return {
    credentials,
    suggestedProfileName: channelName || 'webhook',
    info: 'Test with: agentio slack send "Hello from agentio"',
  };
}
