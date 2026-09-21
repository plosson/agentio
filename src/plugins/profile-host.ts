import { chooseProfileName, saveProfile } from '../config/profile-store';
import type { ProfileAddOptions } from './types';
import { createSetupContext } from './host-context';
import { isDeclarativePlugin, type RegisteredServicePlugin } from './types';
import type { SetupResult } from '../plugin-sdk';

async function persistSetupResult<TCredentials extends object>(
  service: string,
  result: SetupResult<TCredentials>,
  options: ProfileAddOptions,
): Promise<void> {
  const profileName = await chooseProfileName(service, {
    explicit: options.profile,
    derived: result.suggestedProfileName,
    readOnly: options.readOnly,
  });
  await saveProfile(service, profileName, result.credentials, { readOnly: options.readOnly });
  console.log(`Profile "${profileName}" configured!`);
  if (result.info) console.log(result.info);
  if (options.readOnly) console.log('Access: read-only');
}

/** Compatibility bridge for in-tree Commander plugins during migration. */
export async function addProfileWithSetup<TCredentials extends object>(
  service: string,
  setup: (options: ProfileAddOptions) => Promise<SetupResult<TCredentials>>,
  options: ProfileAddOptions,
): Promise<void> {
  await persistSetupResult(service, await setup(options), options);
}

/** Run plugin-owned authentication, then let the host name and persist it. */
export async function addProfileFromPlugin(
  plugin: RegisteredServicePlugin,
  options: ProfileAddOptions,
): Promise<void> {
  if (!plugin.profile) throw new Error(`No profile setup registered for ${plugin.id}`);
  if (!isDeclarativePlugin(plugin) && !plugin.profile.setup) {
    if (!plugin.profile.add) throw new Error(`No profile setup registered for ${plugin.id}`);
    await plugin.profile.add(options);
    return;
  }

  const result = isDeclarativePlugin(plugin)
    ? await plugin.profile.setup({ ...options }, createSetupContext())
    : await plugin.profile.setup!(options);
  await persistSetupResult(plugin.id, result, options);
}
