import { getCredentials } from '../auth/token-store';
import { getProfile } from '../config/config-manager';
import { CliError } from './errors';
import type { ServiceName } from '../types/config';

export interface ClientFactoryConfig<TCredentials, TClient> {
  service: ServiceName;
  createClient: (credentials: TCredentials) => TClient;
}

/**
 * Creates a type-safe client getter function for a service.
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
): (profileName: string) => Promise<{ client: TClient; profile: string }> {
  const { service, createClient } = config;

  return async (profileName: string): Promise<{ client: TClient; profile: string }> => {
    const profile = await getProfile(service, profileName);

    if (!profile) {
      throw new CliError(
        'PROFILE_NOT_FOUND',
        `Profile "${profileName}" not found for ${service}`,
        `Run: agentio ${service} profile add`
      );
    }

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
