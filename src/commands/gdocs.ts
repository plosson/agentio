import { Command } from 'commander';
import { writeFile } from 'fs/promises';
import { google } from 'googleapis';
import { createGoogleAuth } from '../auth/token-manager';
import { setCredentials } from '../auth/token-store';
import { setProfile } from '../config/config-manager';
import { createProfileCommands } from '../utils/profile-commands';
import { createClientGetter } from '../utils/client-factory';
import { performOAuthFlow } from '../auth/oauth';
import { GDocsClient } from '../services/gdocs/client';
import { printGDocsList, printGDocCreated, raw } from '../utils/output';
import { CliError, handleError } from '../utils/errors';
import { readStdin } from '../utils/stdin';
import type { GDocsCredentials } from '../types/gdocs';

const getGDocsClient = createClientGetter<GDocsCredentials, GDocsClient>({
  service: 'gdocs',
  createClient: (credentials) => new GDocsClient(credentials),
});

export function registerGDocsCommands(program: Command): void {
  const gdocs = program
    .command('gdocs')
    .description('Google Docs operations');

  gdocs
    .command('get')
    .argument('<doc-id-or-url>', 'Document ID or URL')
    .description('Export a document')
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
    .option('--format <format>', 'Export format: markdown or docx', 'markdown')
    .option('--output <file>', 'Output file path (required for docx, optional for markdown)')
    .action(async (docIdOrUrl: string, options) => {
      try {
        const { client } = await getGDocsClient(options.profile);
        const format = options.format.toLowerCase();

        if (format !== 'markdown' && format !== 'docx') {
          throw new CliError('INVALID_PARAMS', `Unknown format: ${format}`, 'Use --format markdown or --format docx');
        }

        if (format === 'docx' && !options.output) {
          throw new CliError('INVALID_PARAMS', 'Output file required for docx format', 'Use --output <file.docx>');
        }

        const content = format === 'docx'
          ? await client.getAsDocx(docIdOrUrl)
          : await client.getAsMarkdown(docIdOrUrl);

        if (options.output) {
          await writeFile(options.output, content);
          console.log(`Exported to ${options.output}`);
        } else {
          raw(content as string);
        }
      } catch (error) {
        handleError(error);
      }
    });

  gdocs
    .command('create')
    .description('Create a new document from Markdown')
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
    .requiredOption('--title <title>', 'Document title')
    .option('--content <text>', 'Markdown content (or pipe via stdin)')
    .option('--folder <folder-id>', 'Folder ID to create the document in')
    .action(async (options) => {
      try {
        let content = options.content;

        if (!content) {
          content = await readStdin();
        }

        if (!content) {
          throw new CliError('INVALID_PARAMS', 'No content provided', 'Provide --content or pipe markdown via stdin');
        }

        const { client } = await getGDocsClient(options.profile);
        const result = await client.create(options.title, content, options.folder);

        printGDocCreated(result);
      } catch (error) {
        handleError(error);
      }
    });

  gdocs
    .command('list')
    .description('List recent documents')
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
    .option('--limit <n>', 'Number of documents', '10')
    .option('--query <query>', 'Drive search query filter')
    .addHelpText('after', `
Query Syntax Examples:

  Name search:
    --query "name contains 'project'"     Documents with "project" in name
    --query "name = 'Meeting Notes'"      Exact name match

  Ownership:
    --query "'me' in owners"              Documents you own
    --query "'user@example.com' in owners"  Documents owned by specific user

  Date filters:
    --query "modifiedTime > '2024-01-01'"   Modified after date
    --query "createdTime > '2024-01-01'"    Created after date

  Starred/Trashed:
    --query "starred = true"              Starred documents
    --query "trashed = false"             Not in trash (default)

  Combined:
    --query "name contains 'report' and modifiedTime > '2024-01-01'"
`)
    .action(async (options) => {
      try {
        const { client } = await getGDocsClient(options.profile);
        const docs = await client.list({
          limit: parseInt(options.limit, 10),
          query: options.query,
        });
        printGDocsList(docs);
      } catch (error) {
        handleError(error);
      }
    });

  // Profile management
  const profile = createProfileCommands<GDocsCredentials>(gdocs, {
    service: 'gdocs',
    displayName: 'Google Docs',
    getExtraInfo: (credentials) => credentials?.email ? ` - ${credentials.email}` : '',
  });

  profile
    .command('add')
    .description('Add a new Google Docs profile')
    .option('--profile <name>', 'Profile name (auto-detected from email if not provided)')
    .action(async (options) => {
      try {
        console.error('Starting OAuth flow for Google Docs...\n');

        const tokens = await performOAuthFlow('gdocs');
        const auth = createGoogleAuth(tokens);

        // Fetch user email for profile naming
        let userEmail: string;
        try {
          const oauth2 = google.oauth2({ version: 'v2', auth });
          const userInfo = await oauth2.userinfo.get();
          userEmail = userInfo.data.email || '';
          if (!userEmail) {
            throw new Error('No email returned');
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          throw new CliError(
            'AUTH_FAILED',
            `Failed to fetch user email: ${errorMessage}`,
            'Ensure the account has an email address'
          );
        }

        const profileName = options.profile || userEmail;

        const credentials: GDocsCredentials = {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiryDate: tokens.expiry_date,
          tokenType: tokens.token_type,
          scope: tokens.scope,
          email: userEmail,
        };

        await setProfile('gdocs', profileName);
        await setCredentials('gdocs', profileName, credentials);

        console.log(`\nSuccess! Profile "${profileName}" configured.`);
        console.log(`   Email: ${userEmail}`);
        console.log(`   Test with: agentio gdocs list --profile ${profileName}`);
      } catch (error) {
        handleError(error);
      }
    });
}
