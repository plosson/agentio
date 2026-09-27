import { CliError } from '../../utils/errors';
import type { CredentialLifecycle } from '../types';
import { authorizeSpotify } from './oauth';
import type { SpotifyCredentials } from './types';
import { authExpiryStatus } from './types';

export const spotifyCredentialLifecycle: CredentialLifecycle<SpotifyCredentials> = {
  secretFields: ['refreshToken'],
  applies(credentials): credentials is SpotifyCredentials {
    return typeof credentials === 'object'
      && credentials !== null
      && !!(credentials as Partial<SpotifyCredentials>).refreshToken
      && !!(credentials as Partial<SpotifyCredentials>).clientId;
  },
  isStale(credentials, now, bufferMs) {
    return credentials.expiryDate === undefined || now + bufferMs >= credentials.expiryDate;
  },
  async refresh(credentials) {
    // Surface 6-month expiry before calling Spotify, so the message is clear.
    if (authExpiryStatus(credentials.authorizedAt) === 'expired') {
      throw new CliError(
        'AUTH_EXPIRED',
        'Spotify sign-in has expired (Spotify requires signing in again every 6 months).',
        'Re-authenticate with: agentio profile reauth spotify',
      );
    }

    const refreshed = await refreshWithRotation(credentials);
    return refreshed;
  },
};

async function refreshWithRotation(credentials: SpotifyCredentials): Promise<SpotifyCredentials> {
  const { refreshSpotifyToken } = await import('./oauth');
  const result = await refreshSpotifyToken(credentials.clientId, credentials.refreshToken);
  return {
    ...credentials,
    accessToken: result.accessToken,
    // Rotate when Spotify returns a new refresh token; otherwise keep the old one.
    refreshToken: result.refreshToken ?? credentials.refreshToken,
    expiryDate: Date.now() + result.expiresIn * 1000,
    // authorizedAt must NOT change on refresh — the 6-month clock is from first sign-in.
    scopes: result.scopes ?? credentials.scopes,
  };
}

export async function reauthenticateSpotify(
  credentials: SpotifyCredentials | null,
  profileName: string,
  options: { noBrowser?: boolean } = {},
): Promise<SpotifyCredentials> {
  if (!credentials?.clientId) {
    throw new CliError(
      'AUTH_FAILED',
      'Spotify client ID is missing',
      'Re-add the profile: agentio spotify profile add',
    );
  }

  console.error(`\nRe-authenticating spotify / ${profileName}...`);
  const tokens = await authorizeSpotify({
    clientId: credentials.clientId,
    readOnly: credentials.readOnly,
    noBrowser: options.noBrowser,
  });

  const { SpotifyClient } = await import('./client');
  const replacement: SpotifyCredentials = {
    ...credentials,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiryDate: Date.now() + tokens.expiresIn * 1000,
    authorizedAt: new Date().toISOString(),
    scopes: tokens.scopes.length > 0 ? tokens.scopes : credentials.scopes,
  };

  const me = await new SpotifyClient(replacement).me();
  console.error(`  Done (${me.displayName || me.id})`);
  return {
    ...replacement,
    userId: me.id,
    displayName: me.displayName,
  };
}
