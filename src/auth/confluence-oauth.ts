import { URL } from 'url';
import { ATLASSIAN_OAUTH_CONFIG } from '../config/credentials';
import { startOAuthCallbackServer, launchBrowser } from './oauth-server';

const ATLASSIAN_AUTH_URL = 'https://auth.atlassian.com/authorize';
const ATLASSIAN_TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const ATLASSIAN_RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';

// Granular Confluence scopes (v2 API). Requires the Atlassian app to have
// these scopes enabled in the developer console.
const CONFLUENCE_SCOPES = [
  'read:page:confluence',
  'write:page:confluence',
  'read:space:confluence',
  'read:comment:confluence',
  'write:comment:confluence',
  'search:confluence',
  'read:me',
  'offline_access',
];

const OAUTH_PORT = 9999;

export interface ConfluenceOAuthResult {
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

export async function refreshConfluenceToken(
  refreshToken: string
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const response = await fetch(ATLASSIAN_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: ATLASSIAN_OAUTH_CONFIG.clientId,
      client_secret: ATLASSIAN_OAUTH_CONFIG.clientSecret,
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

export async function performConfluenceOAuthFlow(
  selectSite?: (sites: AtlassianSite[]) => Promise<AtlassianSite>
): Promise<ConfluenceOAuthResult> {
  const redirectUri = `http://localhost:${OAUTH_PORT}/callback`;
  const state = Math.random().toString(36).substring(2);

  const authUrl = new URL(ATLASSIAN_AUTH_URL);
  authUrl.searchParams.set('audience', 'api.atlassian.com');
  authUrl.searchParams.set('client_id', ATLASSIAN_OAUTH_CONFIG.clientId);
  authUrl.searchParams.set('scope', CONFLUENCE_SCOPES.join(' '));
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('prompt', 'consent');

  const callbackPromise = startOAuthCallbackServer({
    port: OAUTH_PORT,
    serviceName: 'Atlassian',
    expectedState: state,
  });

  console.error(`\nOpening browser for Atlassian authorization...`);
  console.error(`If browser doesn't open, visit:\n${authUrl.toString()}\n`);
  launchBrowser(authUrl.toString());

  const { code } = await callbackPromise;

  const tokens = await exchangeCodeForTokens(
    code,
    ATLASSIAN_OAUTH_CONFIG.clientId,
    ATLASSIAN_OAUTH_CONFIG.clientSecret,
    redirectUri
  );

  const sites = await getAccessibleResources(tokens.accessToken);

  if (sites.length === 0) {
    throw new Error('No accessible Confluence sites found. Make sure your app has the correct permissions.');
  }

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
