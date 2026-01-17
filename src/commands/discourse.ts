import { Command } from 'commander';
import { setCredentials, removeCredentials, getCredentials } from '../auth/token-store';
import { setProfile, removeProfile, listProfiles, getProfile } from '../config/config-manager';
import { DiscourseClient } from '../services/discourse/client';
import { CliError, handleError } from '../utils/errors';
import { prompt, resolveProfileName } from '../utils/stdin';
import type { DiscourseCredentials } from '../types/discourse';
import {
  printDiscourseTopicList,
  printDiscourseTopic,
  printDiscourseCategoryList,
} from '../utils/output';

async function getDiscourseClient(
  profileName?: string
): Promise<{ client: DiscourseClient; profile: string }> {
  const profile = await getProfile('discourse', profileName);

  if (!profile) {
    throw new CliError(
      'PROFILE_NOT_FOUND',
      profileName
        ? `Profile "${profileName}" not found for discourse`
        : 'No default profile configured for discourse',
      'Run: agentio discourse profile add'
    );
  }

  const credentials = await getCredentials<DiscourseCredentials>('discourse', profile);

  if (!credentials) {
    throw new CliError(
      'AUTH_FAILED',
      `No credentials found for discourse profile "${profile}"`,
      `Run: agentio discourse profile add --profile ${profile}`
    );
  }

  return {
    client: new DiscourseClient(credentials),
    profile,
  };
}

export function registerDiscourseCommands(program: Command): void {
  const discourse = program.command('discourse').description('Discourse forum operations');

  // List topics
  discourse
    .command('list')
    .description('List latest topics')
    .option('--profile <name>', 'Profile name')
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
    .option('--profile <name>', 'Profile name')
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
    .option('--profile <name>', 'Profile name')
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
  const profile = discourse.command('profile').description('Manage Discourse profiles');

  profile
    .command('add')
    .description('Add a new Discourse profile')
    .option('--profile <name>', 'Profile name', 'default')
    .action(async (options) => {
      try {
        const profileName = await resolveProfileName('discourse', options.profile);

        console.error('\n💬 Discourse Setup\n');

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

        console.error(`\n✓ Connected to ${normalizedUrl}`);
        console.error(`✓ Authenticated as ${username}\n`);

        // Save credentials
        await setProfile('discourse', profileName);
        await setCredentials('discourse', profileName, credentials);

        console.log(`\n✅ Profile "${profileName}" configured!`);
        console.log(`   Test with: agentio discourse list --profile ${profileName}`);
      } catch (error) {
        handleError(error);
      }
    });

  profile
    .command('list')
    .description('List Discourse profiles')
    .action(async () => {
      try {
        const result = await listProfiles('discourse');
        const { profiles, default: defaultProfile } = result[0];

        if (profiles.length === 0) {
          console.log('No profiles configured');
        } else {
          for (const name of profiles) {
            const marker = name === defaultProfile ? ' (default)' : '';
            const credentials = await getCredentials<DiscourseCredentials>('discourse', name);
            const urlInfo = credentials?.baseUrl ? ` - ${credentials.baseUrl}` : '';
            console.log(`${name}${marker}${urlInfo}`);
          }
        }
      } catch (error) {
        handleError(error);
      }
    });

  profile
    .command('remove')
    .description('Remove a Discourse profile')
    .requiredOption('--profile <name>', 'Profile name')
    .action(async (options) => {
      try {
        const profileName = options.profile;

        const removed = await removeProfile('discourse', profileName);
        await removeCredentials('discourse', profileName);

        if (removed) {
          console.error(`Removed profile "${profileName}"`);
        } else {
          console.error(`Profile "${profileName}" not found`);
        }
      } catch (error) {
        handleError(error);
      }
    });
}
