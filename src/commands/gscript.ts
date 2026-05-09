import { Command } from 'commander';
import { readFile, writeFile, readdir, mkdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, extname, basename, resolve } from 'path';
import { fetchGoogleUserEmail } from '../auth/token-manager';
import { setCredentials } from '../auth/token-store';
import { setProfile, getProfile } from '../config/config-manager';
import { createProfileCommands } from '../utils/profile-commands';
import { createClientGetter } from '../utils/client-factory';
import { performOAuthFlow } from '../auth/oauth';
import { GScriptClient } from '../services/gscript/client';
import { readStdin } from '../utils/stdin';
import {
  printGScriptProject,
  printGScriptList,
  printGScriptPullResult,
  printGScriptPushResult,
} from '../utils/output';
import { CliError, handleError } from '../utils/errors';
import { enforceWriteAccess } from '../utils/read-only';
import { addExamples } from '../utils/command-tree';
import type {
  GScriptCredentials,
  GScriptFile,
  GScriptFileType,
  GScriptPullResult,
  GScriptPushResult,
} from '../types/gscript';

const getGScriptClient = createClientGetter<GScriptCredentials, GScriptClient>({
  service: 'gscript',
  createClient: (credentials) => new GScriptClient(credentials),
});

// File-type round-trip helpers
const EXT_TO_TYPE: Record<string, GScriptFileType> = {
  '.gs': 'SERVER_JS',
  '.html': 'HTML',
  '.json': 'JSON',
};

const TYPE_TO_EXT: Record<GScriptFileType, string> = {
  SERVER_JS: '.gs',
  HTML: '.html',
  JSON: '.json',
};

function localFilenameForApiFile(file: { name: string; type: GScriptFileType }): string {
  return `${file.name}${TYPE_TO_EXT[file.type]}`;
}

function stripExt(name: string): string {
  const ext = extname(name);
  return ext ? basename(name, ext) : name;
}

export function registerGScriptCommands(program: Command): void {
  const gscript = program.command('gscript').description('Google Apps Script operations');

  // create
  addExamples(
    gscript
      .command('create')
      .description('Create a new Apps Script project (standalone or container-bound)')
      .requiredOption('--title <title>', 'Script project title')
      .option('--parent <containerId>', 'Bind to a Sheet/Doc/Form/Slides ID (omit for standalone)')
      .option('--profile <name>', 'Profile name')
      .action(async (options) => {
        try {
          const { client, profile } = await getGScriptClient(options.profile);
          await enforceWriteAccess('gscript', profile, 'create script project');
          const project = await client.create({ title: options.title, parentId: options.parent });
          printGScriptProject(project);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # standalone script
  agentio gscript create --title "Helper Library"

  # bound to a Sheet
  agentio gscript create --title "Sheet automation" --parent 1A2bCdEfGhIjKlMnOpQrStUvWxYz0123456789

  # bound to a Doc, with explicit profile
  agentio gscript create --title "Doc tools" --parent 1Doc... --profile work@example.com

The --parent ID is the container's Drive file ID (Sheet/Doc/Form/Slides).`,
  );

  // metadata
  addExamples(
    gscript
      .command('metadata')
      .argument('<id>', 'Script project ID')
      .description('Get script project metadata')
      .option('--profile <name>', 'Profile name')
      .action(async (id: string, options) => {
        try {
          const { client } = await getGScriptClient(options.profile);
          const project = await client.metadata(id);
          printGScriptProject(project);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # show title, owner, timestamps, parent, editor URL
  agentio gscript metadata 1abc...XYZ`,
  );

  // list
  addExamples(
    gscript
      .command('list')
      .description('List script projects (optionally filtered to a container)')
      .option('--parent <containerId>', 'Only list scripts bound to this container')
      .option('--limit <n>', 'Max results', '25')
      .option('--profile <name>', 'Profile name')
      .action(async (options) => {
        try {
          const { client } = await getGScriptClient(options.profile);
          const items = await client.list({
            parentId: options.parent,
            limit: parseInt(options.limit, 10),
          });
          printGScriptList(items);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # all script projects
  agentio gscript list

  # script bound to a specific Sheet
  agentio gscript list --parent 1Sheet...

  # standalone scripts (no container) — list and inspect parentId field
  agentio gscript list --limit 100`,
  );

  // delete
  addExamples(
    gscript
      .command('delete')
      .argument('<id>', 'Script project ID')
      .description('Delete a script project (moves to Drive trash)')
      .option('--force', 'Skip confirmation')
      .option('--profile <name>', 'Profile name')
      .action(async (id: string, options) => {
        try {
          const { client, profile } = await getGScriptClient(options.profile);
          await enforceWriteAccess('gscript', profile, 'delete script project');
          if (!options.force) {
            const project = await client.metadata(id);
            console.error(`About to delete script project: ${project.title} (${project.scriptId})`);
            console.error('Pass --force to confirm.');
            return;
          }
          await client.delete(id);
          console.log(`Deleted script project ${id}`);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # confirm + delete
  agentio gscript delete 1abc...XYZ --force`,
  );

  // pull
  addExamples(
    gscript
      .command('pull')
      .argument('<id>', 'Script project ID')
      .argument('[dir]', 'Local directory (default: cwd)')
      .description('Download all script files to a local directory (writes .clasp.json)')
      .option('--force', 'Overwrite a directory whose .clasp.json points to a different scriptId')
      .option('--profile <name>', 'Profile name')
      .action(async (id: string, dir: string | undefined, options) => {
        try {
          const targetDir = resolve(dir || process.cwd());
          await mkdir(targetDir, { recursive: true });

          // Refuse to clobber a different scriptId unless --force
          const claspPath = join(targetDir, '.clasp.json');
          if (existsSync(claspPath) && !options.force) {
            const existing = JSON.parse(await readFile(claspPath, 'utf8')) as { scriptId?: string };
            if (existing.scriptId && existing.scriptId !== id) {
              throw new CliError(
                'INVALID_PARAMS',
                `${claspPath} already points to scriptId ${existing.scriptId}`,
                'Pass --force to overwrite, or pull into a different directory'
              );
            }
          }

          const { client } = await getGScriptClient(options.profile);
          const files = await client.getContent(id);

          const written: GScriptPullResult['files'] = [];
          for (const file of files) {
            const localName = localFilenameForApiFile(file);
            const localPath = join(targetDir, localName);
            await writeFile(localPath, file.source, 'utf8');
            written.push({ localPath, type: file.type });
          }
          await writeFile(claspPath, JSON.stringify({ scriptId: id, rootDir: '.' }, null, 2) + '\n', 'utf8');

          printGScriptPullResult({ rootDir: targetDir, scriptId: id, files: written });
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # pull into the current directory
  agentio gscript pull 1abc...XYZ

  # pull into a fresh folder
  agentio gscript pull 1abc...XYZ ./my-script

  # overwrite a directory pointing to a different script
  agentio gscript pull 1abc...XYZ ./my-script --force

Writes Code.gs, appsscript.json, *.html files, plus .clasp.json with the scriptId.`,
  );

  // push
  addExamples(
    gscript
      .command('push')
      .argument('[dir]', 'Local directory (default: cwd)')
      .description('Upload all .gs/.html/appsscript.json files in a directory')
      .option('--id <scriptId>', 'Override scriptId from .clasp.json')
      .option('--profile <name>', 'Profile name')
      .action(async (dir: string | undefined, options) => {
        try {
          const targetDir = resolve(dir || process.cwd());

          let scriptId: string | undefined = options.id;
          if (!scriptId) {
            const claspPath = join(targetDir, '.clasp.json');
            if (!existsSync(claspPath)) {
              throw new CliError(
                'INVALID_PARAMS',
                `No .clasp.json found in ${targetDir}`,
                'Pass --id <scriptId>, or run `agentio gscript pull` first'
              );
            }
            const config = JSON.parse(await readFile(claspPath, 'utf8')) as { scriptId?: string };
            if (!config.scriptId) {
              throw new CliError('INVALID_PARAMS', `.clasp.json missing scriptId field`);
            }
            scriptId = config.scriptId;
          }

          const entries = await readdir(targetDir);
          const files: GScriptFile[] = [];
          for (const entry of entries) {
            if (entry.startsWith('.')) continue; // skip .clasp.json and hidden files
            const fullPath = join(targetDir, entry);
            const s = await stat(fullPath);
            if (!s.isFile()) continue;
            const ext = extname(entry).toLowerCase();
            const type = EXT_TO_TYPE[ext];
            if (!type) continue;
            const name = basename(entry, ext);
            const source = await readFile(fullPath, 'utf8');
            files.push({ name, type, source });
          }

          if (!files.some((f) => f.type === 'JSON' && f.name === 'appsscript')) {
            throw new CliError(
              'INVALID_PARAMS',
              `Apps Script API requires an appsscript.json manifest in ${targetDir}`,
              'Pull the project first, or create appsscript.json manually'
            );
          }

          const { client, profile } = await getGScriptClient(options.profile);
          await enforceWriteAccess('gscript', profile, 'push script content');
          const updated = await client.updateContent(scriptId, files);

          const result: GScriptPushResult = {
            scriptId,
            files: updated.map((f) => ({ name: f.name, type: f.type })),
          };
          printGScriptPushResult(result);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # push current directory (uses .clasp.json)
  agentio gscript push

  # push a specific directory
  agentio gscript push ./my-script

  # push to a script id that's not in .clasp.json
  agentio gscript push ./my-script --id 1abc...XYZ

Hidden files and .clasp.json are skipped. The push fails if appsscript.json is missing.`,
  );

  // get (single file)
  addExamples(
    gscript
      .command('get')
      .argument('<id>', 'Script project ID')
      .argument('<file>', 'File name (with or without extension, e.g. Code or Code.gs)')
      .description('Print one script file to stdout')
      .option('--profile <name>', 'Profile name')
      .action(async (id: string, file: string, options) => {
        try {
          const { client } = await getGScriptClient(options.profile);
          const files = await client.getContent(id);
          const bare = stripExt(file);
          const match = files.find((f) => f.name === bare);
          if (!match) {
            throw new CliError(
              'NOT_FOUND',
              `No file named "${bare}" in script ${id}`,
              `Available: ${files.map((f) => f.name).join(', ') || '(empty)'}`
            );
          }
          process.stdout.write(match.source);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # print Code.gs to stdout
  agentio gscript get 1abc...XYZ Code

  # bare name and full filename both work
  agentio gscript get 1abc...XYZ Code.gs

  # the JSON manifest
  agentio gscript get 1abc...XYZ appsscript`,
  );

  // put (single file)
  addExamples(
    gscript
      .command('put')
      .argument('<id>', 'Script project ID')
      .argument('<file>', 'File name (with or without extension)')
      .description('Replace or add a single script file (--source, --from <path>, or - for stdin)')
      .option('--source <text>', 'Inline content')
      .option('--from <path>', 'Read content from a local file')
      .option('--profile <name>', 'Profile name')
      .action(async (id: string, file: string, options) => {
        try {
          if (options.source !== undefined && options.from !== undefined) {
            throw new CliError('INVALID_PARAMS', '--source and --from are mutually exclusive');
          }
          let source: string;
          if (options.source !== undefined) {
            source = options.source;
          } else if (options.from !== undefined) {
            source = await readFile(options.from, 'utf8');
          } else {
            const stdinContent = await readStdin();
            if (stdinContent === null) {
              throw new CliError(
                'INVALID_PARAMS',
                'No content provided',
                'Pass --source <text>, --from <path>, or pipe content via stdin'
              );
            }
            source = stdinContent;
          }

          const { client, profile } = await getGScriptClient(options.profile);
          await enforceWriteAccess('gscript', profile, 'update script content');

          const existing = await client.getContent(id);
          const bare = stripExt(file);
          const ext = extname(file).toLowerCase();

          // Type inference: existing entry > extension > default SERVER_JS
          const existingMatch = existing.find((f) => f.name === bare);
          let type: GScriptFileType;
          if (existingMatch) {
            type = existingMatch.type;
          } else if (ext && EXT_TO_TYPE[ext]) {
            type = EXT_TO_TYPE[ext];
            if (type === 'JSON' && bare !== 'appsscript') {
              throw new CliError('INVALID_PARAMS', `JSON files must be named "appsscript"`);
            }
          } else {
            type = 'SERVER_JS';
          }

          const next = existingMatch
            ? existing.map((f) => (f.name === bare ? { ...f, source } : f))
            : [...existing, { name: bare, type, source }];

          const updated = await client.updateContent(id, next);
          const result: GScriptPushResult = {
            scriptId: id,
            files: updated.map((f) => ({ name: f.name, type: f.type })),
          };
          printGScriptPushResult(result);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # inline content
  agentio gscript put 1abc...XYZ Code --source 'function doIt(){}'

  # from a local file
  agentio gscript put 1abc...XYZ Code.gs --from ./Code.gs

  # from stdin
  echo 'function doIt(){}' | agentio gscript put 1abc...XYZ Code

  # add a new helper
  agentio gscript put 1abc...XYZ Helpers --source '// helpers go here'

Type inference: extension on the file argument decides the API type
(.gs=SERVER_JS, .html=HTML, .json=JSON-only-for-appsscript). If the
file already exists in the project, its existing type is reused.`,
  );

  // Profile management
  const profile = createProfileCommands<GScriptCredentials>(gscript, {
    service: 'gscript',
    displayName: 'Google Apps Script',
    getExtraInfo: (credentials) => (credentials?.email ? ` - ${credentials.email}` : ''),
  });

  profile
    .command('add')
    .description('Add a new Google Apps Script profile')
    .option('--profile <name>', 'Profile name (auto-detected from email if not provided)')
    .option('--read-only', 'Create as read-only profile (blocks write operations)')
    .action(async (options) => {
      try {
        await gscriptProfileAdd(options);
      } catch (error) {
        handleError(error);
      }
    });
}

export async function gscriptProfileAdd(options: { profile?: string; readOnly?: boolean }): Promise<void> {
  console.error('Starting OAuth flow for Google Apps Script...\n');

  const tokens = await performOAuthFlow('gscript');

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

  let profileName: string;
  if (options.profile) {
    profileName = options.profile;
  } else if (options.readOnly && (await getProfile('gscript', userEmail))) {
    profileName = `${userEmail}-readonly`;
  } else {
    profileName = userEmail;
  }

  const credentials: GScriptCredentials = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiryDate: tokens.expiry_date,
    tokenType: tokens.token_type,
    scope: tokens.scope,
    email: userEmail,
  };

  await setProfile('gscript', profileName, { readOnly: options.readOnly });
  await setCredentials('gscript', profileName, credentials);

  console.log(`\nSuccess! Profile "${profileName}" configured.`);
  console.log(`   Email: ${userEmail}`);
  if (options.readOnly) console.log(`   Access: read-only`);
  console.log(`   Test with: agentio gscript list --profile ${profileName}`);
}
