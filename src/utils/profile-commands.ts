import { Command } from 'commander';
import { listProfiles, setProfileReadOnly } from '../config/config-manager';
import { getCredentials } from '../auth/token-store';
import { deleteProfile, renameProfile, writeFailure } from '../config/profile-store';
import { handleError, CliError, profileNotFoundError, type ErrorCode } from './errors';
import type { ProfileEntry, ServiceName } from '../types/config';
import { isRemoteMode } from '../auth/remote';
import { findSessionPlugin } from '../plugins/registry';
import { daemonDeleteProfile, daemonRenameProfile } from '../daemon/client';

/**
 * A profile with a session lives in the daemon, so on this machine it is
 * renamed and removed there: the daemon moves or deletes its store and
 * restarts or logs out its session. Remotely, the hub already does that.
 */
const throughDaemon = (service: ServiceName) => !isRemoteMode() && !!findSessionPlugin(service);

/**
 * Shared remove logic used both by the per-service `profile remove` command
 * and by the unified `agentio profile remove <service> <name>` command.
 */
export async function removeProfileForService(service: ServiceName, profileName: string): Promise<void> {
  // Nothing removed has to fail: remotely it also covers a profile the key
  // cannot reach, and a script must not read that as a removal.
  const removed = throughDaemon(service)
    ? (await daemonDeleteProfile(service, profileName)) === 'ok'
    : await deleteProfile(service, profileName);
  if (!removed) throw profileNotFoundError(service, profileName);
  console.log(`Removed profile "${profileName}"`);
}

/**
 * Shared rename logic for the unified `agentio profile rename` and the
 * per-service one. The credentials and every key scope follow the new name.
 */
export async function renameProfileForService(service: ServiceName, from: string, to: string): Promise<void> {
  const outcome = throughDaemon(service) ? await daemonRenameProfile(service, from, to) : await renameProfile(service, from, to);
  const failure = writeFailure(outcome, service, from, to);
  if (failure) throw failure;
  console.log(`Renamed profile "${from}" to "${to}"`);
}

export interface ProfileCommandsOptions<T> {
  service: ServiceName;
  displayName: string;
  getExtraInfo?: (credentials: T | null) => string;
}

/** One row of `<service> profile list`: a profile, what its credentials say about it, or why they could not be read. */
export interface ProfileListing {
  name: string;
  readOnly?: boolean;
  info: string;
  error?: { code: ErrorCode; message: string };
}

/**
 * The rows of `<service> profile list`, sorted by name. `describe` reads what
 * a profile's credentials say about it; when it throws (an expired token the
 * hub cannot refresh, say), that profile carries the error and the others are
 * still described.
 */
export async function listProfileListings(
  profiles: readonly ProfileEntry[],
  describe?: (name: string) => Promise<string>,
): Promise<ProfileListing[]> {
  const sorted = [...profiles].sort((a, b) => a.name.localeCompare(b.name));
  return Promise.all(sorted.map(async ({ name, readOnly }): Promise<ProfileListing> => {
    const base = { name, readOnly };
    if (!describe) return { ...base, info: '' };
    try {
      return { ...base, info: await describe(name) };
    } catch (error) {
      return { ...base, info: '', error: listingError(error) };
    }
  }));
}

function listingError(error: unknown): ProfileListing['error'] {
  if (error instanceof CliError) return { code: error.code, message: error.message };
  return { code: 'UNKNOWN_ERROR', message: error instanceof Error ? error.message : String(error) };
}

export function formatProfileListing(listing: ProfileListing): string {
  const readOnly = listing.readOnly ? ' [read-only]' : '';
  const detail = listing.error ? ` - ERROR ${listing.error.code}: ${listing.error.message}` : listing.info;
  return `${listing.name}${readOnly}${detail}`;
}

/** The error `profile list --strict` exits with when any profile failed, carrying the first failure's code; null when none did. */
export function strictListingFailure(service: ServiceName, listings: readonly ProfileListing[]): CliError | null {
  const failed = listings.filter((listing) => listing.error);
  if (failed.length === 0) return null;
  return new CliError(
    failed[0].error!.code,
    `${failed.length} of ${listings.length} ${service} profiles failed: ${failed.map((listing) => listing.name).join(', ')}`,
    `Run: agentio profile reauth ${service} <name>`,
  );
}

export function createProfileCommands<T>(
  parent: Command,
  options: ProfileCommandsOptions<T>
): Command {
  const { service, displayName, getExtraInfo } = options;

  const profile = parent
    .command('profile')
    .description(`Manage ${displayName} profiles`);

  profile
    .command('list')
    .description(`List ${displayName} profiles; one that fails shows its error and the list goes on`)
    .option('--strict', 'Exit non-zero if any profile failed')
    .action(async (opts: { strict?: boolean }) => {
      try {
        const result = await listProfiles(service);
        const { profiles } = result[0];

        if (profiles.length === 0) {
          console.log(`No ${displayName} profiles configured.`);
          console.log(`Run: agentio ${service} profile add`);
          return;
        }
        const describe = getExtraInfo
          ? async (name: string) => getExtraInfo(await getCredentials<T>(service, name))
          : undefined;
        const listings = await listProfileListings(profiles, describe);
        for (const listing of listings) console.log(formatProfileListing(listing));
        const failure = opts.strict ? strictListingFailure(service, listings) : null;
        if (failure) throw failure;
      } catch (error) {
        handleError(error);
      }
    });

  profile
    .command('update')
    .description(`Update a ${displayName} profile`)
    .requiredOption('--profile <name>', 'Profile name')
    .option('--read-only', 'Set profile as read-only')
    .option('--no-read-only', 'Remove read-only restriction')
    .action(async (opts) => {
      try {
        const profileName = opts.profile;

        // Check if read-only flag is explicitly set or unset
        if (opts.readOnly === undefined) {
          throw new CliError('INVALID_PARAMS', 'No update specified', 'Use --read-only or --no-read-only');
        }

        if (!(await setProfileReadOnly(service, profileName, opts.readOnly))) {
          throw profileNotFoundError(service, profileName);
        }

        if (opts.readOnly) {
          console.log(`Profile "${profileName}" is now read-only`);
        } else {
          console.log(`Profile "${profileName}" read-only restriction removed`);
        }
      } catch (error) {
        handleError(error);
      }
    });

  profile
    .command('rename')
    .description(`Rename a ${displayName} profile`)
    .requiredOption('--profile <name>', 'Current profile name')
    .requiredOption('--to <name>', 'New profile name')
    .action(async (opts) => {
      try {
        await renameProfileForService(service, opts.profile, opts.to);
      } catch (error) {
        handleError(error);
      }
    });

  profile
    .command('remove')
    .description(`Remove a ${displayName} profile`)
    .requiredOption('--profile <name>', 'Profile name')
    .action(async (opts) => {
      try {
        await removeProfileForService(service, opts.profile);
      } catch (error) {
        handleError(error);
      }
    });

  return profile;
}
