import { CliError, noCredentialsError } from '../utils/errors';
import type { ServiceName } from '../types/config';
import type { OAuthTokens, GoogleCamelTokens } from '../types/tokens';
import type { JiraCredentials } from '../types/jira';
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
/** The hub refreshes earlier than a CLI would, so a token it hands out is never one the client wants to refresh itself. */
export const HUB_REFRESH_BUFFER_MS = 10 * 60 * 1000;

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
  /** Fields a remote agent must never receive: what would let it refresh on its own. */
  secretFields: readonly string[];
  /** Whether these particular credentials can be refreshed at all. */
  applies(creds: T): boolean;
  /** Whether the stored credentials are within `bufferMs` of expiring. */
  isStale(creds: T, now: number, bufferMs: number): boolean;
  /** Obtain new credentials; must not persist them. */
  refresh(creds: T): Promise<T>;
}

/** Google and Atlassian record an expiry; a missing one means "never checked", not stale. */
const expiring = (expiry: number | undefined, now: number, buffer: number) =>
  expiry !== undefined && now + buffer >= expiry;
/** Revolut and Dropbox tokens live under a few hours; a missing expiry is treated as stale. */
const shortLived = (expiry: number | undefined, now: number, buffer: number) =>
  expiry === undefined || now + buffer >= expiry;

const googleSnake: Refresher<OAuthTokens> = {
  secretFields: ['refresh_token'],
  applies: (c) => !!c.refresh_token,
  isStale: (c, now, buffer) => expiring(c.expiry_date, now, buffer),
  refresh: (c) => refreshGoogleAccessToken(c),
};

/** Same exchange as googleSnake; only the stored field names differ. */
const googleCamel: Refresher<GoogleCamelTokens> = {
  secretFields: ['refreshToken'],
  applies: (c) => !!c.refreshToken,
  isStale: (c, now, buffer) => expiring(c.expiryDate, now, buffer),
  async refresh(c) {
    const r = await refreshGoogleAccessToken({
      access_token: c.accessToken,
      refresh_token: c.refreshToken,
      expiry_date: c.expiryDate,
      token_type: c.tokenType,
      scope: c.scope,
    });
    return {
      ...c,
      accessToken: r.access_token,
      refreshToken: r.refresh_token,
      expiryDate: r.expiry_date,
      tokenType: r.token_type,
      scope: r.scope,
    };
  },
};

/** Atlassian rotates refresh tokens, so the new one must be kept. Jira and Confluence share the shape. */
function atlassian(
  call: (refreshToken: string) => Promise<{ accessToken: string; refreshToken: string; expiresIn: number }>,
): Refresher<JiraCredentials> {
  return {
    secretFields: ['refreshToken'],
    applies: (c) => !!c.refreshToken,
    isStale: (c, now, buffer) => expiring(c.expiryDate, now, buffer),
    async refresh(c) {
      const r = await call(c.refreshToken);
      return { ...c, accessToken: r.accessToken, refreshToken: r.refreshToken, expiryDate: Date.now() + r.expiresIn * 1000 };
    },
  };
}

const revolut: Refresher<RevolutCredentials> = {
  secretFields: ['refreshToken', 'privateKey'],
  applies: (c) => !!c.refreshToken,
  isStale: (c, now, buffer) => shortLived(c.expiryDate, now, buffer),
  async refresh(c) {
    const r = await refreshRevolutToken(c);
    return { ...c, accessToken: r.accessToken, expiryDate: Date.now() + r.expiresIn * 1000 };
  },
};

const dropbox: Refresher<DropboxCredentials> = {
  secretFields: ['refreshToken'],
  applies: (c) => !!c.refreshToken,
  isStale: (c, now, buffer) => shortLived(c.expiryDate, now, buffer),
  async refresh(c) {
    const r = await refreshDropboxToken(c.appKey, c.refreshToken);
    return { ...c, accessToken: r.accessToken, expiryDate: Date.now() + r.expiresIn * 1000 };
  },
};

const REFRESHERS: Partial<Record<ServiceName, Refresher<unknown>>> = {
  gmail: googleSnake,
  gcal: googleSnake,
  gtasks: googleSnake,
  gdocs: googleCamel,
  gdrive: googleCamel,
  gsheets: googleCamel,
  gslides: googleCamel,
  gscript: googleCamel,
  gchat: googleCamel,
  // Late-bound so the exchange functions resolve through the module at call time.
  jira: atlassian((t) => refreshJiraToken(t)),
  confluence: atlassian((t) => refreshConfluenceToken(t)),
  revolut,
  dropbox,
};

/**
 * The credentials as a remote agent may see them: the refresh material stays on
 * the hub. Services without a refresher hold static secrets, which the hub
 * hands over whole; it is a transparent vault for those.
 */
export function redactForRemote(service: ServiceName, credentials: Record<string, unknown>): Record<string, unknown> {
  const refresher = REFRESHERS[service];
  if (!refresher) return credentials;
  const out = { ...credentials };
  for (const field of refresher.secretFields) delete out[field];
  return out;
}

// One chain per profile: concurrent callers for the same profile wait for the
// refresh in flight instead of each refreshing and clobbering the vault.
// Atlassian's rotating refresh tokens make the double refresh fatal, not just
// wasteful. This serialises within one process only; concurrent CLI
// invocations on the same vault are unchanged and unsupported (see
// docs/design/remote-vault.md). Entries are dropped once idle so the map
// holds neither results nor secrets between calls.
const chains = new Map<string, Promise<void>>();

function serialized<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (chains.get(key) ?? Promise.resolve()).then(task);
  const tail = run.then(() => {}, () => {});
  chains.set(key, tail);
  tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

/**
 * The credentials the local code path expects for `service/profile`, refreshed
 * and written back first when they are stale (or `force` is set). Static
 * services and profiles with nothing to refresh come back as stored. Throws
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
    if (!stored) throw noCredentialsError(service, profile);

    const refresher = REFRESHERS[service] as Refresher<T> | undefined;
    const bufferMs = options.bufferMs ?? REFRESH_BUFFER_MS;
    const wanted = !!refresher && refresher.applies(stored)
      && (options.force || refresher.isStale(stored, Date.now(), bufferMs));
    if (!wanted) return { credentials: stored, refreshed: false };

    let fresh: T;
    try {
      fresh = await refresher!.refresh(stored);
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
