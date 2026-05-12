import { Command } from 'commander';
import { writeFile, readFile } from 'fs/promises';
import { createGoogleAuth, fetchGoogleUserEmail } from '../auth/token-manager';
import { setCredentials } from '../auth/token-store';
import { setProfile, getProfile } from '../config/config-manager';
import { createProfileCommands } from '../utils/profile-commands';
import { createClientGetter } from '../utils/client-factory';
import { performOAuthFlow } from '../auth/oauth';
import { GDocsClient } from '../services/gdocs/client';
import { printGDocsList, printGDocCreated, printGDocsBatchResult, raw } from '../utils/output';
import { CliError, handleError } from '../utils/errors';
import { readStdin } from '../utils/stdin';
import { enforceWriteAccess } from '../utils/read-only';
import { addExamples } from '../utils/command-tree';
import type { GDocsCredentials } from '../types/gdocs';

const getGDocsClient = createClientGetter<GDocsCredentials, GDocsClient>({
  service: 'gdocs',
  createClient: (credentials) => new GDocsClient(credentials),
});

export function registerGDocsCommands(program: Command): void {
  const gdocs = program
    .command('gdocs')
    .description('Google Docs operations');

  addExamples(
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
      }),
    `Examples:

  # print a document as markdown to stdout
  agentio gdocs get 1A2bCdEfGhIjKlMnOpQrStUvWxYz0123456789

  # accept a full Google Docs URL
  agentio gdocs get https://docs.google.com/document/d/1A2bCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit

  # save markdown to a file
  agentio gdocs get 1A2bCdEf... --output report.md

  # export to .docx (requires --output)
  agentio gdocs get 1A2bCdEf... --format docx --output report.docx`,
  );

  addExamples(
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

          const { client, profile } = await getGDocsClient(options.profile);
          await enforceWriteAccess('gdocs', profile, 'create document');
          const result = await client.create(options.title, content, options.folder);

          printGDocCreated(result);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # create a doc with inline markdown content
  agentio gdocs create --title "Meeting Notes" --content "# Agenda\\n- Topic 1\\n- Topic 2"

  # create a doc with body piped from a file
  cat draft.md | agentio gdocs create --title "Q4 Plan"

  # create inside a specific Drive folder
  agentio gdocs create --title "Spec" --content "# Spec" --folder 1A2bCdEfGhIjKlMnOpQrStUvWxYz`,
  );

  addExamples(
    gdocs
      .command('list')
      .description('List recent documents')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .option('--limit <n>', 'Number of documents', '10')
      .option('--query <query>', 'Drive search query filter')
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
      }),
    `Examples:

  # 10 most recently modified docs
  agentio gdocs list

  # docs you own, more results
  agentio gdocs list --limit 50 --query "'me' in owners"

  # search by name fragment
  agentio gdocs list --query "name contains 'report'"

  # recently modified docs since a date
  agentio gdocs list --query "modifiedTime > '2024-01-01'"

Query syntax: name contains '...', name = '...', 'me' in owners,
modifiedTime > 'YYYY-MM-DD', starred = true, trashed = false.
Combine with 'and'/'or'.`,
  );

  const batchCmd = gdocs
    .command('batch')
    .argument('<doc-id-or-url>', 'Document ID or URL')
    .description('Execute raw documents.batchUpdate requests (escape hatch)')
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
    .option('--requests-json <json>', 'Inline JSON array of batchUpdate requests')
    .option('--file <path>', 'Path to a JSON file containing the requests array')
    .action(async (docIdOrUrl: string, options) => {
      try {
        if (!options.requestsJson && !options.file) {
          throw new CliError('INVALID_PARAMS', 'Provide --requests-json or --file');
        }
        if (options.requestsJson && options.file) {
          throw new CliError('INVALID_PARAMS', '--requests-json and --file are mutually exclusive');
        }

        const source = options.requestsJson ?? (await readFile(options.file, 'utf8'));
        let parsed: unknown;
        try {
          parsed = JSON.parse(source);
        } catch (err) {
          throw new CliError('INVALID_PARAMS', `Invalid JSON: ${err instanceof Error ? err.message : err}`);
        }
        if (!Array.isArray(parsed)) {
          throw new CliError('INVALID_PARAMS', 'Input must be a JSON array of Request objects');
        }

        const { client, profile } = await getGDocsClient(options.profile);
        await enforceWriteAccess('gdocs', profile, 'execute batch update');
        const result = await client.batch(docIdOrUrl, parsed as Parameters<typeof client.batch>[1]);
        printGDocsBatchResult(result);
      } catch (error) {
        handleError(error);
      }
    });

  addExamples(
    batchCmd,
    `Examples:

  # apply bold to a range of text (start/end offsets from the document body)
  agentio gdocs batch 1A2bCdEf... --requests-json '[{"updateTextStyle":{"range":{"startIndex":1,"endIndex":10},"textStyle":{"bold":true},"fields":"bold"}}]'

  # load requests from a file
  agentio gdocs batch 1A2bCdEf... --file ./requests.json

Accepts an array of Docs API Request objects. See:
https://developers.google.com/docs/api/reference/rest/v1/documents/request`,
  );

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
    .option('--read-only', 'Create as read-only profile (blocks write operations)')
    .action(async (options) => {
      try {
        await gdocsProfileAdd(options);
      } catch (error) {
        handleError(error);
      }
    });
}

export async function gdocsProfileAdd(options: { profile?: string; readOnly?: boolean }): Promise<void> {
  console.error('Starting OAuth flow for Google Docs...\n');

  const tokens = await performOAuthFlow('gdocs');

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

  // Determine profile name: use explicit --profile, or email, or email-readonly if conflict
  let profileName: string;
  if (options.profile) {
    profileName = options.profile;
  } else if (options.readOnly && await getProfile('gdocs', userEmail)) {
    // Profile with email already exists, use -readonly suffix
    profileName = `${userEmail}-readonly`;
  } else {
    profileName = userEmail;
  }

  const credentials: GDocsCredentials = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiryDate: tokens.expiry_date,
    tokenType: tokens.token_type,
    scope: tokens.scope,
    email: userEmail,
  };

  await setProfile('gdocs', profileName, { readOnly: options.readOnly });
  await setCredentials('gdocs', profileName, credentials);

  console.log(`\nSuccess! Profile "${profileName}" configured.`);
  console.log(`   Email: ${userEmail}`);
  if (options.readOnly) {
    console.log(`   Access: read-only`);
  }
  console.log(`   Test with: agentio gdocs list --profile ${profileName}`);
}
