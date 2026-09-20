import { launchBrowser } from '../../auth/oauth-server';
import { CliError } from '../../utils/errors';
import { prompt } from '../../utils/stdin';
import type { CredentialLifecycle } from '../types';
import { RevolutClient } from './client';
import { buildConsentUrl, exchangeCodeForTokens, extractAuthorizationCode, refreshRevolutToken } from './oauth';
import type { RevolutCredentials } from './types';

export const revolutCredentialLifecycle: CredentialLifecycle<RevolutCredentials> = {
  secretFields: ['refreshToken', 'privateKey'],
  applies(credentials): credentials is RevolutCredentials {
    return typeof credentials === 'object' && credentials !== null
      && !!(credentials as Partial<RevolutCredentials>).refreshToken;
  },
  isStale(credentials, now, bufferMs) {
    return credentials.expiryDate === undefined || now + bufferMs >= credentials.expiryDate;
  },
  async refresh(credentials) {
    const refreshed = await refreshRevolutToken(credentials);
    return { ...credentials, accessToken: refreshed.accessToken, expiryDate: Date.now() + refreshed.expiresIn * 1000 };
  },
};

export async function reauthenticateRevolut(
  credentials: RevolutCredentials | null,
  profileName: string,
): Promise<RevolutCredentials> {
  if (!credentials) throw new CliError('AUTH_FAILED', 'Revolut client configuration is missing');
  console.error(`\nRe-authenticating revolut / ${profileName}...`);
  const consentUrl = buildConsentUrl(credentials);
  console.error(`  ${consentUrl}\n`);
  launchBrowser(consentUrl);
  const code = extractAuthorizationCode(await prompt('? Paste the redirect URL (or just the code): '));
  const tokens = await exchangeCodeForTokens(code, credentials);
  const replacement: RevolutCredentials = {
    ...credentials,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiryDate: Date.now() + tokens.expiresIn * 1000,
  };
  const validation = await new RevolutClient(replacement).validate();
  if (!validation.valid) throw new CliError('AUTH_FAILED', `Could not read accounts: ${validation.error}`);
  console.error(`  Done (${validation.info ?? credentials.environment})`);
  return replacement;
}
