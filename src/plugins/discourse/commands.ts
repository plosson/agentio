import { Command } from 'commander';
import { createProfileCommands } from '../../utils/profile-commands';
import { addProfileWithSetup } from '../profile-host';
import { createClientGetter } from '../../utils/client-factory';
import { DiscourseClient } from './client';
import { CliError, handleError } from '../../utils/errors';
import { addExamples } from '../../utils/command-tree';
import type { DiscourseCredentials } from './types';
import type { InputSpec, SetupContext, SetupResult } from '../../plugin-sdk';
import {
  printDiscourseTopicList,
  printDiscourseTopic,
  printDiscourseCategoryList,
} from './output';

const DISCOURSE_URL_INPUT: InputSpec = { label: 'Forum URL', kind: 'url', help: 'For example https://meta.discourse.org' };
const DISCOURSE_API_KEY_INPUT: InputSpec = { label: 'API key', kind: 'secret', help: 'Create one in your forum\'s admin, API keys (/admin/api/keys)' };
const DISCOURSE_USERNAME_INPUT: InputSpec = { label: 'Username', kind: 'text', help: 'The user the API key acts as' };

const getDiscourseClient = createClientGetter<DiscourseCredentials, DiscourseClient>({
  service: 'discourse',
  createClient: (credentials) => new DiscourseClient(credentials),
});

export function registerDiscourseCommands(program: Command): void {
  const discourse = program.command('discourse').description('Discourse forum operations');

  // List topics
  addExamples(
    discourse
      .command('list')
      .description('List latest topics')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .option('--category <slug>', 'Filter by category slug or name')
      .option('--page <number>', 'Page number (0-indexed)', '0')
      .action(async (options) => {
        try {
          const { client } = await getDiscourseClient(options.profile);
          const topics = await client.listTopics({
            category: options.category,
            page: parseInt(options.page, 10),
          });
          printDiscourseTopicList(topics);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # latest topics on the default profile
  agentio discourse list

  # second page of topics in a specific category
  agentio discourse list --category support --page 1

  # latest topics on a named profile
  agentio discourse list --profile meta`,
  );

  // Get topic detail
  addExamples(
    discourse
      .command('get')
      .description('Get a topic with its posts')
      .argument('<topic-id>', 'Topic ID')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .action(async (topicId: string, options) => {
        try {
          const id = parseInt(topicId, 10);
          if (isNaN(id)) {
            throw new CliError('INVALID_PARAMS', 'Topic ID must be a number');
          }

          const { client } = await getDiscourseClient(options.profile);
          const topic = await client.getTopic(id);
          printDiscourseTopic(topic);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # get a topic and its posts by numeric ID
  agentio discourse get 12345

  # use a named profile
  agentio discourse get 12345 --profile meta`,
  );

  // List categories
  addExamples(
    discourse
      .command('categories')
      .description('List all categories')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .action(async (options) => {
        try {
          const { client } = await getDiscourseClient(options.profile);
          const categories = await client.getCategories();
          printDiscourseCategoryList(categories);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # list all visible categories
  agentio discourse categories

  # categories on a named forum profile
  agentio discourse categories --profile meta`,
  );

  // Profile management
  const profile = createProfileCommands<DiscourseCredentials>(discourse, {
    service: 'discourse',
    displayName: 'Discourse',
    getExtraInfo: (credentials) => credentials?.baseUrl ? ` - ${credentials.baseUrl}` : '',
  });

  profile
    .command('add')
    .description('Add a new Discourse profile')
    .option('--profile <name>', 'Profile name (auto-detected from username if not provided)')
    .option('--read-only', 'Create as read-only profile (blocks write operations)')
    .action(async (options) => {
      try {
        await addProfileWithSetup('discourse', discourseProfileAdd, options);
      } catch (error) {
        handleError(error);
      }
    });
}

export async function discourseProfileAdd(
  options: { profile?: string; readOnly?: boolean },
  context: SetupContext,
): Promise<SetupResult<DiscourseCredentials>> {
  const baseUrl = await context.ask(DISCOURSE_URL_INPUT);

  context.log('Create an API key');
  context.log('  1. Go to your Discourse admin panel');
  context.log(`     ${baseUrl}/admin/api/keys`);
  context.log('  2. Click "New API Key"');
  context.log('  3. Description: "agentio CLI"');
  context.log('  4. User Level: Choose your user or "All Users" for admin access');
  context.log('  5. Scope: "Read" (or "Read, Write" if you plan to create topics later)');
  context.log('  6. Click "Save" and copy the API key');

  const apiKey = await context.ask(DISCOURSE_API_KEY_INPUT);
  const username = await context.ask(DISCOURSE_USERNAME_INPUT);

  context.log('Validating credentials...');

  const credentials: DiscourseCredentials = {
    baseUrl,
    apiKey,
    username,
  };

  const client = new DiscourseClient(credentials);
  try {
    await client.validateCredentials();
  } catch (error) {
    if (error instanceof CliError) {
      if (error.code === 'AUTH_FAILED') {
        throw new CliError(
          'AUTH_FAILED',
          'Invalid API key or username. Please check your credentials.',
          'Make sure the API key is active and the username matches'
        );
      }
      if (error.code === 'NETWORK_ERROR') {
        throw new CliError(
          'NETWORK_ERROR',
          `Cannot connect to ${baseUrl}`,
          'Check the URL and your network connection'
        );
      }
    }
    throw error;
  }

  context.log(`Connected to ${baseUrl}`);
  context.log(`Authenticated as ${username}`);

  return { credentials, suggestedProfileName: username, info: 'Test with: agentio discourse list' };
}
