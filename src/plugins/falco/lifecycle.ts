import type { SetupContext } from '../../plugin-sdk';
import { CliError } from '../../utils/errors';
import type { CredentialLifecycle } from '../types';
import { loginWithSecondFactor, refreshFalcoToken, revokeFalcoToken } from './auth';
import { FalcoClient } from './client';
import { FALCO_PASSWORD_INPUT } from './setup-questions';
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
  context: SetupContext,
): Promise<FalcoCredentials> {
  if (!credentials) {
    throw new CliError(
      'AUTH_FAILED',
      `Profile "${profileName}" has no stored Falco credentials`,
      `Run: agentio falco profile add --profile ${profileName}`,
    );
  }

  context.log(`\nRe-authenticating falco / ${profileName} (${credentials.userEmail})`);
  const password = await context.ask(FALCO_PASSWORD_INPUT);
  const tokens = await loginWithSecondFactor(credentials.userEmail, password, context);

  const now = Date.now();
  // refreshToken is a secret field: a remote sign-in again receives these
  // credentials without it, so every token is taken from the new login.
  const replacement: FalcoCredentials = {
    ...credentials,
    accessToken: tokens.accessToken,
    expiryDate: now + tokens.expiresIn * 1000,
    refreshToken: tokens.refreshToken,
    refreshExpiryDate: now + tokens.refreshTokenExpiresIn * 1000,
  };

  const client = new FalcoClient(replacement);
  const validation = await client.validate();
  if (!validation.valid) {
    // Covers a revoked membership as well as bad credentials: validate() fails
    // when the stored organization is no longer on the account.
    throw new CliError('AUTH_FAILED', `Could not use this profile: ${validation.error}`);
  }

  // Pick up a renamed organization rather than keeping a stale label.
  const me = await client.getUserMe();
  const organization = me.organizations.find((org) => org.id === replacement.organizationId);
  if (organization) replacement.organizationName = organization.name;

  // The replacement works, so the token it supersedes is now orphaned and
  // would otherwise stay valid on Falco's servers for its full lifetime.
  // Revoked only after validation, so a failed reauth leaves the old one usable.
  // A remote sign-in again has no old token to revoke; the hub holds it.
  if (credentials.refreshToken) await revokeFalcoToken(credentials.refreshToken);

  context.log(`  Done (${validation.info})`);
  return replacement;
}
