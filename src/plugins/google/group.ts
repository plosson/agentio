import { getCredentials, setCredentials } from '../../auth/token-store';
import { getProfile, profileRef } from '../../config/config-manager';
import { saveProfiles, validateProfileName } from '../../config/profile-store';
import { CliError } from '../../utils/errors';
import { interactiveCheckbox, interactiveConfirm, isInteractive } from '../../utils/interactive';
import { missingScopes, performOAuthFlow, type OAuthService } from './oauth';
import { assertSameAccount } from './shared';
import { GOOGLE_SUITE, type GoogleSuiteEntry, type GrantContext, type StoredGoogleCredentials } from './suite';
import { fetchGoogleUserEmail } from './token-manager';
import type { OAuthTokens } from './tokens';

/**
 * One Google consent for several services: adding profiles for them, and
 * (in reauth) renewing those of one account together.
 */

export interface GoogleAddOptions {
  services?: string[];
  profile?: string;
  readOnly?: boolean;
  force?: boolean;
}

/** What the flow reaches outside the process through; tests replace all of it. */
export interface GoogleGrantDeps {
  performOAuth?: typeof performOAuthFlow;
  fetchEmail?: typeof fetchGoogleUserEmail;
  chooseServices?: (services: string[]) => Promise<string[]>;
  confirmReplace?: (refs: string[]) => Promise<boolean>;
  interactive?: () => boolean;
  suite?: readonly GoogleSuiteEntry[];
}

const chooseServicesPrompt = (services: string[]) => interactiveCheckbox({
  message: 'Google services to set up:',
  choices: services.map((service) => ({ name: service, value: service, checked: true })),
  required: true,
});

const confirmReplacePrompt = (refs: string[]) => interactiveConfirm({
  message: `Will replace: ${refs.join(', ')}. Continue?`,
  default: false,
});

/** How a service reads in progress messages: Drive says which access it gets. */
export function grantLabel(entry: GoogleSuiteEntry, key: OAuthService): string {
  if (key === 'gdrive-full') return `${entry.service} (full)`;
  if (key === 'gdrive-readonly') return `${entry.service} (read-only)`;
  return entry.service;
}

/** Why a grant cannot serve this service, or undefined when it can. */
export async function unusableReason(entry: GoogleSuiteEntry, key: OAuthService, tokens: OAuthTokens): Promise<string | undefined> {
  const missing = missingScopes([key], tokens.scope);
  if (missing.length > 0) return `Google did not grant ${missing.join(', ')}`;
  try {
    await entry.verify?.(tokens);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

export async function fetchAccountEmail(tokens: OAuthTokens, fetchEmail: typeof fetchGoogleUserEmail): Promise<string> {
  try {
    return await fetchEmail(tokens.access_token);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new CliError('AUTH_FAILED', `Failed to fetch user email: ${errorMessage}`, 'Ensure the account has an email address');
  }
}

async function pickEntries(
  suite: readonly GoogleSuiteEntry[],
  requested: string[] | undefined,
  interactive: boolean,
  choose: (services: string[]) => Promise<string[]>,
): Promise<GoogleSuiteEntry[]> {
  const known: string[] = suite.map((entry) => entry.service);
  if (requested === undefined && !interactive) {
    throw new CliError('INVALID_PARAMS', 'No Google services given: pass --services', `For example --services ${known.join(',')}`);
  }
  const wanted = requested ?? (await choose(known));
  const unknown = wanted.filter((service) => !known.includes(service));
  if (unknown.length > 0) {
    throw new CliError('INVALID_PARAMS', `Unknown Google service: ${unknown.join(', ')}`, `Choose from: ${known.join(', ')}`);
  }
  const picked = suite.filter((entry) => wanted.includes(entry.service));
  if (picked.length === 0) {
    throw new CliError('INVALID_PARAMS', 'No Google service selected', `Choose from: ${known.join(', ')}`);
  }
  return picked;
}

/** Add one profile per chosen Google service, all from a single consent. Returns what was saved. */
export async function addGoogleProfiles(options: GoogleAddOptions, deps: GoogleGrantDeps = {}): Promise<string[]> {
  const suite = deps.suite ?? GOOGLE_SUITE;
  const interactive = (deps.interactive ?? isInteractive)();
  if (options.profile !== undefined) validateProfileName(options.profile);

  const entries = await pickEntries(suite, options.services, interactive, deps.chooseServices ?? chooseServicesPrompt);
  const context: GrantContext = { readOnly: options.readOnly };
  const keys = entries.map((entry) => entry.scopeKey(context));
  console.error(`Requesting access for: ${entries.map((entry, i) => grantLabel(entry, keys[i]!)).join(', ')}\n`);

  const tokens = await (deps.performOAuth ?? performOAuthFlow)(keys);
  const email = await fetchAccountEmail(tokens, deps.fetchEmail ?? fetchGoogleUserEmail);

  const usable: GoogleSuiteEntry[] = [];
  for (const [i, entry] of entries.entries()) {
    const reason = await unusableReason(entry, keys[i]!, tokens);
    if (reason) console.error(`Skipped ${entry.service}: ${reason}`);
    else usable.push(entry);
  }
  if (usable.length === 0) {
    throw new CliError('AUTH_FAILED', 'Google granted none of the requested services', 'Run the command again and leave every permission ticked');
  }

  const name = options.profile ?? email;
  const taken: string[] = [];
  for (const entry of usable) if (await getProfile(entry.service, name)) taken.push(profileRef(entry.service, name));
  if (taken.length > 0 && !options.force) {
    if (!interactive) {
      throw new CliError('INVALID_PARAMS', `Profiles already exist: ${taken.join(', ')}`, 'Pass --force to replace them, or --profile to choose another name');
    }
    if (!(await (deps.confirmReplace ?? confirmReplacePrompt)(taken))) {
      console.error('Cancelled. Nothing was saved.');
      return [];
    }
  }

  await saveProfiles(
    usable.map((entry) => ({ service: entry.service, name, credentials: entry.toCredentials(tokens, email, context) })),
    { readOnly: options.readOnly },
  );
  for (const entry of usable) console.log(`Profile "${name}" configured for ${entry.service}`);
  return usable.map((entry) => profileRef(entry.service, name));
}

interface GroupMember<T> {
  status: T;
  entry: GoogleSuiteEntry;
  existing: StoredGoogleCredentials;
}

/**
 * Renew the selected Google profiles of one account with one consent each.
 * A profile joins a group when its service is a Google one and its stored
 * credentials name an account; a group needs two. Everything else comes back,
 * in order, for the one-at-a-time path.
 */
export async function reauthGoogleGroups<T extends { service: string; profile: string }>(
  selected: readonly T[],
  deps: GoogleGrantDeps = {},
): Promise<T[]> {
  const suite = deps.suite ?? GOOGLE_SUITE;
  const groups = new Map<string, GroupMember<T>[]>();
  for (const status of selected) {
    const entry = suite.find((e) => e.service === status.service);
    if (!entry) continue;
    let existing: StoredGoogleCredentials | null | undefined;
    try {
      existing = await getCredentials<StoredGoogleCredentials>(status.service, status.profile);
    } catch {
      continue; // left for the one-by-one path, which reports its own error
    }
    if (!existing || typeof existing.email !== 'string' || !existing.email) continue;
    const account = existing.email.toLowerCase();
    groups.set(account, [...(groups.get(account) ?? []), { status, entry, existing }]);
  }

  const handled = new Set<T>();
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    for (const member of members) handled.add(member.status);
    try {
      await renewGroup(members, deps);
    } catch (error) {
      const account = members[0]!.existing.email as string;
      console.error(`\n  Failed to reauth ${account}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return selected.filter((status) => !handled.has(status));
}

async function renewGroup<T extends { service: string; profile: string }>(members: GroupMember<T>[], deps: GoogleGrantDeps): Promise<void> {
  const account = members[0]!.existing.email as string;
  const keys = members.map((m) => m.entry.scopeKey({ existing: m.existing }));
  console.error(`\nRe-authenticating ${account} for: ${members.map((m, i) => grantLabel(m.entry, keys[i]!)).join(', ')}...`);

  const tokens = await (deps.performOAuth ?? performOAuthFlow)(keys);
  const email = await fetchAccountEmail(tokens, deps.fetchEmail ?? fetchGoogleUserEmail);
  assertSameAccount(account, email);

  for (const [i, m] of members.entries()) {
    const reason = await unusableReason(m.entry, keys[i]!, tokens);
    if (reason) {
      console.error(`\n  Failed to reauth ${m.status.service} / ${m.status.profile}: ${reason}`);
      continue;
    }
    await setCredentials(m.status.service, m.status.profile, m.entry.toCredentials(tokens, email, { existing: m.existing }));
    console.error(`  Done: ${m.status.service} / ${m.status.profile}`);
  }
}
