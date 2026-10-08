import { CliError } from '../../utils/errors';
import type { SetupContext } from '../../plugin-sdk';
import { createSetupContext } from '../host-context';
import type { CredentialLifecycle } from '../types';
import { DropboxClient } from './client';
import { createPkcePair } from '../../auth/pkce';
import { buildAuthorizeUrl, exchangeCodeForTokens, refreshDropboxToken } from './oauth';
import { CODE_INPUT } from './setup-questions';
import type { DropboxCredentials } from './types';

export const dropboxCredentialLifecycle: CredentialLifecycle<DropboxCredentials> = {
  secretFields: ['refreshToken'],
  applies(credentials): credentials is DropboxCredentials {
    return typeof credentials === 'object' && credentials !== null
      && !!(credentials as Partial<DropboxCredentials>).refreshToken;
  },
  isStale(credentials, now, bufferMs) {
    return credentials.expiryDate === undefined || now + bufferMs >= credentials.expiryDate;
  },
  async refresh(credentials) {
    const refreshed = await refreshDropboxToken(credentials.appKey, credentials.refreshToken);
    return { ...credentials, accessToken: refreshed.accessToken, expiryDate: Date.now() + refreshed.expiresIn * 1000 };
  },
};

export async function reauthenticateDropbox(
  credentials: DropboxCredentials | null,
  profileName: string,
  context: SetupContext = createSetupContext(),
): Promise<DropboxCredentials> {
  if (!credentials?.appKey) throw new CliError('AUTH_FAILED', 'Dropbox app key is missing');
  context.log(`\nRe-authenticating dropbox / ${profileName}...`);
  const { verifier, challenge } = createPkcePair();
  const authUrl = buildAuthorizeUrl(credentials.appKey, challenge);
  context.log(`  ${authUrl}\n`);
  context.openUrl(authUrl);
  const code = (await context.ask(CODE_INPUT)).trim();
  if (!code) throw new CliError('INVALID_PARAMS', 'Authorisation code is required');
  const tokens = await exchangeCodeForTokens(code, credentials.appKey, verifier);
  const replacement: DropboxCredentials = {
    ...credentials,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiryDate: Date.now() + tokens.expiresIn * 1000,
    accountId: tokens.accountId ?? credentials.accountId,
  };
  const account = await new DropboxClient(replacement).account();
  context.log(`  Done (${account.email})`);
  return { ...replacement, accountId: account.accountId, email: account.email, name: account.name };
}
