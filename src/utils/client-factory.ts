import { getCredentials } from '../auth/token-store';
import { resolveProfile } from '../config/config-manager';
import { CliError, multipleProfilesError } from './errors';
import type { ServiceName } from '../types/config';

export interface ClientFactoryConfig<TCredentials, TClient> {
  service: ServiceName;
  createClient: (credentials: TCredentials) => TClient;
}

/**
 * Creates a type-safe client getter function for a service.
 * Profile is optional - if only one profile exists, it will be used automatically.
 *
 * Usage:
 * ```typescript
 * const getSlackClient = createClientGetter<SlackCredentials, SlackClient>({
 *   service: 'slack',
 *   createClient: (credentials) => new SlackClient(credentials),
 * });
 * ```
 */
export function createClientGetter<TCredentials, TClient>(
  config: ClientFactoryConfig<TCredentials, TClient>
): (profileName?: string) => Promise<{ client: TClient; profile: string }> {
  const { service, createClient } = config;

  return async (profileName?: string): Promise<{ client: TClient; profile: string }> => {
    const profileResult = await resolveProfile(service, profileName);

    if (profileResult.profile === null) {
      if (profileResult.error === 'none') {
        if (profileName) {
          throw new CliError('PROFILE_NOT_FOUND', `Profile "${profileName}" not found for ${service}`, `Run: agentio ${service} profile add`);
        }
        throw new CliError('PROFILE_NOT_FOUND', `No ${service} profile configured`, `Run: agentio ${service} profile add`);
      }
      throw multipleProfilesError(service, profileResult.names);
    }

    const profile = profileResult.profile;

    const credentials = await getCredentials<TCredentials>(service, profile);

    if (!credentials) {
      throw new CliError(
        'AUTH_FAILED',
        `No credentials found for ${service} profile "${profile}"`,
        `Run: agentio ${service} profile add --profile ${profile}`
      );
    }

    return {
      client: createClient(credentials),
      profile,
    };
  };
}
