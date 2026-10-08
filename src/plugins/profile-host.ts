import { chooseProfileName, saveProfile } from '../config/profile-store';
import type { ProfileAddOptions } from './types';
import { createSetupContext } from './host-context';
import type { RegisteredServicePlugin } from './types';
import type { SetupContext, SetupResult } from '../plugin-sdk';

/**
 * The name a new profile gets: `--profile` when given, else `derived`, made
 * unique the same way for every service. For a plugin that stores its
 * profiles itself, such as through the daemon's pairing.
 */
export function newProfileName(service: string, options: ProfileAddOptions, derived: string): Promise<string> {
  return chooseProfileName(service, { explicit: options.profile, derived, readOnly: options.readOnly });
}

async function persistSetupResult<TCredentials extends object>(
  service: string,
  result: SetupResult<TCredentials>,
  options: ProfileAddOptions,
): Promise<void> {
  const profileName = await newProfileName(service, options, result.suggestedProfileName);
  await saveProfile(service, profileName, result.credentials, { readOnly: options.readOnly });
  console.log(`Profile "${profileName}" configured!`);
  if (result.info) console.log(result.info);
  if (options.readOnly) console.log('Access: read-only');
}

/** Run a plugin's setup in the terminal, then name and save the profile. */
export async function addProfileWithSetup<TCredentials extends object>(
  service: string,
  setup: (options: ProfileAddOptions, context: SetupContext) => Promise<SetupResult<TCredentials>>,
  options: ProfileAddOptions,
): Promise<void> {
  await persistSetupResult(service, await setup(options, createSetupContext()), options);
}

/** Run plugin-owned authentication, then let the host name and persist it. */
export async function addProfileFromPlugin(
  plugin: RegisteredServicePlugin,
  options: ProfileAddOptions,
): Promise<void> {
  if (!plugin.profile) throw new Error(`No profile setup registered for ${plugin.id}`);
  const profile = plugin.profile;
  // The spread gives declarative plugins the open-ended options their setup takes.
  await addProfileWithSetup(plugin.id, (o, context) => profile.setup({ ...o }, context), options);
}

/**
 * Replace an existing profile's credentials, locally or on the hub, for a
 * plugin whose credentials are edited by its own commands, such as `secrets
 * set`. Plugins cannot reach `saveProfile` directly; it keeps the profile's
 * read-only flag because no options are passed.
 */
export function saveProfileCredentials(service: string, profile: string, credentials: object): Promise<void> {
  return saveProfile(service, profile, credentials);
}
