import { Command } from 'commander';
import { setCredentials } from '../auth/token-store';
import { setProfile } from '../config/config-manager';
import { createProfileCommands } from '../utils/profile-commands';
import { createClientGetter } from '../utils/client-factory';
import { DiscourseClient } from '../services/discourse/client';
import { CliError, handleError } from '../utils/errors';
import { prompt } from '../utils/stdin';
import type { DiscourseCredentials } from '../types/discourse';
import {
  printDiscourseTopicList,
  printDiscourseTopic,
  printDiscourseCategoryList,
} from '../utils/output';

const getDiscourseClient = createClientGetter<DiscourseCredentials, DiscourseClient>({
  service: 'discourse',
  createClient: (credentials) => new DiscourseClient(credentials),
});

export function registerDiscourseCommands(program: Command): void {
  const discourse = program.command('discourse').description('Discourse forum operations');

  // List topics
  discourse
    .command('list')
    .description('List latest topics')
    .requiredOption('--profile <name>', 'Profile name')
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
    });

  // Get topic detail
  discourse
    .command('get')
    .description('Get a topic with its posts')
    .argument('<topic-id>', 'Topic ID')
    .requiredOption('--profile <name>', 'Profile name')
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
    });

  // List categories
  discourse
    .command('categories')
    .description('List all categories')
    .requiredOption('--profile <name>', 'Profile name')
    .action(async (options) => {
      try {
        const { client } = await getDiscourseClient(options.profile);
        const categories = await client.getCategories();
        printDiscourseCategoryList(categories);
      } catch (error) {
        handleError(error);
      }
    });

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
    .action(async (options) => {
      try {
        console.error('\nDiscourse Setup\n');

        // Step 1: Get base URL
        console.error('Step 1: Enter your Discourse forum URL');
        console.error('  Example: https://meta.discourse.org or https://forum.example.com\n');

        const baseUrl = await prompt('? Forum URL: ');

        if (!baseUrl) {
          throw new CliError('INVALID_PARAMS', 'Forum URL is required');
        }

        // Normalize URL
        let normalizedUrl = baseUrl.trim();
        if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
          normalizedUrl = `https://${normalizedUrl}`;
        }
        normalizedUrl = normalizedUrl.replace(/\/$/, '');

        // Step 2: Get API credentials
        console.error('\nStep 2: Create an API key');
        console.error('  1. Go to your Discourse admin panel');
        console.error(`     ${normalizedUrl}/admin/api/keys`);
        console.error('  2. Click "New API Key"');
        console.error('  3. Description: "agentio CLI"');
        console.error('  4. User Level: Choose your user or "All Users" for admin access');
        console.error('  5. Scope: "Read" (or "Read, Write" if you plan to create topics later)');
        console.error('  6. Click "Save" and copy the API key\n');

        const apiKey = await prompt('? API Key: ');

        if (!apiKey) {
          throw new CliError('INVALID_PARAMS', 'API key is required');
        }

        console.error('\nStep 3: Enter your Discourse username');
        console.error('  This should match the user associated with the API key\n');

        const username = await prompt('? Username: ');

        if (!username) {
          throw new CliError('INVALID_PARAMS', 'Username is required');
        }

        // Validate credentials
        console.error('\nValidating credentials...');

        const credentials: DiscourseCredentials = {
          baseUrl: normalizedUrl,
          apiKey: apiKey.trim(),
          username: username.trim(),
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
                `Cannot connect to ${normalizedUrl}`,
                'Check the URL and your network connection'
              );
            }
          }
          throw error;
        }

        console.error(`\nConnected to ${normalizedUrl}`);
        console.error(`Authenticated as ${username}\n`);

        // Auto-name based on username
        const profileName = options.profile || username.trim();

        // Save credentials
        await setProfile('discourse', profileName);
        await setCredentials('discourse', profileName, credentials);

        console.log(`\nProfile "${profileName}" configured!`);
        console.log(`   Test with: agentio discourse list --profile ${profileName}`);
      } catch (error) {
        handleError(error);
      }
    });
}
