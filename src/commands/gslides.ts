import { Command } from 'commander';
import { readFile, writeFile } from 'fs/promises';
import { fetchGoogleUserEmail } from '../auth/token-manager';
import { setCredentials } from '../auth/token-store';
import { setProfile, getProfile } from '../config/config-manager';
import { createProfileCommands } from '../utils/profile-commands';
import { createClientGetter } from '../utils/client-factory';
import { performOAuthFlow } from '../auth/oauth';
import { GSlidesClient } from '../services/gslides/client';
import {
  printGSlidesList,
  printGSlidesMetadata,
  printGSlidesContent,
  printGSlidesCreated,
  printGSlidesBatchResult,
} from '../utils/output';
import { CliError, handleError } from '../utils/errors';
import { enforceWriteAccess } from '../utils/read-only';
import { addExamples } from '../utils/command-tree';
import type { GSlidesCredentials } from '../types/gslides';

const getGSlidesClient = createClientGetter<GSlidesCredentials, GSlidesClient>({
  service: 'gslides',
  createClient: (credentials) => new GSlidesClient(credentials),
});

export function registerGSlidesCommands(program: Command): void {
  const gslides = program.command('gslides').description('Google Slides operations');

  addExamples(
    gslides
      .command('list')
      .description('List recent presentations')
      .option('--profile <name>', 'Profile name')
      .option('--limit <n>', 'Number of presentations', '10')
      .option('--query <query>', 'Drive search query filter')
      .action(async (options) => {
        try {
          const { client } = await getGSlidesClient(options.profile);
          const items = await client.list({
            limit: parseInt(options.limit, 10),
            query: options.query,
          });
          printGSlidesList(items);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # 10 most recently modified presentations
  agentio gslides list

  # presentations you own
  agentio gslides list --query "'me' in owners" --limit 50

  # search by name fragment
  agentio gslides list --query "name contains 'Q4'"

  # recently modified
  agentio gslides list --query "modifiedTime > '2024-01-01'"

Query syntax: name contains '...', name = '...', 'me' in owners,
modifiedTime > 'YYYY-MM-DD'. Combine with 'and'/'or'.`,
  );

  addExamples(
    gslides
      .command('metadata')
      .argument('<id-or-url>', 'Presentation ID or URL')
      .description('Get presentation structure (slide count, dimensions, slide titles)')
      .option('--profile <name>', 'Profile name')
      .action(async (idOrUrl: string, options) => {
        try {
          const { client } = await getGSlidesClient(options.profile);
          const metadata = await client.metadata(idOrUrl);
          printGSlidesMetadata(metadata);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # slide count, dimensions, slide titles
  agentio gslides metadata 1A2bCdEfGhIjKlMnOpQrStUvWxYz0123456789

  # accept a full URL
  agentio gslides metadata https://docs.google.com/presentation/d/1A2bCdEf.../edit`,
  );

  addExamples(
    gslides
      .command('get')
      .argument('<id-or-url>', 'Presentation ID or URL')
      .description('Read slide content as text (all slides or one by index)')
      .option('--profile <name>', 'Profile name')
      .option('--slide <n>', 'Zero-based slide index to read (omit for all slides)', (v) => parseInt(v, 10))
      .action(async (idOrUrl: string, options) => {
        try {
          const { client } = await getGSlidesClient(options.profile);
          const slides = await client.get(idOrUrl, options.slide);
          printGSlidesContent(slides);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # read all slides as text
  agentio gslides get 1A2bCdEfGhIjKlMnOpQrStUvWxYz0123456789

  # read only slide 0 (first slide)
  agentio gslides get 1A2bCdEf... --slide 0

  # accept a full URL
  agentio gslides get https://docs.google.com/presentation/d/1A2bCdEf.../edit

Output includes text elements and speaker notes for each slide.`,
  );

  addExamples(
    gslides
      .command('export')
      .argument('<id-or-url>', 'Presentation ID or URL')
      .description('Export a presentation to a file')
      .option('--profile <name>', 'Profile name')
      .requiredOption('--output <path>', 'Output file path')
      .option('--format <fmt>', 'Export format: pptx, pdf, or odp', 'pptx')
      .action(async (idOrUrl: string, options) => {
        try {
          const { client } = await getGSlidesClient(options.profile);
          const format = options.format.toLowerCase();

          if (!['pptx', 'pdf', 'odp'].includes(format)) {
            throw new CliError('INVALID_PARAMS', `Unknown format: ${format}`, 'Use pptx, pdf, or odp');
          }

          const result = await client.export(idOrUrl, format as 'pptx' | 'pdf' | 'odp');
          await writeFile(options.output, result.data);
          console.log(`Exported to ${options.output}`);
          console.log(`  Format: ${format}`);
          console.log(`  Size: ${result.data.length} bytes`);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # default pptx export
  agentio gslides export 1A2bCdEf... --output deck.pptx

  # PDF
  agentio gslides export 1A2bCdEf... --output deck.pdf --format pdf

  # ODP (LibreOffice)
  agentio gslides export 1A2bCdEf... --output deck.odp --format odp

Formats: pptx (default), pdf, odp.`,
  );

  addExamples(
    gslides
      .command('create')
      .argument('<title>', 'Presentation title')
      .description('Create a new blank presentation')
      .option('--profile <name>', 'Profile name')
      .action(async (title: string, options) => {
        try {
          const { client, profile } = await getGSlidesClient(options.profile);
          await enforceWriteAccess('gslides', profile, 'create presentation');
          const result = await client.create(title);
          printGSlidesCreated(result);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # create a blank presentation
  agentio gslides create "Q4 Review"

  # with a specific profile
  agentio gslides create "Team Deck" --profile work@example.com`,
  );

  addExamples(
    gslides
      .command('copy')
      .argument('<id-or-url>', 'Presentation ID or URL')
      .argument('<title>', 'New presentation title')
      .description('Copy a presentation')
      .option('--profile <name>', 'Profile name')
      .option('--parent <folder-id>', 'Destination folder ID')
      .action(async (idOrUrl: string, title: string, options) => {
        try {
          const { client, profile } = await getGSlidesClient(options.profile);
          await enforceWriteAccess('gslides', profile, 'copy presentation');
          const result = await client.copy(idOrUrl, title, options.parent);
          printGSlidesCreated(result);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # duplicate to My Drive root
  agentio gslides copy 1A2bCdEf... "Q4 Review (copy)"

  # duplicate into a specific folder
  agentio gslides copy 1A2bCdEf... "Q4 Review (copy)" --parent 1FoLdErIdAbCd...`,
  );

  const batchCmd = gslides
    .command('batch')
    .argument('<id-or-url>', 'Presentation ID or URL')
    .description('Execute raw presentations.batchUpdate requests (escape hatch)')
    .option('--profile <name>', 'Profile name')
    .option('--requests-json <json>', 'Inline JSON array of Request objects')
    .option('--file <path>', 'Path to a JSON file containing the requests array')
    .action(async (idOrUrl: string, options) => {
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

        const { client, profile } = await getGSlidesClient(options.profile);
        await enforceWriteAccess('gslides', profile, 'execute batch update');
        const result = await client.batch(idOrUrl, parsed as Parameters<typeof client.batch>[1]);
        printGSlidesBatchResult(result);
      } catch (error) {
        handleError(error);
      }
    });

  addExamples(
    batchCmd,
    `Examples:

  # insert a new blank slide at the end (inline JSON)
  agentio gslides batch 1A2bCdEf... --requests-json '[{"createSlide":{"insertionIndex":999,"slideLayoutReference":{"predefinedLayout":"BLANK"}}}]'

  # from a file
  agentio gslides batch 1A2bCdEf... --file ./requests.json

Accepts an array of Slides API Request objects. See:
https://developers.google.com/slides/api/reference/rest/v1/presentations/batchUpdate`,
  );

  // Profile management
  const profile = createProfileCommands<GSlidesCredentials>(gslides, {
    service: 'gslides',
    displayName: 'Google Slides',
    getExtraInfo: (credentials) => (credentials?.email ? ` - ${credentials.email}` : ''),
  });

  profile
    .command('add')
    .description('Add a new Google Slides profile')
    .option('--profile <name>', 'Profile name (auto-detected from email if not provided)')
    .option('--read-only', 'Create as read-only profile (blocks write operations)')
    .action(async (options) => {
      try {
        await gslidesProfileAdd(options);
      } catch (error) {
        handleError(error);
      }
    });
}

export async function gslidesProfileAdd(options: { profile?: string; readOnly?: boolean }): Promise<void> {
  console.error('Starting OAuth flow for Google Slides...\n');

  const tokens = await performOAuthFlow('gslides');

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
  } else if (options.readOnly && (await getProfile('gslides', userEmail))) {
    profileName = `${userEmail}-readonly`;
  } else {
    profileName = userEmail;
  }

  const credentials: GSlidesCredentials = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiryDate: tokens.expiry_date,
    tokenType: tokens.token_type,
    scope: tokens.scope,
    email: userEmail,
  };

  await setProfile('gslides', profileName, { readOnly: options.readOnly });
  await setCredentials('gslides', profileName, credentials);

  console.log(`\nSuccess! Profile "${profileName}" configured.`);
  console.log(`   Email: ${userEmail}`);
  if (options.readOnly) console.log(`   Access: read-only`);
  console.log(`   Test with: agentio gslides list --profile ${profileName}`);
}
