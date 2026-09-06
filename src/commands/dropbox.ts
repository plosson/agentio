import { Command } from 'commander';
import { setCredentials, getCredentials } from '../auth/token-store';
import { setProfile, resolveProfile } from '../config/config-manager';
import { createProfileCommands } from '../utils/profile-commands';
import {
  buildAuthorizeUrl,
  createPkcePair,
  exchangeCodeForTokens,
  refreshDropboxToken,
} from '../auth/dropbox-oauth';
import { launchBrowser } from '../auth/oauth-server';
import { DropboxClient } from '../services/dropbox/client';
import { CliError, handleError, multipleProfilesError } from '../utils/errors';
import { prompt, confirm } from '../utils/stdin';
import { enforceWriteAccess } from '../utils/read-only';
import { addExamples } from '../utils/command-tree';
import {
  printDropboxAccount,
  printDropboxDownloaded,
  printDropboxEntry,
  printDropboxEntryList,
  printDropboxLink,
  printDropboxUploaded,
} from '../utils/output';
import type { DropboxCredentials } from '../types/dropbox';

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/**
 * Dropbox access tokens live 4 hours and the refresh token is not rotated,
 * so only the access token is ever replaced.
 */
async function ensureValidToken(
  credentials: DropboxCredentials,
  profile: string,
): Promise<DropboxCredentials> {
  if (credentials.expiryDate && Date.now() + TOKEN_EXPIRY_BUFFER_MS < credentials.expiryDate) {
    return credentials;
  }

  try {
    const refreshed = await refreshDropboxToken(credentials.appKey, credentials.refreshToken);
    const newCredentials: DropboxCredentials = {
      ...credentials,
      accessToken: refreshed.accessToken,
      expiryDate: Date.now() + refreshed.expiresIn * 1000,
    };
    await setCredentials('dropbox', profile, newCredentials);
    return newCredentials;
  } catch (error) {
    const detail = error instanceof CliError ? ` (${error.message})` : '';
    throw new CliError(
      'AUTH_FAILED',
      `Failed to refresh the Dropbox access token${detail}`,
      `Run: agentio dropbox profile add --profile ${profile}`,
    );
  }
}

async function getDropboxClient(profileName?: string): Promise<{ client: DropboxClient; profile: string }> {
  const profileResult = await resolveProfile('dropbox', profileName);

  if (profileResult.profile === null) {
    if (profileResult.error === 'none') {
      if (profileName) {
        throw new CliError('PROFILE_NOT_FOUND', `Profile "${profileName}" not found for dropbox`, 'Run: agentio dropbox profile add');
      }
      throw new CliError('PROFILE_NOT_FOUND', 'No dropbox profile configured', 'Run: agentio dropbox profile add');
    }
    throw multipleProfilesError('dropbox', profileResult.names);
  }

  const profile = profileResult.profile;
  const stored = await getCredentials<DropboxCredentials>('dropbox', profile);

  if (!stored) {
    throw new CliError(
      'AUTH_FAILED',
      `No credentials found for dropbox profile "${profile}"`,
      `Run: agentio dropbox profile add --profile ${profile}`,
    );
  }

  const credentials = await ensureValidToken(stored, profile);
  return { client: new DropboxClient(credentials), profile };
}

function parseLimit(value: string): number {
  const limit = parseInt(value, 10);
  if (isNaN(limit) || limit < 1) {
    throw new CliError('INVALID_PARAMS', '--limit must be a positive number');
  }
  return limit;
}

export function registerDropboxCommands(program: Command): void {
  const dropbox = program.command('dropbox').description('Dropbox operations');

  addExamples(
    dropbox
      .command('list')
      .argument('[path]', 'Folder path (default: account root)')
      .description('List a folder')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .option('--limit <n>', 'Maximum entries to return', '100')
      .option('--recursive', 'Include everything below the folder')
      .option('--folders', 'Only show folders')
      .action(async (path: string | undefined, options) => {
        try {
          const { client } = await getDropboxClient(options.profile);
          const entries = await client.list({
            path,
            limit: parseLimit(options.limit),
            recursive: options.recursive,
            foldersOnly: options.folders,
          });
          printDropboxEntryList(entries, path ? `Entries in ${path}` : 'Entries');
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # everything at the top level of the account
  agentio dropbox list

  # one folder
  agentio dropbox list /Documents

  # the whole tree below a folder
  agentio dropbox list /Documents --recursive --limit 500

  # only the subfolders
  agentio dropbox list /Documents --folders

Paths are absolute and start at the Dropbox root, e.g. "/Documents/report.pdf".
Casing is preserved but matching is case-insensitive.`,
  );

  addExamples(
    dropbox
      .command('get')
      .argument('<path>', 'File or folder path')
      .description('Get metadata for a file or folder')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .action(async (path: string, options) => {
        try {
          const { client } = await getDropboxClient(options.profile);
          printDropboxEntry(await client.get(path));
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # size, revision and modification time of a file
  agentio dropbox get /Documents/report.pdf

  # confirm a folder exists
  agentio dropbox get /Documents`,
  );

  addExamples(
    dropbox
      .command('search')
      .description('Search for files and folders')
      .requiredOption('--query <text>', 'Search text')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .option('--path <path>', 'Restrict the search to a folder')
      .option('--limit <n>', 'Maximum results to return', '20')
      .option('--filename-only', 'Match names only, not file contents')
      .action(async (options) => {
        try {
          const { client } = await getDropboxClient(options.profile);
          const entries = await client.search({
            query: options.query,
            path: options.path,
            limit: parseLimit(options.limit),
            filenameOnly: options.filenameOnly,
          });
          printDropboxEntryList(entries, 'Search Results');
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # search names and contents across the account
  agentio dropbox search --query "quarterly report"

  # search inside one folder
  agentio dropbox search --query invoice --path /Accounting

  # match file names only
  agentio dropbox search --query 2026 --filename-only --limit 50

Newly uploaded files can take a few minutes to become searchable.`,
  );

  addExamples(
    dropbox
      .command('download')
      .argument('<path>', 'File or folder path')
      .description('Download a file, or a folder as a zip archive')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .option('--output <path>', 'Local output path (default: the remote name)')
      .action(async (path: string, options) => {
        try {
          const { client } = await getDropboxClient(options.profile);
          printDropboxDownloaded(await client.download(path, options.output));
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # download a file next to the current directory
  agentio dropbox download /Documents/report.pdf

  # download to a chosen path
  agentio dropbox download /Documents/report.pdf --output ~/Desktop/report.pdf

  # download a whole folder (arrives as Documents.zip)
  agentio dropbox download /Documents

  # download a folder to a named archive
  agentio dropbox download /Photos/2026 --output ./photos-2026.zip

Folder downloads are capped by Dropbox at 20 GB and 10,000 files.`,
  );

  addExamples(
    dropbox
      .command('put')
      .argument('<file-path>', 'Local file path')
      .description('Upload a file')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .option('--path <path>', 'Destination path or folder (default: account root)')
      .option('--overwrite', 'Replace an existing file at the destination')
      .action(async (filePath: string, options) => {
        try {
          const { client, profile } = await getDropboxClient(options.profile);
          await enforceWriteAccess('dropbox', profile, 'upload a file');
          const result = await client.upload({
            filePath,
            destination: options.path,
            overwrite: options.overwrite,
          });
          printDropboxUploaded(result);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # upload to the account root, keeping the local name
  agentio dropbox put ./report.pdf

  # upload into a folder (trailing slash keeps the local name)
  agentio dropbox put ./report.pdf --path /Documents/

  # upload under a different name
  agentio dropbox put ./out.csv --path /Reports/2026-results.csv

  # update a file that already exists
  agentio dropbox put ./report.pdf --path /Documents/report.pdf --overwrite

Without --overwrite an existing destination is an error, never a silent replace.
Files above 150 MB are uploaded in 8 MB chunks automatically.`,
  );

  addExamples(
    dropbox
      .command('mkdir')
      .argument('<path>', 'Folder path to create')
      .description('Create a folder')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .action(async (path: string, options) => {
        try {
          const { client, profile } = await getDropboxClient(options.profile);
          await enforceWriteAccess('dropbox', profile, 'create a folder');
          const entry = await client.mkdir(path);
          console.log(`Created folder: ${entry.path}`);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # create a folder at the root
  agentio dropbox mkdir /Reports

  # create a nested folder (parents are created as needed)
  agentio dropbox mkdir /Reports/2026/Q1`,
  );

  addExamples(
    dropbox
      .command('move')
      .argument('<from>', 'Source path')
      .argument('<to>', 'Destination path')
      .description('Move or rename a file or folder')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .action(async (from: string, to: string, options) => {
        try {
          const { client, profile } = await getDropboxClient(options.profile);
          await enforceWriteAccess('dropbox', profile, 'move a file');
          const entry = await client.move(from, to);
          console.log(`Moved to: ${entry.path}`);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # rename a file in place
  agentio dropbox move /Documents/draft.pdf /Documents/final.pdf

  # move a file to another folder
  agentio dropbox move /Inbox/scan.pdf /Documents/scan.pdf

  # move a whole folder
  agentio dropbox move /Inbox/2025 /Archive/2025`,
  );

  addExamples(
    dropbox
      .command('copy')
      .argument('<from>', 'Source path')
      .argument('<to>', 'Destination path')
      .description('Copy a file or folder')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .action(async (from: string, to: string, options) => {
        try {
          const { client, profile } = await getDropboxClient(options.profile);
          await enforceWriteAccess('dropbox', profile, 'copy a file');
          const entry = await client.copy(from, to);
          console.log(`Copied to: ${entry.path}`);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # copy a file
  agentio dropbox copy /Documents/report.pdf /Archive/report-2026.pdf

  # copy a folder and everything in it
  agentio dropbox copy /Templates /Projects/new-client`,
  );

  addExamples(
    dropbox
      .command('delete')
      .argument('<path>', 'File or folder path')
      .description('Delete a file or folder (recoverable from the Dropbox trash)')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .option('--force', 'Skip the confirmation prompt')
      .action(async (path: string, options) => {
        try {
          const { client, profile } = await getDropboxClient(options.profile);
          await enforceWriteAccess('dropbox', profile, 'delete a file');

          if (!options.force) {
            const entry = await client.get(path);
            const what = entry.type === 'folder' ? 'folder (and everything in it)' : 'file';
            const confirmed = await confirm(`Delete ${what} "${entry.path}"?`);
            if (!confirmed) {
              console.error('Cancelled');
              return;
            }
          }

          const deleted = await client.delete(path);
          console.log(`Deleted: ${deleted.path}`);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # delete a file with a confirmation prompt
  agentio dropbox delete /Documents/old.pdf

  # delete without prompting
  agentio dropbox delete /Documents/old.pdf --force

  # delete a folder and all of its contents
  agentio dropbox delete /Archive/2019 --force

Deleted items go to the Dropbox trash and stay recoverable for 30 days
(180 days on business plans).`,
  );

  addExamples(
    dropbox
      .command('link')
      .argument('<path>', 'File or folder path')
      .description('Get a shareable link')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .option('--temporary', 'Direct download URL that expires in 4 hours (files only)')
      .action(async (path: string, options) => {
        try {
          const { client, profile } = await getDropboxClient(options.profile);
          if (!options.temporary) {
            await enforceWriteAccess('dropbox', profile, 'create a shared link');
          }
          const link = options.temporary
            ? await client.temporaryLink(path)
            : await client.sharedLink(path);
          printDropboxLink(link);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # permanent share link (reuses the existing one if there is one)
  agentio dropbox link /Documents/report.pdf

  # share a folder
  agentio dropbox link /Photos/2026

  # direct download URL for a script to fetch, valid 4 hours
  agentio dropbox link /Documents/report.pdf --temporary`,
  );

  addExamples(
    dropbox
      .command('account')
      .description('Show the connected Dropbox account')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .action(async (options) => {
        try {
          const { client } = await getDropboxClient(options.profile);
          printDropboxAccount(await client.account());
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # which account this profile is connected to
  agentio dropbox account`,
  );

  const profile = createProfileCommands<DropboxCredentials>(dropbox, {
    service: 'dropbox',
    displayName: 'Dropbox',
    getExtraInfo: (credentials) => (credentials?.email ? ` - ${credentials.email}` : ''),
  });

  profile
    .command('add')
    .description('Add a new Dropbox profile')
    .option('--profile <name>', 'Profile name (defaults to the account email)')
    .option('--app-key <key>', 'App key from the Dropbox App Console')
    .option('--read-only', 'Create as read-only profile (blocks write operations)')
    .action(async (options) => {
      try {
        await dropboxProfileAdd(options);
      } catch (error) {
        handleError(error);
      }
    });
}

export interface DropboxProfileAddOptions {
  profile?: string;
  appKey?: string;
  readOnly?: boolean;
}

export async function dropboxProfileAdd(options: DropboxProfileAddOptions): Promise<void> {
  console.error('\nDropbox Setup\n');
  console.error('Prerequisite: create an app at https://www.dropbox.com/developers/apps');
  console.error('  1. Choose "Scoped access" and "Full Dropbox"');
  console.error('  2. On the Permissions tab enable: account_info.read, files.metadata.read,');
  console.error('     files.content.read, files.content.write, sharing.read, sharing.write');
  console.error('  3. Copy the App key from the Settings tab\n');
  console.error('No redirect URI is needed - Dropbox shows the code in the browser.\n');

  const appKey = (options.appKey || (await prompt('? App key: '))).trim();
  if (!appKey) {
    throw new CliError('INVALID_PARAMS', 'App key is required');
  }

  const { verifier, challenge } = createPkcePair();
  const authUrl = buildAuthorizeUrl(appKey, challenge);

  console.error('\nAuthorise the app in your browser:');
  console.error(`  ${authUrl}\n`);
  console.error('After approving, Dropbox displays an authorisation code to copy.\n');
  launchBrowser(authUrl);

  const code = (await prompt('? Paste the authorisation code: ')).trim();
  if (!code) {
    throw new CliError('INVALID_PARAMS', 'Authorisation code is required');
  }

  console.error('\nExchanging the authorisation code...');
  const tokens = await exchangeCodeForTokens(code, appKey, verifier);

  const credentials: DropboxCredentials = {
    appKey,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiryDate: Date.now() + tokens.expiresIn * 1000,
    accountId: tokens.accountId,
  };

  console.error('Validating access...');
  const client = new DropboxClient(credentials);
  const account = await client.account();

  credentials.email = account.email;
  credentials.name = account.name;
  credentials.accountId = account.accountId;

  const profileName = options.profile || account.email;

  await setProfile('dropbox', profileName, { readOnly: options.readOnly });
  await setCredentials('dropbox', profileName, credentials);

  console.log(`\nProfile "${profileName}" configured!`);
  console.log(`   Account: ${account.name} <${account.email}>`);
  if (options.readOnly) {
    console.log(`   Access: read-only`);
  }
  console.log(`   Test with: agentio dropbox list --profile ${profileName}`);
}
