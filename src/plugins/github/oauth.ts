import { randomBytes } from 'crypto';
import { URL } from 'url';
import { GITHUB_OAUTH_CONFIG } from '../../config/credentials';
import { CliError } from '../../utils/errors';
import type { SetupContext } from '../../plugin-sdk';

const GITHUB_SCOPES = ['repo'];

export interface GitHubOAuthResult {
  accessToken: string;
}

export async function performGitHubOAuthFlow(context: SetupContext): Promise<GitHubOAuthResult> {
  const state = randomBytes(16).toString('hex');

  const { code, redirectUri } = await context.oauth({
    serviceName: 'GitHub',
    expectedState: state,
    authorizationUrl: (redirect) => {
      const authUrl = new URL('https://github.com/login/oauth/authorize');
      authUrl.searchParams.set('client_id', GITHUB_OAUTH_CONFIG.clientId);
      authUrl.searchParams.set('redirect_uri', redirect);
      authUrl.searchParams.set('scope', GITHUB_SCOPES.join(' '));
      authUrl.searchParams.set('state', state);
      return authUrl.toString();
    },
  });

  // Exchange code for access token
  const tokenResponse = await context.fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: GITHUB_OAUTH_CONFIG.clientId,
      client_secret: GITHUB_OAUTH_CONFIG.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  const tokenData = await tokenResponse.json() as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (tokenData.error || !tokenData.access_token) {
    throw new CliError(
      'AUTH_FAILED',
      tokenData.error_description || tokenData.error || 'Failed to get access token',
      'Try again: agentio github profile add',
    );
  }

  return {
    accessToken: tokenData.access_token,
  };
}
