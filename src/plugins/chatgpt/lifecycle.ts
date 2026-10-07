import { CliError } from '../../utils/errors';
import type { SetupContext } from '../../plugin-sdk';
import { createSetupContext } from '../host-context';
import type { CredentialLifecycle } from '../types';
import { credentialsFromTokens, refreshTokens, signInWithChatGpt } from './oauth';
import type { ChatGptCredentials } from './types';

export const chatGptCredentialLifecycle: CredentialLifecycle<ChatGptCredentials> = {
  secretFields: ['refreshToken'],
  applies(credentials): credentials is ChatGptCredentials {
    const c = credentials as Partial<ChatGptCredentials> | null;
    return typeof c === 'object' && c !== null && c.kind === 'chatgpt' && typeof c.refreshToken === 'string';
  },
  isStale(credentials, now, bufferMs) {
    return credentials.expiresAt === undefined || now + bufferMs >= credentials.expiresAt;
  },
  async refresh(credentials) {
    return credentialsFromTokens(await refreshTokens(credentials.refreshToken!), credentials);
  },
};

/** Signs in again; uses nothing secret from `credentials`, which a remote reauth receives redacted. */
export async function reauthenticateChatGpt(
  credentials: ChatGptCredentials | null,
  profileName: string,
  context: SetupContext = createSetupContext(),
): Promise<ChatGptCredentials> {
  if (credentials?.kind === 'apiKey') {
    throw new CliError('INVALID_PARAMS', `chatgpt / ${profileName} uses an API key; there is no sign-in to renew`,
      `Run: agentio chatgpt profile add --profile ${profileName}`);
  }
  context.log(`\nSigning in to ChatGPT again for chatgpt / ${profileName}...`);
  const signedIn = await signInWithChatGpt(context);
  return { ...signedIn, ...(credentials?.model ? { model: credentials.model } : {}) };
}
