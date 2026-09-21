import { CliError } from '../../utils/errors';
import type { CredentialLifecycle } from '../types';
import { loginToFalco, refreshFalcoToken } from './auth';
import { FalcoClient } from './client';
import { promptPassword, promptText } from './prompts';
import type { FalcoCredentials } from './types';

export const falcoCredentialLifecycle: CredentialLifecycle<FalcoCredentials> = {
  // Withholding the refresh token is what stops a remote agent minting its own
  // access tokens; the hub refreshes on its behalf.
  secretFields: ['refreshToken'],

  applies(credentials): credentials is FalcoCredentials {
    return (
      typeof credentials === 'object' &&
      credentials !== null &&
      !!(credentials as Partial<FalcoCredentials>).refreshToken
    );
  },

  // Falco access tokens live well under an hour, and a missing expiry means we
  // have never exchanged one — either way, refresh before using them.
  isStale(credentials, now, bufferMs) {
    return credentials.expiryDate === undefined || now + bufferMs >= credentials.expiryDate;
  },

  async refresh(credentials) {
    if (Date.now() >= credentials.refreshExpiryDate) {
      throw new CliError(
        'TOKEN_EXPIRED',
        'The Falco refresh token has expired',
        'Run: agentio reauth',
      );
    }
    const tokens = await refreshFalcoToken(credentials.refreshToken);
    const now = Date.now();
    return {
      ...credentials,
      accessToken: tokens.accessToken,
      expiryDate: now + tokens.expiresIn * 1000,
      // Falco rotates the refresh token on every exchange; losing this write
      // loses the session.
      refreshToken: tokens.refreshToken,
      refreshExpiryDate: now + tokens.refreshTokenExpiresIn * 1000,
    };
  },
};

/**
 * Re-authenticate an existing profile. The organization is already known, so
 * this asks only for the password (and a 2FA code when Falco wants one) and
 * keeps everything else about the profile as it was.
 */
export async function reauthenticateFalco(
  credentials: FalcoCredentials | null,
  profileName: string,
): Promise<FalcoCredentials> {
  if (!credentials) {
    throw new CliError(
      'AUTH_FAILED',
      `Profile "${profileName}" has no stored Falco credentials`,
      `Run: agentio falco profile add --profile ${profileName}`,
    );
  }

  console.error(`\nRe-authenticating falco / ${profileName} (${credentials.userEmail})`);
  const password = await promptPassword('? Password: ');
  if (!password) throw new CliError('AUTH_FAILED', 'A password is required');

  let result = await loginToFalco({ username: credentials.userEmail, password });
  if (result.type === 'two_factor_required') {
    const code = await promptText('? Two-factor code: ');
    result = await loginToFalco({ username: credentials.userEmail, password, twoFaCode: code });
  }
  if (result.type !== 'success') {
    throw new CliError('AUTH_FAILED', 'Falco asked for a two-factor code that was not supplied');
  }

  const now = Date.now();
  const replacement: FalcoCredentials = {
    ...credentials,
    accessToken: result.tokens.accessToken,
    expiryDate: now + result.tokens.expiresIn * 1000,
    refreshToken: result.tokens.refreshToken,
    refreshExpiryDate: now + result.tokens.refreshTokenExpiresIn * 1000,
  };

  const validation = await new FalcoClient(replacement).validate();
  if (!validation.valid) {
    throw new CliError('AUTH_FAILED', `Could not read the account: ${validation.error}`);
  }
  console.error(`  Done (${validation.info})`);
  return replacement;
}
