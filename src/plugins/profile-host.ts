import { chooseProfileName, saveProfile } from '../config/profile-store';
import type { ProfileAddOptions } from './types';
import { createSetupContext } from './host-context';
import { isDeclarativePlugin, type RegisteredServicePlugin } from './types';

/** Run plugin-owned authentication, then let the host name and persist it. */
export async function addProfileFromPlugin(
  plugin: RegisteredServicePlugin,
  options: ProfileAddOptions,
): Promise<void> {
  if (!plugin.profile) throw new Error(`No profile setup registered for ${plugin.id}`);
  if (!isDeclarativePlugin(plugin)) {
    await plugin.profile.add(options);
    return;
  }

  const result = await plugin.profile.setup({ ...options }, createSetupContext());
  const profileName = await chooseProfileName(plugin.id, {
    explicit: options.profile,
    derived: result.suggestedProfileName,
    readOnly: options.readOnly,
  });
  await saveProfile(plugin.id, profileName, result.credentials, { readOnly: options.readOnly });
  console.log(`Profile "${profileName}" configured!`);
  if (result.info) console.log(result.info);
  if (options.readOnly) console.log('Access: read-only');
}
