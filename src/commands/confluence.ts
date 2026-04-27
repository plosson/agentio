import { Command } from 'commander';
import { setCredentials, getCredentials } from '../auth/token-store';
import { setProfile, resolveProfile } from '../config/config-manager';
import { createProfileCommands } from '../utils/profile-commands';
import {
  performConfluenceOAuthFlow,
  refreshConfluenceToken,
  type AtlassianSite,
} from '../auth/confluence-oauth';
import { ConfluenceClient } from '../services/confluence/client';
import { CliError, handleError, multipleProfilesError } from '../utils/errors';
import { readStdin } from '../utils/stdin';
import { interactiveSelect } from '../utils/interactive';
import { enforceWriteAccess } from '../utils/read-only';
import {
  printConfluenceSpaceList,
  printConfluencePageList,
  printConfluencePage,
  printConfluenceCommentList,
  printConfluenceSearchResults,
  printConfluencePageCreated,
  printConfluencePageUpdated,
  printConfluenceCommentResult,
} from '../utils/output';
import type { ConfluenceCredentials } from '../types/confluence';

async function ensureValidToken(
  credentials: ConfluenceCredentials,
  profile: string
): Promise<ConfluenceCredentials> {
  const bufferTime = 5 * 60 * 1000;
  if (credentials.expiryDate && Date.now() + bufferTime >= credentials.expiryDate) {
    console.error('Access token expired, refreshing...');

    try {
      const refreshed = await refreshConfluenceToken(credentials.refreshToken);

      const newCredentials: ConfluenceCredentials = {
        ...credentials,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiryDate: Date.now() + refreshed.expiresIn * 1000,
      };

      await setCredentials('confluence', profile, newCredentials);
      return newCredentials;
    } catch {
      throw new CliError(
        'AUTH_FAILED',
        'Failed to refresh access token. Please re-authenticate.',
        `Run: agentio confluence profile add --profile ${profile}`
      );
    }
  }

  return credentials;
}

async function getConfluenceClient(
  profileName?: string
): Promise<{ client: ConfluenceClient; profile: string }> {
  const profileResult = await resolveProfile('confluence', profileName);

  if (profileResult.profile === null) {
    if (profileResult.error === 'none') {
      if (profileName) {
        throw new CliError(
          'PROFILE_NOT_FOUND',
          `Profile "${profileName}" not found for confluence`,
          'Run: agentio confluence profile add'
        );
      }
      throw new CliError(
        'PROFILE_NOT_FOUND',
        'No confluence profile configured',
        'Run: agentio confluence profile add'
      );
    }
    throw multipleProfilesError('confluence', profileResult.names);
  }

  const profile = profileResult.profile;

  let credentials = await getCredentials<ConfluenceCredentials>('confluence', profile);

  if (!credentials) {
    throw new CliError(
      'AUTH_FAILED',
      `No credentials found for confluence profile "${profile}"`,
      `Run: agentio confluence profile add --profile ${profile}`
    );
  }

  credentials = await ensureValidToken(credentials, profile);

  return {
    client: new ConfluenceClient(credentials),
    profile,
  };
}

export function registerConfluenceCommands(program: Command): void {
  const confluence = program.command('confluence').description('Confluence operations');

  // List spaces
  confluence
    .command('spaces')
    .description('List Confluence spaces')
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
    .option('--limit <number>', 'Maximum number of spaces', '50')
    .option('--type <type>', 'Filter by type (global|personal|collaboration|knowledge_base)')
    .action(async (options) => {
      try {
        const { client } = await getConfluenceClient(options.profile);
        const spaces = await client.listSpaces({
          limit: parseInt(options.limit, 10),
          type: options.type,
        });
        printConfluenceSpaceList(spaces);
      } catch (error) {
        handleError(error);
      }
    });

  // List pages
  confluence
    .command('pages')
    .description('List Confluence pages')
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
    .option('--space <key>', 'Filter by space key')
    .option('--space-id <id>', 'Filter by space id')
    .option('--parent <id>', 'Filter by parent page id')
    .option('--limit <number>', 'Maximum number of pages', '25')
    .action(async (options) => {
      try {
        const { client } = await getConfluenceClient(options.profile);
        const pages = await client.listPages({
          spaceKey: options.space,
          spaceId: options.spaceId,
          parentId: options.parent,
          limit: parseInt(options.limit, 10),
        });
        printConfluencePageList(pages);
      } catch (error) {
        handleError(error);
      }
    });

  // Get page
  confluence
    .command('get')
    .description('Get a Confluence page (with body)')
    .argument('<page-id>', 'Page ID')
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
    .option('--format <format>', 'Body format (storage|atlas_doc_format|view)', 'storage')
    .action(async (pageId: string, options) => {
      try {
        const format = options.format as 'storage' | 'atlas_doc_format' | 'view';
        if (!['storage', 'atlas_doc_format', 'view'].includes(format)) {
          throw new CliError(
            'INVALID_PARAMS',
            `Invalid format "${options.format}". Use storage, atlas_doc_format, or view.`
          );
        }
        const { client } = await getConfluenceClient(options.profile);
        const page = await client.getPage(pageId, format);
        printConfluencePage(page);
      } catch (error) {
        handleError(error);
      }
    });

  // Search
  confluence
    .command('search')
    .description('Search Confluence content using CQL')
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
    .option('--cql <query>', 'Raw CQL query')
    .option('--space <key>', 'Filter by space key')
    .option('--type <type>', 'Filter by type (page|blogpost|comment|attachment)')
    .option('--text <text>', 'Free-text search')
    .option('--limit <number>', 'Maximum number of results', '25')
    .action(async (options) => {
      try {
        const { client } = await getConfluenceClient(options.profile);
        const results = await client.search({
          cql: options.cql,
          spaceKey: options.space,
          type: options.type,
          text: options.text,
          limit: parseInt(options.limit, 10),
        });
        printConfluenceSearchResults(results);
      } catch (error) {
        handleError(error);
      }
    });

  // Create page
  confluence
    .command('create')
    .description('Create a Confluence page')
    .requiredOption('--title <title>', 'Page title')
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
    .option('--space <key>', 'Space key (or use --space-id)')
    .option('--space-id <id>', 'Space id (or use --space)')
    .option('--parent <id>', 'Parent page id')
    .option('--content <text>', 'Page body (or pipe via stdin)')
    .action(async (options) => {
      try {
        if (!options.space && !options.spaceId) {
          throw new CliError('INVALID_PARAMS', '--space or --space-id is required');
        }

        let body = options.content as string | undefined;
        if (!body) {
          body = (await readStdin()) || undefined;
        }
        if (!body) {
          throw new CliError(
            'INVALID_PARAMS',
            'Page body is required. Use --content or pipe via stdin.'
          );
        }

        const { client, profile } = await getConfluenceClient(options.profile);
        await enforceWriteAccess('confluence', profile, 'create page');
        const result = await client.createPage({
          spaceKey: options.space,
          spaceId: options.spaceId,
          title: options.title,
          parentId: options.parent,
          body,
        });
        printConfluencePageCreated(result);
      } catch (error) {
        handleError(error);
      }
    });

  // Update page
  confluence
    .command('update')
    .description('Update a Confluence page (replaces body)')
    .argument('<page-id>', 'Page ID')
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
    .option('--title <title>', 'New page title (defaults to current title)')
    .option('--content <text>', 'Page body (or pipe via stdin)')
    .action(async (pageId: string, options) => {
      try {
        let body = options.content as string | undefined;
        if (!body) {
          body = (await readStdin()) || undefined;
        }
        if (!body) {
          throw new CliError(
            'INVALID_PARAMS',
            'Page body is required. Use --content or pipe via stdin.'
          );
        }

        const { client, profile } = await getConfluenceClient(options.profile);
        await enforceWriteAccess('confluence', profile, 'update page');
        const result = await client.updatePage({
          pageId,
          title: options.title,
          body,
        });
        printConfluencePageUpdated(result);
      } catch (error) {
        handleError(error);
      }
    });

  // List comments
  confluence
    .command('comments')
    .description('List footer comments on a page')
    .argument('<page-id>', 'Page ID')
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
    .action(async (pageId: string, options) => {
      try {
        const { client } = await getConfluenceClient(options.profile);
        const comments = await client.listComments(pageId);
        printConfluenceCommentList(comments);
      } catch (error) {
        handleError(error);
      }
    });

  // Add comment
  confluence
    .command('comment')
    .description('Add a footer comment to a page')
    .argument('<page-id>', 'Page ID')
    .argument('[body]', 'Comment body (or pipe via stdin)')
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
    .action(async (pageId: string, body: string | undefined, options) => {
      try {
        let text = body;
        if (!text) {
          text = (await readStdin()) || undefined;
        }
        if (!text) {
          throw new CliError(
            'INVALID_PARAMS',
            'Comment body is required. Provide as argument or pipe via stdin.'
          );
        }

        const { client, profile } = await getConfluenceClient(options.profile);
        await enforceWriteAccess('confluence', profile, 'add comment');
        const result = await client.addComment(pageId, text);
        printConfluenceCommentResult(result);
      } catch (error) {
        handleError(error);
      }
    });

  // Profile management
  const profile = createProfileCommands<ConfluenceCredentials>(confluence, {
    service: 'confluence',
    displayName: 'Confluence',
    getExtraInfo: (credentials) =>
      credentials?.siteUrl ? ` - ${credentials.siteUrl}` : '',
  });

  profile
    .command('add')
    .description('Add a new Confluence profile with OAuth authentication')
    .option('--profile <name>', 'Profile name (auto-detected from site URL if not provided)')
    .option('--read-only', 'Create as read-only profile (blocks write operations)')
    .action(async (options) => {
      try {
        await confluenceProfileAdd(options);
      } catch (error) {
        handleError(error);
      }
    });
}

export async function confluenceProfileAdd(options: {
  profile?: string;
  readOnly?: boolean;
}): Promise<void> {
  console.error('\nConfluence OAuth Setup\n');

  const selectSite = async (sites: AtlassianSite[]): Promise<AtlassianSite> => {
    return interactiveSelect({
      message: 'Select a Confluence site:',
      choices: sites.map((site) => ({
        name: site.name,
        value: site,
        description: site.url,
      })),
    });
  };

  const result = await performConfluenceOAuthFlow(selectSite);

  console.error(`\nAuthorized for site: ${result.siteUrl}\n`);

  const siteHostname = new URL(result.siteUrl).hostname;
  const profileName = options.profile || siteHostname;

  const credentials: ConfluenceCredentials = {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiryDate: result.expiryDate,
    cloudId: result.cloudId,
    siteUrl: result.siteUrl,
  };

  await setProfile('confluence', profileName, { readOnly: options.readOnly });
  await setCredentials('confluence', profileName, credentials);

  console.log(`\nProfile "${profileName}" configured!`);
  if (options.readOnly) {
    console.log(`   Access: read-only`);
  }
  console.log(`   Test with: agentio confluence spaces --profile ${profileName}`);
}
