import { CliError } from '../utils/errors';
import type { ServiceName } from '../types/config';
import type { OAuthTokens } from '../types/tokens';
import type { JiraCredentials } from '../types/jira';
import type { ConfluenceCredentials } from '../types/confluence';
import type { RevolutCredentials } from '../types/revolut';
import type { DropboxCredentials } from '../types/dropbox';
import { getCredentials, setCredentials } from './token-store';
import { refreshGoogleAccessToken } from './token-manager';
import { refreshJiraToken } from './jira-oauth';
import { refreshConfluenceToken } from './confluence-oauth';
import { refreshRevolutToken } from './revolut-oauth';
import { refreshDropboxToken } from './dropbox-oauth';

/** Refresh when the access token has less than this left. */
export const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export interface FreshCredentials<T = Record<string, unknown>> {
  credentials: T;
  /** True when this call performed a refresh and wrote the vault. */
  refreshed: boolean;
}

export interface RefreshOptions {
  /** Override the expiry buffer; a long-lived hub uses a wider one than a CLI. */
  bufferMs?: number;
  /** Refresh even if the token looks fresh, e.g. after a validation failure. */
  force?: boolean;
}

interface Refresher<T> {
  /** Whether the stored credentials are within `bufferMs` of expiring. */
  isStale(creds: T, now: number, bufferMs: number): boolean;
  /** Obtain new credentials; must not persist them. */
  refresh(creds: T): Promise<T>;
}

/** Google credentials as the Gmail/Calendar/Tasks clients store them. */
type GoogleSnake = OAuthTokens;
/** Google credentials as the Docs/Drive/Sheets/Slides/Script/Chat clients store them. */
interface GoogleCamel {
  accessToken: string;
  refreshToken?: string;
  expiryDate?: number;
  tokenType: string;
  scope?: string;
}

const googleSnake: Refresher<GoogleSnake> = {
  isStale: (c, now, buffer) => !!c.expiry_date && now > c.expiry_date - buffer,
  async refresh(c) {
    if (!c.refresh_token) throw new Error('no refresh token stored');
    const r = await refreshGoogleAccessToken(c.refresh_token);
    return {
      ...c,
      access_token: r.accessToken,
      refresh_token: r.refreshToken ?? c.refresh_token,
      expiry_date: r.expiryDate,
      token_type: r.tokenType,
      scope: r.scope ?? c.scope,
    };
  },
};

const googleCamel: Refresher<GoogleCamel> = {
  isStale: (c, now, buffer) => !!c.expiryDate && now > c.expiryDate - buffer,
  async refresh(c) {
    if (!c.refreshToken) throw new Error('no refresh token stored');
    const r = await refreshGoogleAccessToken(c.refreshToken);
    return {
      ...c,
      accessToken: r.accessToken,
      refreshToken: r.refreshToken ?? c.refreshToken,
      expiryDate: r.expiryDate,
      tokenType: r.tokenType,
      scope: r.scope ?? c.scope,
    };
  },
};

/** Atlassian rotates refresh tokens, so the new one must be kept. */
function atlassian<T extends { refreshToken: string; expiryDate: number }>(
  call: (refreshToken: string) => Promise<{ accessToken: string; refreshToken: string; expiresIn: number }>,
): Refresher<T> {
  return {
    isStale: (c, now, buffer) => !!c.expiryDate && now + buffer >= c.expiryDate,
    async refresh(c) {
      const r = await call(c.refreshToken);
      return { ...c, accessToken: r.accessToken, refreshToken: r.refreshToken, expiryDate: Date.now() + r.expiresIn * 1000 };
    },
  };
}

/** Short-lived tokens with no stored expiry are treated as stale. */
const revolut: Refresher<RevolutCredentials> = {
  isStale: (c, now, buffer) => !c.expiryDate || now + buffer >= c.expiryDate,
  async refresh(c) {
    const r = await refreshRevolutToken(c);
    return { ...c, accessToken: r.accessToken, expiryDate: Date.now() + r.expiresIn * 1000 };
  },
};

const dropbox: Refresher<DropboxCredentials> = {
  isStale: (c, now, buffer) => !c.expiryDate || now + buffer >= c.expiryDate,
  async refresh(c) {
    const r = await refreshDropboxToken(c.appKey, c.refreshToken);
    return { ...c, accessToken: r.accessToken, expiryDate: Date.now() + r.expiresIn * 1000 };
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const REFRESHERS: Partial<Record<ServiceName, Refresher<any>>> = {
  gmail: googleSnake,
  gcal: googleSnake,
  gtasks: googleSnake,
  gdocs: googleCamel,
  gdrive: googleCamel,
  gsheets: googleCamel,
  gslides: googleCamel,
  gscript: googleCamel,
  gchat: googleCamel,
  jira: atlassian<JiraCredentials>(refreshJiraToken),
  confluence: atlassian<ConfluenceCredentials>(refreshConfluenceToken),
  revolut,
  dropbox,
};

/** Services whose credentials can be refreshed at all (the rest are static secrets). */
export function canRefresh(service: ServiceName): boolean {
  return service in REFRESHERS;
}

// One chain per profile: concurrent callers for the same profile wait for the
// refresh in flight instead of each refreshing and clobbering the vault.
// Atlassian's rotating refresh tokens make the double refresh fatal, not just
// wasteful. The daemon is a single process and the sole writer, so an
// in-process chain is sufficient.
const chains = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  chains.set(key, run.catch(() => {}));
  return run;
}

/**
 * The credentials the local code path expects for `service/profile`, refreshed
 * and written back first when they are stale (or `force` is set). Throws
 * AUTH_FAILED when the profile has no credentials and TOKEN_EXPIRED when a
 * refresh is needed but fails; both mean re-authenticate.
 */
export function getFreshCredentials<T = Record<string, unknown>>(
  service: ServiceName,
  profile: string,
  options: RefreshOptions = {},
): Promise<FreshCredentials<T>> {
  return serialized(`${service}/${profile}`, async () => {
    const stored = await getCredentials<T>(service, profile);
    if (!stored) {
      throw new CliError(
        'AUTH_FAILED',
        `No credentials found for ${service} profile "${profile}"`,
        `Run: agentio ${service} profile add --profile ${profile}`,
      );
    }

    const refresher = REFRESHERS[service] as Refresher<T> | undefined;
    const bufferMs = options.bufferMs ?? REFRESH_BUFFER_MS;
    if (!refresher || (!options.force && !refresher.isStale(stored, Date.now(), bufferMs))) {
      return { credentials: stored, refreshed: false };
    }

    let fresh: T;
    try {
      fresh = await refresher.refresh(stored);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new CliError(
        'TOKEN_EXPIRED',
        `Token refresh failed for ${service} profile "${profile}": ${reason}`,
        `Re-authenticate with: agentio ${service} profile add --profile ${profile}`,
      );
    }
    await setCredentials(service, profile, fresh as object);
    return { credentials: fresh, refreshed: true };
  });
}
