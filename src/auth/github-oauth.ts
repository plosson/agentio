import { URL } from 'url';
import { GITHUB_OAUTH_CONFIG } from '../config/credentials';
import { findAvailablePort, startOAuthCallbackServer, launchBrowser } from './oauth-server';

const GITHUB_SCOPES = ['repo'];

export interface GitHubOAuthResult {
  accessToken: string;
}

export async function performGitHubOAuthFlow(): Promise<GitHubOAuthResult> {
  const port = await findAvailablePort();
  const redirectUri = `http://localhost:${port}/callback`;
  const state = Math.random().toString(36).substring(7);

  const authUrl = new URL('https://github.com/login/oauth/authorize');
  authUrl.searchParams.set('client_id', GITHUB_OAUTH_CONFIG.clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', GITHUB_SCOPES.join(' '));
  authUrl.searchParams.set('state', state);

  // Start callback server and browser in parallel
  const callbackPromise = startOAuthCallbackServer({
    port,
    serviceName: 'GitHub',
    expectedState: state,
  });

  console.error(`\nOpening browser for GitHub authorization...`);
  console.error(`If browser doesn't open, visit:\n${authUrl.toString()}\n`);
  launchBrowser(authUrl.toString());

  // Wait for the callback with the authorization code
  const { code } = await callbackPromise;

  // Exchange code for access token
  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
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
    throw new Error(tokenData.error_description || tokenData.error || 'Failed to get access token');
  }

  return {
    accessToken: tokenData.access_token,
  };
}
