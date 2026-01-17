import { Command } from 'commander';
import { listProfiles, CONFIG_DIR } from '../config/config-manager';
import { getCredentials, setCredentials } from '../auth/token-store';
import { createGoogleAuth } from '../auth/token-manager';
import { refreshJiraToken } from '../auth/jira-oauth';
import { TelegramClient } from '../services/telegram/client';
import { GmailClient } from '../services/gmail/client';
import { JiraClient } from '../services/jira/client';
import { GChatClient } from '../services/gchat/client';
import { SlackClient } from '../services/slack/client';
import { DiscourseClient } from '../services/discourse/client';
import type { ServiceClient, ValidationResult } from '../types/service';
import type { ServiceName } from '../types/config';
import type { OAuthTokens } from '../types/tokens';
import type { TelegramCredentials } from '../types/telegram';
import type { JiraCredentials } from '../types/jira';
import type { GChatCredentials } from '../types/gchat';
import type { SlackCredentials } from '../types/slack';
import type { DiscourseCredentials } from '../types/discourse';

type GmailCredentials = OAuthTokens & { email?: string };

/**
 * Creates a ServiceClient for the given service and credentials.
 * Handles token refresh for OAuth services before creating the client.
 */
async function createServiceClient(
  service: ServiceName,
  credentials: unknown,
  profileName: string
): Promise<ServiceClient | null> {
  switch (service) {
    case 'gmail': {
      const creds = credentials as GmailCredentials;
      const auth = createGoogleAuth({
        access_token: creds.access_token,
        refresh_token: creds.refresh_token,
        expiry_date: creds.expiry_date,
        token_type: creds.token_type || 'Bearer',
        scope: creds.scope,
      });
      return new GmailClient(auth);
    }

    case 'telegram': {
      const creds = credentials as TelegramCredentials;
      return new TelegramClient(creds.bot_token, creds.channel_id);
    }

    case 'jira': {
      let creds = credentials as JiraCredentials;
      // Refresh token if expired or about to expire
      const bufferTime = 5 * 60 * 1000;
      if (creds.expiryDate && Date.now() + bufferTime >= creds.expiryDate) {
        try {
          const refreshed = await refreshJiraToken(creds.refreshToken);
          creds = {
            ...creds,
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            expiryDate: Date.now() + refreshed.expiresIn * 1000,
          };
          await setCredentials('jira', profileName, creds);
        } catch {
          // Return a mock client that reports refresh failure
          return {
            validate: async () => ({
              valid: false,
              error: 'refresh token expired, re-authenticate',
            }),
          };
        }
      }
      return new JiraClient(creds);
    }

    case 'gchat': {
      const creds = credentials as GChatCredentials;
      return new GChatClient(creds);
    }

    case 'slack': {
      const creds = credentials as SlackCredentials;
      return new SlackClient(creds);
    }

    case 'discourse': {
      const creds = credentials as DiscourseCredentials;
      return new DiscourseClient(creds);
    }

    default:
      return null;
  }
}

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show configured profiles and credential status')
    .option('--no-test', 'Skip credential testing')
    .action(async (options) => {
      try {
        const allProfiles = await listProfiles();
        const version = program.version();

        console.log(`agentio v${version}`);
        console.log(`Config: ${CONFIG_DIR}\n`);

        let hasProfiles = false;

        for (const { service, profiles, default: defaultProfile } of allProfiles) {
          if (profiles.length === 0) {
            continue;
          }

          hasProfiles = true;
          const displayName = service.charAt(0).toUpperCase() + service.slice(1);
          console.log(displayName);

          for (const name of profiles) {
            const marker = name === defaultProfile ? ' (default)' : '';
            const credentials = await getCredentials(service, name);

            if (!credentials) {
              console.log(`  ${name}${marker}    ? no credentials`);
              continue;
            }

            if (options.test === false) {
              console.log(`  ${name}${marker}`);
              continue;
            }

            const client = await createServiceClient(service, credentials, name);
            let result: ValidationResult;

            if (client) {
              result = await client.validate();
            } else {
              result = { valid: true, info: 'unknown service' };
            }

            const status = result.valid ? 'ok' : 'invalid';
            const statusMark = result.valid ? '+' : 'x';
            const info = result.info ? `  ${result.info}` : '';
            const error = result.error ? `  (${result.error})` : '';

            console.log(`  ${name}${marker}    ${statusMark} ${status}${info}${error}`);
          }

          console.log();
        }

        if (!hasProfiles) {
          console.log('No profiles configured.');
          console.log('Run: agentio <service> profile add');
        }
      } catch (error) {
        console.error('Error:', error instanceof Error ? error.message : 'Unknown error');
        process.exit(1);
      }
    });
}
