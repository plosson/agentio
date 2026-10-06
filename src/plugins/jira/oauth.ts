import { randomBytes } from 'crypto';
import { URL } from 'url';
import { JIRA_OAUTH_CONFIG } from '../../config/credentials';
import type { SetupContext } from '../../plugin-sdk';
import { getAccessibleResources, selectAtlassianSite } from '../atlassian/sites';

const ATLASSIAN_AUTH_URL = 'https://auth.atlassian.com/authorize';
const ATLASSIAN_TOKEN_URL = 'https://auth.atlassian.com/oauth/token';

const JIRA_SCOPES = [
  'read:jira-work',   // Read projects, issues
  'write:jira-work',  // Add comments, change status
  'read:me',          // Read current user info
  'offline_access',   // Get refresh tokens
];

const OAUTH_PORT = 9999;

export interface JiraOAuthResult {
  accessToken: string;
  refreshToken: string;
  expiryDate: number;
  cloudId: string;
  siteUrl: string;
}

async function exchangeCodeForTokens(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const response = await fetch(ATLASSIAN_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to exchange code for tokens: ${error}`);
  }

  const data = await response.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

export async function refreshJiraToken(
  refreshToken: string
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const response = await fetch(ATLASSIAN_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: JIRA_OAUTH_CONFIG.clientId,
      client_secret: JIRA_OAUTH_CONFIG.clientSecret,
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to refresh token: ${error}`);
  }

  const data = await response.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresIn: data.expires_in,
  };
}

export async function performJiraOAuthFlow(context: SetupContext): Promise<JiraOAuthResult> {
  const state = randomBytes(16).toString('hex');
  const { code, redirectUri } = await context.oauth({
    serviceName: 'Atlassian',
    expectedState: state,
    // Atlassian's app has this one callback registered.
    port: OAUTH_PORT,
    authorizationUrl(redirect) {
      const authUrl = new URL(ATLASSIAN_AUTH_URL);
      authUrl.searchParams.set('audience', 'api.atlassian.com');
      authUrl.searchParams.set('client_id', JIRA_OAUTH_CONFIG.clientId);
      authUrl.searchParams.set('scope', JIRA_SCOPES.join(' '));
      authUrl.searchParams.set('redirect_uri', redirect);
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('prompt', 'consent');
      return authUrl.toString();
    },
  });
  const tokens = await exchangeCodeForTokens(code, JIRA_OAUTH_CONFIG.clientId, JIRA_OAUTH_CONFIG.clientSecret, redirectUri);
  const sites = await getAccessibleResources(tokens.accessToken);
  const selectedSite = await selectAtlassianSite(sites, context, 'Jira');
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiryDate: Date.now() + tokens.expiresIn * 1000,
    cloudId: selectedSite.id,
    siteUrl: selectedSite.url,
  };
}
