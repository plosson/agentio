import { Command } from 'commander';
import { createGoogleAuth, fetchGoogleUserEmail } from '../auth/token-manager';
import { setCredentials } from '../auth/token-store';
import { setProfile, getProfile } from '../config/config-manager';
import { createProfileCommands } from '../utils/profile-commands';
import { createClientGetter } from '../utils/client-factory';
import { performOAuthFlow } from '../auth/oauth';
import { GDriveClient } from '../services/gdrive/client';
import { printGDriveFileList, printGDriveFile, printGDriveDownloaded, printGDriveUploaded } from '../utils/output';
import { CliError, handleError } from '../utils/errors';
import { prompt } from '../utils/stdin';
import { enforceWriteAccess } from '../utils/read-only';
import { addExamples } from '../utils/command-tree';
import type { GDriveCredentials, GDriveAccessLevel } from '../types/gdrive';

const getGDriveClient = createClientGetter<GDriveCredentials, GDriveClient>({
  service: 'gdrive',
  createClient: (credentials) => new GDriveClient(credentials),
});

export function registerGDriveCommands(program: Command): void {
  const gdrive = program
    .command('gdrive')
    .description('Google Drive operations');

  addExamples(
    gdrive
      .command('list')
      .description('List files')
      .option('--profile <name>', 'Profile name')
      .option('--limit <n>', 'Number of files', '20')
      .option('--folder <id>', 'Folder ID to list (use "root" for root folder)')
      .option('--query <query>', 'Drive API query filter')
      .option('--order <field>', 'Order by field', 'modifiedTime desc')
      .option('--trash', 'Include trashed files')
      .action(async (options) => {
        try {
          const { client } = await getGDriveClient(options.profile);
          const files = await client.list({
            limit: parseInt(options.limit, 10),
            folderId: options.folder,
            query: options.query,
            orderBy: options.order,
            includeTrash: options.trash,
          });
          printGDriveFileList(files);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # 20 most recently modified files
  agentio gdrive list

  # files inside a specific folder
  agentio gdrive list --folder 1A2bCdEfGhIjKlMnOpQrStUvWxYz

  # only PDFs
  agentio gdrive list --query "mimeType = 'application/pdf'"

  # files you own, sorted by name
  agentio gdrive list --query "'me' in owners" --order "name"

Query syntax: name contains '...', mimeType = '...', 'me' in owners,
modifiedTime > 'YYYY-MM-DD', starred = true, shared = true.
Combine with 'and'/'or'.`,
  );

  addExamples(
    gdrive
      .command('folders')
      .description('List folders')
      .option('--profile <name>', 'Profile name')
      .option('--limit <n>', 'Number of folders', '20')
      .option('--parent <id>', 'Parent folder ID (use "root" for root folder)')
      .option('--query <query>', 'Additional query filter')
      .action(async (options) => {
        try {
          const { client } = await getGDriveClient(options.profile);
          const folders = await client.listFolders({
            limit: parseInt(options.limit, 10),
            parentId: options.parent,
            query: options.query,
          });
          printGDriveFileList(folders, 'Folders');
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # 20 most recent folders
  agentio gdrive folders

  # folders directly under My Drive root
  agentio gdrive folders --parent root

  # subfolders of a specific folder
  agentio gdrive folders --parent 1A2bCdEfGhIjKlMnOpQrStUvWxYz

  # filter by name
  agentio gdrive folders --query "name contains 'archive'"`,
  );

  addExamples(
    gdrive
      .command('get')
      .argument('<file-id-or-url>', 'File ID or URL')
      .description('Get file metadata')
      .option('--profile <name>', 'Profile name')
      .action(async (fileIdOrUrl: string, options) => {
        try {
          const { client } = await getGDriveClient(options.profile);
          const file = await client.get(fileIdOrUrl);
          printGDriveFile(file);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # metadata by file ID
  agentio gdrive get 1A2bCdEfGhIjKlMnOpQrStUvWxYz0123456789

  # metadata from a full Drive URL
  agentio gdrive get https://drive.google.com/file/d/1A2bCdEf.../view`,
  );

  addExamples(
    gdrive
      .command('search')
      .description('Search for files')
      .requiredOption('--query <text>', 'Search text (searches name and content)')
      .option('--profile <name>', 'Profile name')
      .option('--limit <n>', 'Number of results', '20')
      .option('--type <mime>', 'Filter by MIME type')
      .option('--folder <id>', 'Search within folder')
      .action(async (options) => {
        try {
          const { client } = await getGDriveClient(options.profile);
          const files = await client.search({
            query: options.query,
            mimeType: options.type,
            limit: parseInt(options.limit, 10),
            folderId: options.folder,
          });
          printGDriveFileList(files, 'Search Results');
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # full-text search across name and content
  agentio gdrive search --query "quarterly report"

  # only PDFs containing the phrase
  agentio gdrive search --query "invoice" --type application/pdf

  # restrict to a folder, return more results
  agentio gdrive search --query "design" --folder 1A2bCdEf... --limit 50`,
  );

  addExamples(
    gdrive
      .command('download')
      .argument('<file-id-or-url>', 'File ID or URL')
      .description('Download a file (or export Google Workspace files)')
      .option('--profile <name>', 'Profile name')
      .requiredOption('--output <path>', 'Output file path')
      .option('--export <format>', 'Export format for Google Workspace files (pdf, docx, xlsx, csv, pptx, txt, etc.)')
      .action(async (fileIdOrUrl: string, options) => {
        try {
          const { client } = await getGDriveClient(options.profile);
          const result = await client.download({
            fileIdOrUrl,
            outputPath: options.output,
            exportFormat: options.export,
          });
          printGDriveDownloaded(result);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # download a binary file as-is
  agentio gdrive download 1A2bCdEf... --output ./photo.jpg

  # export a Google Doc as PDF
  agentio gdrive download 1A2bCdEf... --output report.pdf --export pdf

  # export a Google Sheet as CSV
  agentio gdrive download 1A2bCdEf... --output data.csv --export csv

  # export Google Slides as PowerPoint
  agentio gdrive download 1A2bCdEf... --output deck.pptx --export pptx

Export formats: Docs -> pdf|docx|odt|txt|html|rtf, Sheets -> xlsx|csv|pdf|ods|tsv,
Slides -> pptx|pdf|odp|txt, Drawing -> pdf|png|jpeg|svg.`,
  );

  addExamples(
    gdrive
      .command('put')
      .argument('<file-path>', 'Local file path')
      .description('Upload a file to Google Drive')
      .option('--profile <name>', 'Profile name')
      .option('--name <name>', 'Name for the file in Drive (defaults to local filename)')
      .option('--folder <id>', 'Folder ID to upload to')
      .option('--type <mime>', 'MIME type (auto-detected if not specified)')
      .option('--convert', 'Convert to Google Workspace format (Doc, Sheet, or Slides)')
      .action(async (filePath: string, options) => {
        try {
          const { client, profile } = await getGDriveClient(options.profile);
          await enforceWriteAccess('gdrive', profile, 'upload file');
          const result = await client.upload({
            filePath,
            name: options.name,
            folderId: options.folder,
            mimeType: options.type,
            convert: options.convert,
          });
          printGDriveUploaded(result);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # upload a file to My Drive root
  agentio gdrive put ./report.pdf

  # upload into a specific folder with a custom name
  agentio gdrive put ./out.csv --folder 1A2bCdEf... --name "results.csv"

  # upload and convert .docx to a native Google Doc
  agentio gdrive put report.docx --convert

  # upload and convert .xlsx to a native Google Sheet
  agentio gdrive put data.xlsx --convert

Conversion: docx/doc/odt/txt/html/rtf -> Google Doc,
xlsx/xls/ods/csv/tsv -> Google Sheet, pptx/ppt/odp -> Google Slides.`,
  );

  // Profile management
  const profile = createProfileCommands<GDriveCredentials>(gdrive, {
    service: 'gdrive',
    displayName: 'Google Drive',
    getExtraInfo: (credentials) => {
      if (!credentials) return '';
      const access = credentials.accessLevel === 'full' ? 'full' : 'read-only';
      return ` - ${credentials.email} (${access})`;
    },
  });

  profile
    .command('add')
    .description('Add a new Google Drive profile')
    .option('--profile <name>', 'Profile name (auto-detected from email if not provided)')
    .option('--readonly', 'Create a read-only profile (skip access level prompt)')
    .option('--full', 'Create a full access profile (skip access level prompt)')
    .option('--read-only', 'Create as read-only profile (blocks write operations)')
    .action(async (options) => {
      try {
        await gdriveProfileAdd(options);
      } catch (error) {
        handleError(error);
      }
    });
}

export async function gdriveProfileAdd(options: { profile?: string; readonly?: boolean; full?: boolean; readOnly?: boolean }): Promise<void> {
  console.error('Google Drive Setup\n');

  let accessLevel: GDriveAccessLevel;

  if (options.readonly || options.readOnly) {
    accessLevel = 'readonly';
  } else if (options.full) {
    accessLevel = 'full';
  } else {
    console.error('Access level options:');
    console.error('  1. Read-only  - List, search, download files');
    console.error('  2. Full       - Read-only + upload, create folders, modify files\n');

    const choice = await prompt('? Select access level (1 or 2): ');
    accessLevel = choice.trim() === '2' ? 'full' : 'readonly';
  }

  const oauthService = accessLevel === 'full' ? 'gdrive-full' : 'gdrive-readonly';
  console.error(`\nStarting OAuth flow (${accessLevel} access)...\n`);

  const tokens = await performOAuthFlow(oauthService);

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
  } else if (options.readOnly && await getProfile('gdrive', userEmail)) {
    // Profile with email already exists, use -readonly suffix
    profileName = `${userEmail}-readonly`;
  } else {
    profileName = userEmail;
  }

  const credentials: GDriveCredentials = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiryDate: tokens.expiry_date,
    tokenType: tokens.token_type,
    scope: tokens.scope,
    email: userEmail,
    accessLevel,
  };

  await setProfile('gdrive', profileName, { readOnly: options.readOnly });
  await setCredentials('gdrive', profileName, credentials);

  console.log(`\nSuccess! Profile "${profileName}" configured.`);
  console.log(`   Email: ${userEmail}`);
  console.log(`   API Access: ${accessLevel === 'full' ? 'Full (read & write)' : 'Read-only'}`);
  if (options.readOnly) {
    console.log(`   Profile Access: read-only`);
  }
  console.log(`   Test with: agentio gdrive list --profile ${profileName}`);
}
