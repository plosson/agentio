import { Command } from 'commander';
import { listProfileRefs as listConfiguredProfiles, CONFIG_DIR } from '../config/config-manager';
import { getCredentials } from '../auth/token-store';
import { getFreshCredentials } from '../auth/refresh';
import { CliError, profileNotFoundError, type ErrorCode } from '../utils/errors';
import { TelegramClient } from '../services/telegram/client';
import { GitHubClient } from '../services/github/client';
import { ConfluenceClient } from '../services/confluence/client';
import { DiscourseClient } from '../services/discourse/client';
import { DropboxClient } from '../services/dropbox/client';
import { RevolutClient } from '../services/revolut/client';
import { SqlClient } from '../services/sql/client';
import type { ServiceClient, ValidationResult } from '../types/service';
import type { ServiceName } from '../types/config';
import type { TelegramCredentials } from '../types/telegram';
import type { GitHubCredentials } from '../types/github';
import type { ConfluenceCredentials } from '../types/confluence';
import type { DiscourseCredentials } from '../types/discourse';
import type { DropboxCredentials } from '../types/dropbox';
import type { RevolutCredentials } from '../types/revolut';
import type { SqlCredentials } from '../types/sql';
import { addExamples } from '../utils/command-tree';
import { hub, isRemoteMode, remoteCanManageProfiles, remoteProfiles } from '../auth/remote';
import { findServicePlugin } from '../plugins/registry';

/**
 * Creates a ServiceClient for the given service and credentials. Refresh is
 * not this function's job; callers pass credentials from getFreshCredentials.
 */
function createServiceClient(service: ServiceName, credentials: unknown): ServiceClient {
  const pluginClient = findServicePlugin(service)?.profile?.createClient;
  if (pluginClient) return pluginClient(credentials);

  switch (service) {
    case 'gmail':
    case 'gdocs':
    case 'gdrive':
    case 'gsheets':
    case 'gslides':
    case 'gscript':
    case 'gcal':
    case 'gtasks':
    case 'gchat':
      throw new Error(`${service} profile plugin is not registered`);

    case 'telegram': {
      const creds = credentials as TelegramCredentials;
      return new TelegramClient(creds.botToken, creds.channelId);
    }

    case 'github': {
      const creds = credentials as GitHubCredentials;
      return new GitHubClient(creds);
    }

    case 'jira':
      throw new Error('Jira profile plugin is not registered');

    case 'confluence': {
      const creds = credentials as ConfluenceCredentials;
      return new ConfluenceClient(creds);
    }

    case 'slack':
      throw new Error('Slack profile plugin is not registered');

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

/**
 * Codes that say the run itself cannot continue rather than that one profile
 * is unhealthy: the hub rejected the token, the network is down, the vault is
 * locked or missing. Anything else is the profile's own problem and belongs in
 * its row, so a single expired credential cannot hide the other twenty.
 */
const SESSION_FAILURES = new Set<ErrorCode>([
  'AUTH_FAILED', 'NETWORK_ERROR', 'CONFIG_ERROR', 'RATE_LIMITED',
  'VAULT_LOCKED', 'VAULT_NOT_CONFIGURED', 'VAULT_CORRUPT',
]);

/** How a per-profile failure reads in its row. */
function failureText(err: unknown): string {
  if (err instanceof CliError) {
    return err.code === 'TOKEN_EXPIRED' ? 'refresh token rejected, re-authenticate' : err.message;
  }
  return err instanceof Error ? err.message : String(err);
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
    if (err instanceof CliError && SESSION_FAILURES.has(err.code)) throw err;
    result = { valid: false, error: failureText(err) };
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
          const where = isRemoteMode()
            ? { hub: hub().url, canManageProfiles: await remoteCanManageProfiles() }
            : { configDir: CONFIG_DIR };
          const output = { version, ...where, services };
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
