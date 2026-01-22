import { URL } from 'url';
import { JIRA_OAUTH_CONFIG } from '../config/credentials';
import { startOAuthCallbackServer, launchBrowser } from './oauth-server';

const ATLASSIAN_AUTH_URL = 'https://auth.atlassian.com/authorize';
const ATLASSIAN_TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const ATLASSIAN_RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';

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

export interface AtlassianSite {
  id: string;
  url: string;
  name: string;
  scopes: string[];
  avatarUrl?: string;
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

async function getAccessibleResources(accessToken: string): Promise<AtlassianSite[]> {
  const response = await fetch(ATLASSIAN_RESOURCES_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get accessible resources: ${error}`);
  }

  return response.json();
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

export async function performJiraOAuthFlow(
  selectSite?: (sites: AtlassianSite[]) => Promise<AtlassianSite>
): Promise<JiraOAuthResult> {
  const redirectUri = `http://localhost:${OAUTH_PORT}/callback`;
  const state = Math.random().toString(36).substring(2);

  const authUrl = new URL(ATLASSIAN_AUTH_URL);
  authUrl.searchParams.set('audience', 'api.atlassian.com');
  authUrl.searchParams.set('client_id', JIRA_OAUTH_CONFIG.clientId);
  authUrl.searchParams.set('scope', JIRA_SCOPES.join(' '));
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('prompt', 'consent');

  // Start callback server and browser in parallel
  const callbackPromise = startOAuthCallbackServer({
    port: OAUTH_PORT,
    serviceName: 'Atlassian',
    expectedState: state,
  });

  console.error(`\nOpening browser for Atlassian authorization...`);
  console.error(`If browser doesn't open, visit:\n${authUrl.toString()}\n`);
  launchBrowser(authUrl.toString());

  // Wait for the callback with the authorization code
  const { code } = await callbackPromise;

  // Exchange code for tokens
  const tokens = await exchangeCodeForTokens(code, JIRA_OAUTH_CONFIG.clientId, JIRA_OAUTH_CONFIG.clientSecret, redirectUri);

  // Get accessible resources to find cloud ID
  const sites = await getAccessibleResources(tokens.accessToken);

  if (sites.length === 0) {
    throw new Error('No accessible Jira sites found. Make sure your app has the correct permissions.');
  }

  // Let user select site if multiple, otherwise use the first one
  let selectedSite: AtlassianSite;
  if (sites.length === 1) {
    selectedSite = sites[0];
  } else if (selectSite) {
    selectedSite = await selectSite(sites);
  } else {
    selectedSite = sites[0];
  }

  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiryDate: Date.now() + tokens.expiresIn * 1000,
    cloudId: selectedSite.id,
    siteUrl: selectedSite.url,
  };
}
