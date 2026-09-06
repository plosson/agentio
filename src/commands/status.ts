import { Command } from 'commander';
import { listProfiles, listEnv, CONFIG_DIR } from '../config/config-manager';
import { getCredentials, setCredentials } from '../auth/token-store';
import { createGoogleAuth } from '../auth/token-manager';
import { refreshJiraToken } from '../auth/jira-oauth';
import { refreshConfluenceToken } from '../auth/confluence-oauth';
import { refreshRevolutToken } from '../auth/revolut-oauth';
import { refreshDropboxToken } from '../auth/dropbox-oauth';
import { TelegramClient } from '../services/telegram/client';
import { GmailClient } from '../services/gmail/client';
import { GDocsClient } from '../services/gdocs/client';
import { GDriveClient } from '../services/gdrive/client';
import { GCalClient } from '../services/gcal/client';
import { GTasksClient } from '../services/gtasks/client';
import { GitHubClient } from '../services/github/client';
import { JiraClient } from '../services/jira/client';
import { ConfluenceClient } from '../services/confluence/client';
import { GChatClient } from '../services/gchat/client';
import { SlackClient } from '../services/slack/client';
import { DiscourseClient } from '../services/discourse/client';
import { DropboxClient } from '../services/dropbox/client';
import { RevolutClient } from '../services/revolut/client';
import { GSheetsClient } from '../services/gsheets/client';
import { GSlidesClient } from '../services/gslides/client';
import { GScriptClient } from '../services/gscript/client';
import { SqlClient } from '../services/sql/client';
import type { ServiceClient, ValidationResult } from '../types/service';
import type { ServiceName } from '../types/config';
import type { OAuthTokens } from '../types/tokens';
import type { TelegramCredentials } from '../types/telegram';
import type { GitHubCredentials } from '../types/github';
import type { JiraCredentials } from '../types/jira';
import type { ConfluenceCredentials } from '../types/confluence';
import type { GDocsCredentials } from '../types/gdocs';
import type { GDriveCredentials } from '../types/gdrive';
import type { GCalCredentials } from '../types/gcal';
import type { GTasksCredentials } from '../types/gtasks';
import type { GChatCredentials } from '../types/gchat';
import type { GSheetsCredentials } from '../types/gsheets';
import type { GSlidesCredentials } from '../types/gslides';
import type { GScriptCredentials } from '../types/gscript';
import type { SlackCredentials } from '../types/slack';
import type { DiscourseCredentials } from '../types/discourse';
import type { DropboxCredentials } from '../types/dropbox';
import type { RevolutCredentials } from '../types/revolut';
import type { SqlCredentials } from '../types/sql';
import { addExamples } from '../utils/command-tree';

type GmailCredentials = OAuthTokens & { email?: string };

/**
 * Creates a ServiceClient for the given service and credentials.
 * Handles token refresh for OAuth services before creating the client.
 */
async function createServiceClient(
  service: ServiceName,
  credentials: unknown,
  profileName: string
): Promise<ServiceClient | null> {
  switch (service) {
    case 'gmail': {
      const creds = credentials as GmailCredentials;
      const auth = createGoogleAuth({
        access_token: creds.access_token,
        refresh_token: creds.refresh_token,
        expiry_date: creds.expiry_date,
        token_type: creds.token_type || 'Bearer',
        scope: creds.scope,
      });
      return new GmailClient(auth);
    }

    case 'gdocs': {
      const creds = credentials as GDocsCredentials;
      return new GDocsClient(creds);
    }

    case 'gdrive': {
      const creds = credentials as GDriveCredentials;
      return new GDriveClient(creds);
    }

    case 'gsheets': {
      const creds = credentials as GSheetsCredentials;
      return new GSheetsClient(creds);
    }

    case 'gslides': {
      const creds = credentials as GSlidesCredentials;
      return new GSlidesClient(creds);
    }

    case 'gscript': {
      const creds = credentials as GScriptCredentials;
      return new GScriptClient(creds);
    }

    case 'gcal': {
      const creds = credentials as GCalCredentials;
      const auth = createGoogleAuth({
        access_token: creds.access_token,
        refresh_token: creds.refresh_token,
        expiry_date: creds.expiry_date,
        token_type: creds.token_type || 'Bearer',
        scope: creds.scope,
      });
      return new GCalClient(auth);
    }

    case 'gtasks': {
      const creds = credentials as GTasksCredentials;
      const auth = createGoogleAuth({
        access_token: creds.access_token,
        refresh_token: creds.refresh_token,
        expiry_date: creds.expiry_date,
        token_type: creds.token_type || 'Bearer',
        scope: creds.scope,
      });
      return new GTasksClient(auth);
    }

    case 'telegram': {
      const creds = credentials as TelegramCredentials;
      return new TelegramClient(creds.botToken, creds.channelId);
    }

    case 'github': {
      const creds = credentials as GitHubCredentials;
      return new GitHubClient(creds);
    }

    case 'jira': {
      let creds = credentials as JiraCredentials;

      // Helper to refresh token
      const tryRefresh = async (): Promise<JiraCredentials | null> => {
        try {
          const refreshed = await refreshJiraToken(creds.refreshToken);
          const newCreds = {
            ...creds,
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            expiryDate: Date.now() + refreshed.expiresIn * 1000,
          };
          await setCredentials('jira', profileName, newCreds);
          return newCreds;
        } catch {
          return null;
        }
      };

      // Refresh token if expired or about to expire
      const bufferTime = 5 * 60 * 1000;
      if (creds.expiryDate && Date.now() + bufferTime >= creds.expiryDate) {
        const refreshedCreds = await tryRefresh();
        if (!refreshedCreds) {
          return {
            validate: async () => ({
              valid: false,
              error: 'refresh token expired, re-authenticate',
            }),
          };
        }
        creds = refreshedCreds;
      }

      // Create client and return a wrapper that attempts refresh on validation failure
      const client = new JiraClient(creds);
      return {
        validate: async () => {
          const result = await client.validate();
          if (result.valid) {
            return result;
          }

          // Validation failed - try to refresh token and retry
          const refreshedCreds = await tryRefresh();
          if (!refreshedCreds) {
            return {
              valid: false,
              error: 'refresh token expired, re-authenticate',
            };
          }

          // Retry validation with refreshed credentials
          const refreshedClient = new JiraClient(refreshedCreds);
          return refreshedClient.validate();
        },
      };
    }

    case 'confluence': {
      let creds = credentials as ConfluenceCredentials;

      const tryRefresh = async (): Promise<ConfluenceCredentials | null> => {
        try {
          const refreshed = await refreshConfluenceToken(creds.refreshToken);
          const newCreds = {
            ...creds,
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            expiryDate: Date.now() + refreshed.expiresIn * 1000,
          };
          await setCredentials('confluence', profileName, newCreds);
          return newCreds;
        } catch {
          return null;
        }
      };

      const bufferTime = 5 * 60 * 1000;
      if (creds.expiryDate && Date.now() + bufferTime >= creds.expiryDate) {
        const refreshedCreds = await tryRefresh();
        if (!refreshedCreds) {
          return {
            validate: async () => ({
              valid: false,
              error: 'refresh token expired, re-authenticate',
            }),
          };
        }
        creds = refreshedCreds;
      }

      const client = new ConfluenceClient(creds);
      return {
        validate: async () => {
          const result = await client.validate();
          if (result.valid) {
            return result;
          }

          const refreshedCreds = await tryRefresh();
          if (!refreshedCreds) {
            return {
              valid: false,
              error: 'refresh token expired, re-authenticate',
            };
          }

          const refreshedClient = new ConfluenceClient(refreshedCreds);
          return refreshedClient.validate();
        },
      };
    }

    case 'gchat': {
      const creds = credentials as GChatCredentials;
      return new GChatClient(creds);
    }

    case 'slack': {
      const creds = credentials as SlackCredentials;
      return new SlackClient(creds);
    }

    case 'discourse': {
      const creds = credentials as DiscourseCredentials;
      return new DiscourseClient(creds);
    }

    case 'revolut': {
      let creds = credentials as RevolutCredentials;

      // Access tokens live 40 minutes, so status almost always refreshes first.
      const bufferTime = 5 * 60 * 1000;
      if (!creds.expiryDate || Date.now() + bufferTime >= creds.expiryDate) {
        try {
          const refreshed = await refreshRevolutToken(creds);
          creds = {
            ...creds,
            accessToken: refreshed.accessToken,
            expiryDate: Date.now() + refreshed.expiresIn * 1000,
          };
          await setCredentials('revolut', profileName, creds);
        } catch {
          return {
            validate: async () => ({
              valid: false,
              error: 'refresh token rejected, re-authenticate',
            }),
          };
        }
      }

      return new RevolutClient(creds);
    }

    case 'dropbox': {
      let creds = credentials as DropboxCredentials;

      // Access tokens live 4 hours, so status often refreshes first.
      const bufferTime = 5 * 60 * 1000;
      if (!creds.expiryDate || Date.now() + bufferTime >= creds.expiryDate) {
        try {
          const refreshed = await refreshDropboxToken(creds.appKey, creds.refreshToken);
          creds = {
            ...creds,
            accessToken: refreshed.accessToken,
            expiryDate: Date.now() + refreshed.expiresIn * 1000,
          };
          await setCredentials('dropbox', profileName, creds);
        } catch {
          return {
            validate: async () => ({
              valid: false,
              error: 'refresh token rejected, re-authenticate',
            }),
          };
        }
      }

      return new DropboxClient(creds);
    }

    case 'sql': {
      const creds = credentials as SqlCredentials;
      return new SqlClient(creds);
    }

    default:
      return null;
  }
}

export interface ProfileStatus {
  service: ServiceName;
  profile: string;
  readOnly?: boolean;
  status: 'ok' | 'invalid' | 'no-creds' | 'skipped';
  info?: string;
  error?: string;
}

interface ProfileRef {
  service: ServiceName;
  profile: string;
  readOnly?: boolean;
}

/**
 * Flattens the configured profiles into the order they are reported in.
 */
async function listProfileRefs(): Promise<ProfileRef[]> {
  const allProfiles = await listProfiles();
  const refs: ProfileRef[] = [];

  for (const { service, profiles } of allProfiles) {
    for (const entry of profiles) {
      refs.push({ service, profile: entry.name, readOnly: entry.readOnly });
    }
  }

  return refs;
}

/**
 * Tests one profile. Kept sequential by callers: refreshing a token writes the
 * new credentials back to the vault, and concurrent writes would clobber it.
 */
async function checkProfile(ref: ProfileRef, shouldTest: boolean): Promise<ProfileStatus> {
  const credentials = await getCredentials(ref.service, ref.profile);

  if (!credentials) {
    return { ...ref, status: 'no-creds' };
  }

  if (!shouldTest) {
    return { ...ref, status: 'skipped' };
  }

  const client = await createServiceClient(ref.service, credentials, ref.profile);
  const result: ValidationResult = client
    ? await client.validate()
    : { valid: true, info: 'unknown service' };

  return {
    ...ref,
    status: result.valid ? 'ok' : 'invalid',
    info: result.info,
    error: result.error,
  };
}

export async function getProfileStatuses(options?: { test?: boolean }): Promise<ProfileStatus[]> {
  const shouldTest = options?.test !== false;
  const refs = await listProfileRefs();
  const statuses: ProfileStatus[] = [];

  for (const ref of refs) {
    statuses.push(await checkProfile(ref, shouldTest));
  }

  return statuses;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Progress indicator on stderr. Returns null when stderr is not a TTY, so piped
 * or redirected output stays clean.
 */
function createSpinner(): { start: (label: string, index: number, total: number) => void; stop: () => void } | null {
  if (!process.stderr.isTTY) {
    return null;
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  let frame = 0;

  return {
    start(label: string, index: number, total: number): void {
      frame = 0;
      const render = () => {
        const spin = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
        process.stderr.write(`\r\x1b[K  ${spin} checking ${label} (${index}/${total})`);
        frame++;
      };
      render();
      timer = setInterval(render, 80);
    },
    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      process.stderr.write('\r\x1b[K');
    },
  };
}

function formatStatusLine(s: ProfileStatus, serviceWidth: number, profileWidth: number): string {
  const servicePad = s.service.padEnd(serviceWidth);
  const readOnlyIndicator = s.readOnly ? ' [RO]' : '';
  const profileWithRo = s.profile + readOnlyIndicator;
  const profilePad = profileWithRo.padEnd(profileWidth + 5); // +5 for [RO]

  let statusStr: string;
  let details: string;

  switch (s.status) {
    case 'ok':
      statusStr = 'ok';
      details = s.info || '';
      break;
    case 'invalid':
      statusStr = 'ERR';
      details = s.error || '';
      break;
    case 'no-creds':
      statusStr = 'ERR';
      details = 'no credentials';
      break;
    case 'skipped':
      statusStr = '-';
      details = '';
      break;
  }

  return `${servicePad}  ${profilePad}  ${statusStr.padEnd(3)}  ${details}`.trimEnd();
}

export function registerStatusCommand(program: Command): void {
  const statusCmd = program
    .command('status')
    .description('Show configured profiles and credential status')
    .option('--no-test', 'Skip credential testing')
    .option('--json', 'Output in JSON format')
    .action(async (options) => {
      try {
        const version = program.version();
        const envVars = await listEnv();
        const envKeys = Object.keys(envVars).sort();

        // JSON output mode
        if (options.json) {
          const statuses = await getProfileStatuses({ test: options.test });

          // Group profiles by service
          const services: Record<string, Array<Omit<ProfileStatus, 'service'>>> = {};
          for (const s of statuses) {
            const { service, ...rest } = s;
            if (!services[service]) {
              services[service] = [];
            }
            services[service].push(rest);
          }
          const output = {
            version,
            configDir: CONFIG_DIR,
            env: envKeys,
            services,
          };
          console.log(JSON.stringify(output, null, 2));
          return;
        }

        // Human-readable output
        console.log(`agentio v${version}`);
        console.log(`Config: ${CONFIG_DIR}`);
        console.log(`Env: ${envKeys.length > 0 ? envKeys.join(', ') : 'none'}\n`);

        const refs = await listProfileRefs();

        if (refs.length === 0) {
          console.log('No profiles configured.');
          console.log('Run: agentio <service> profile add');
          return;
        }

        // Widths come from the profile list, which is known before any check runs
        const serviceWidth = Math.max(...refs.map((r) => r.service.length));
        const profileWidth = Math.max(...refs.map((r) => r.profile.length));

        // Print each profile as soon as its own check finishes, so a slow or
        // unreachable service does not hold back everything already tested
        const shouldTest = options.test !== false;
        const spinner = shouldTest ? createSpinner() : null;

        for (let i = 0; i < refs.length; i++) {
          const ref = refs[i];
          spinner?.start(`${ref.service} ${ref.profile}`, i + 1, refs.length);
          let status: ProfileStatus;
          try {
            status = await checkProfile(ref, shouldTest);
          } finally {
            spinner?.stop();
          }
          console.log(formatStatusLine(status, serviceWidth, profileWidth));
        }
      } catch (error) {
        console.error('Error:', error instanceof Error ? error.message : 'Unknown error');
        process.exit(1);
      }
    });

  addExamples(
    statusCmd,
    `Examples:

  # show every configured profile and test its credentials
  agentio status

  # show profiles without making test API calls (fast; no network)
  agentio status --no-test

  # JSON output (good for piping to jq or another agent)
  agentio status --json`,
  );
}
