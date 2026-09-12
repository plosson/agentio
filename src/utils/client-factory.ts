import { getFreshCredentials } from '../auth/refresh';
import { resolveProfile } from '../config/config-manager';
import { CliError, multipleProfilesError } from './errors';
import type { ServiceName } from '../types/config';

export interface ClientFactoryConfig<TCredentials, TClient> {
  service: ServiceName;
  createClient: (credentials: TCredentials) => TClient;
}

/**
 * Resolve which profile a command runs against. Explicit names must exist; one
 * configured profile selects itself; several require `--profile`.
 */
export async function requireProfile(service: ServiceName, profileName?: string): Promise<string> {
  const result = await resolveProfile(service, profileName);
  if (result.profile !== null) return result.profile;
  if (result.error === 'multiple') throw multipleProfilesError(service, result.names);
  if (profileName) {
    throw new CliError('PROFILE_NOT_FOUND', `Profile "${profileName}" not found for ${service}`, `Run: agentio ${service} profile add`);
  }
  throw new CliError('PROFILE_NOT_FOUND', `No ${service} profile configured`, `Run: agentio ${service} profile add`);
}

/**
 * Creates a type-safe client getter function for a service. Credentials come
 * from getFreshCredentials, so OAuth tokens are refreshed and persisted before
 * the client sees them.
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

  return async (profileName?: string) => {
    const profile = await requireProfile(service, profileName);
    const { credentials } = await getFreshCredentials<TCredentials>(service, profile);
    return { client: createClient(credentials), profile };
  };
}
