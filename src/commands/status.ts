import { Command } from 'commander';
import { listProfileRefs as listConfiguredProfiles, CONFIG_DIR } from '../config/config-manager';
import { getCredentials } from '../auth/token-store';
import { createGoogleAuth } from '../auth/token-manager';
import { getFreshCredentials } from '../auth/refresh';
import { CliError, profileNotFoundError } from '../utils/errors';
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
import { hub, isRemoteMode, remoteProfiles } from '../auth/remote';

type GmailCredentials = OAuthTokens & { email?: string };

/**
 * Creates a ServiceClient for the given service and credentials. Refresh is
 * not this function's job; callers pass credentials from getFreshCredentials.
 */
function createServiceClient(service: ServiceName, credentials: unknown): ServiceClient {
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
      const creds = credentials as JiraCredentials;
      return new JiraClient(creds);
    }

    case 'confluence': {
      const creds = credentials as ConfluenceCredentials;
      return new ConfluenceClient(creds);
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
      const creds = credentials as RevolutCredentials;
      return new RevolutClient(creds);
    }

    case 'dropbox': {
      const creds = credentials as DropboxCredentials;
      return new DropboxClient(creds);
    }

    case 'sql': {
      const creds = credentials as SqlCredentials;
      return new SqlClient(creds);
    }

    default: {
      const exhaustive: never = service;
      throw new Error(`Unhandled service ${String(exhaustive)}`);
    }
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

/** The reported shape: `profile` is the wire field name in `status --json`. */
type ProfileRef = Pick<ProfileStatus, 'service' | 'profile' | 'readOnly'>;

async function listProfileRefs(): Promise<ProfileRef[]> {
  return (await listConfiguredProfiles()).map(({ service, name, readOnly }) => ({ service, profile: name, readOnly }));
}

/**
 * Tests one profile. Stale tokens are refreshed first. A failed validation
 * gets one forced refresh and a retry, since a token can be rejected before
 * its recorded expiry; not when the client already diagnosed the refresh
 * token itself, where a second exchange can only fail the same way.
 */
/** Whether anything is stored for the profile: the hub says so in its listing, so no fetch is needed there. */
async function hasStoredCredentials(ref: ProfileRef): Promise<boolean> {
  if (isRemoteMode()) {
    return (await remoteProfiles()).some((p) => p.service === ref.service && p.name === ref.profile && p.hasCredentials);
  }
  return (await getCredentials(ref.service, ref.profile)) !== null;
}

async function checkProfile(ref: ProfileRef, shouldTest: boolean): Promise<ProfileStatus> {
  if (!(await hasStoredCredentials(ref))) {
    return { ...ref, status: 'no-creds' };
  }

  if (!shouldTest) {
    return { ...ref, status: 'skipped' };
  }

  let result: ValidationResult;
  try {
    const { credentials } = await getFreshCredentials(ref.service, ref.profile);
    result = await createServiceClient(ref.service, credentials).validate();
    // A forced refresh cannot happen remotely: the hub keeps the refresh material.
    if (!result.valid && !isRemoteMode() && !result.error?.includes('re-authenticate')) {
      const forced = await getFreshCredentials(ref.service, ref.profile, { force: true });
      if (forced.refreshed) result = await createServiceClient(ref.service, forced.credentials).validate();
    }
  } catch (err) {
    if (!(err instanceof CliError && err.code === 'TOKEN_EXPIRED')) throw err;
    result = { valid: false, error: 'refresh token rejected, re-authenticate' };
  }

  return {
    ...ref,
    status: result.valid ? 'ok' : 'invalid',
    info: result.info,
    error: result.error,
  };
}

/** Test one configured profile now; PROFILE_NOT_FOUND when it is not configured. */
export async function getProfileStatus(service: ServiceName, profile: string): Promise<ProfileStatus> {
  const ref = (await listProfileRefs()).find((r) => r.service === service && r.profile === profile);
  if (!ref) throw profileNotFoundError(service, profile);
  return checkProfile(ref, true);
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
            ...(isRemoteMode() ? { hub: hub().url } : { configDir: CONFIG_DIR }),
            services,
          };
          console.log(JSON.stringify(output, null, 2));
          return;
        }

        // Human-readable output
        console.log(`agentio v${version}`);
        console.log(isRemoteMode() ? `Hub: ${hub().url}\n` : `Config: ${CONFIG_DIR}\n`);

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
