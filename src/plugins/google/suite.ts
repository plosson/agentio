import { chat } from '@googleapis/chat';
import { CliError } from '../../utils/errors';
import type { OAuthService } from './oauth';
import { createGoogleAuth } from './token-manager';
import type { GoogleCamelTokens, OAuthTokens } from './tokens';
import type { GDriveAccessLevel } from './gdrive/types';

/**
 * The Google services one consent can cover, and how each turns a grant into
 * the credentials its plugin reads. Plugins import from here; this file never
 * imports a plugin, so there is no cycle.
 */

/** Credentials as the vault stores them; each plugin reads its own shape. */
export type StoredGoogleCredentials = Record<string, unknown>;

export type GoogleService = 'gmail' | 'gcal' | 'gtasks' | 'gdrive' | 'gdocs' | 'gsheets' | 'gslides' | 'gscript' | 'gchat';

/** What a grant is for: a new profile (`readOnly` from the command line) or a renewal (`existing`). */
export interface GrantContext {
  readOnly?: boolean;
  existing?: StoredGoogleCredentials | null;
}

export interface GoogleSuiteEntry {
  service: GoogleService;
  /** The scope set this service needs. */
  scopeKey(context: GrantContext): OAuthService;
  /** The credentials its plugin stores, keeping fields a renewed profile already had. */
  toCredentials(tokens: OAuthTokens, email: string, context: GrantContext): StoredGoogleCredentials;
  /** A check beyond granted scopes; throws a CliError when the service cannot be used. */
  verify?(tokens: OAuthTokens): Promise<void>;
}

/** Gmail, Calendar and Tasks store Google's own field names. */
export function snakeCredentials(
  tokens: OAuthTokens,
  email: string,
  existing?: StoredGoogleCredentials | null,
): StoredGoogleCredentials & OAuthTokens & { email: string } {
  return { ...(existing ?? {}), ...tokens, email };
}

/** Docs, Drive, Sheets, Slides, Script and Chat store camel-case names. */
export function camelCredentials(
  tokens: OAuthTokens,
  email: string,
  existing?: StoredGoogleCredentials | null,
): StoredGoogleCredentials & GoogleCamelTokens & { email: string } {
  return {
    ...(existing ?? {}),
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiryDate: tokens.expiry_date,
    tokenType: tokens.token_type,
    scope: tokens.scope,
    email,
  };
}

export function driveCredentials(
  tokens: OAuthTokens,
  email: string,
  accessLevel: GDriveAccessLevel,
  existing?: StoredGoogleCredentials | null,
): StoredGoogleCredentials & GoogleCamelTokens & { email: string; accessLevel: GDriveAccessLevel } {
  return { ...camelCredentials(tokens, email, existing), accessLevel };
}

export function chatCredentials(
  tokens: OAuthTokens,
  email: string,
  existing?: StoredGoogleCredentials | null,
): StoredGoogleCredentials & GoogleCamelTokens & { email: string; type: 'oauth' } {
  return { ...camelCredentials(tokens, email, existing), type: 'oauth' };
}

/**
 * The Drive access a grant asks for. A renewal keeps the stored level, and a
 * profile without one renews read-only, as Drive's reauthentication always
 * did. A new profile is full unless read-only was asked.
 */
export function driveAccessLevel(context: GrantContext): GDriveAccessLevel {
  if (context.existing) return context.existing.accessLevel === 'full' ? 'full' : 'readonly';
  return context.readOnly ? 'readonly' : 'full';
}

/** Chat works with Google Workspace accounts only; find out now rather than on first use. */
export async function verifyChatAccess(tokens: OAuthTokens): Promise<void> {
  try {
    const chatApi = chat({ version: 'v1', auth: createGoogleAuth(tokens) as any });
    await chatApi.spaces.list({ pageSize: 1 });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new CliError(
      'AUTH_FAILED',
      `Failed to validate Google Chat access: ${errorMessage}`,
      'Google Chat API requires a Google Workspace account. Personal Gmail accounts cannot use the Chat API.'
    );
  }
}

function snakeEntry(service: 'gmail' | 'gcal' | 'gtasks'): GoogleSuiteEntry {
  return {
    service,
    scopeKey: () => service,
    toCredentials: (tokens, email, context) => snakeCredentials(tokens, email, context.existing),
  };
}

function camelEntry(service: 'gdocs' | 'gsheets' | 'gslides' | 'gscript'): GoogleSuiteEntry {
  return {
    service,
    scopeKey: () => service,
    toCredentials: (tokens, email, context) => camelCredentials(tokens, email, context.existing),
  };
}

export const GOOGLE_SUITE: readonly GoogleSuiteEntry[] = [
  snakeEntry('gmail'),
  snakeEntry('gcal'),
  snakeEntry('gtasks'),
  {
    service: 'gdrive',
    scopeKey: (context) => (driveAccessLevel(context) === 'full' ? 'gdrive-full' : 'gdrive-readonly'),
    toCredentials: (tokens, email, context) => driveCredentials(tokens, email, driveAccessLevel(context), context.existing),
  },
  camelEntry('gdocs'),
  camelEntry('gsheets'),
  camelEntry('gslides'),
  camelEntry('gscript'),
  {
    service: 'gchat',
    scopeKey: () => 'gchat',
    toCredentials: (tokens, email, context) => chatCredentials(tokens, email, context.existing),
    verify: verifyChatAccess,
  },
];

export function suiteEntry(service: string): GoogleSuiteEntry | undefined {
  return GOOGLE_SUITE.find((entry) => entry.service === service);
}
