import { getFreshCredentials } from '../../auth/refresh';
import { requireProfile } from '../../utils/client-factory';
import type { ServiceName } from '../../types/config';
import type { OAuthTokens } from './tokens';

/** Resolve a profile and return its refreshed snake-case Google tokens. */
export async function getValidTokens(
  service: ServiceName,
  profileName?: string,
): Promise<{ tokens: OAuthTokens; profile: string }> {
  const profile = await requireProfile(service, profileName);
  const { credentials } = await getFreshCredentials<OAuthTokens>(service, profile);
  return { tokens: credentials, profile };
}
