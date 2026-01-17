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

interface ProfileStatus {
  service: string;
  profile: string;
  isDefault: boolean;
  status: 'ok' | 'invalid' | 'no-creds' | 'skipped';
  info?: string;
  error?: string;
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

        // Collect all profile statuses
        const statuses: ProfileStatus[] = [];

        for (const { service, profiles, default: defaultProfile } of allProfiles) {
          for (const name of profiles) {
            const credentials = await getCredentials(service, name);

            if (!credentials) {
              statuses.push({
                service,
                profile: name,
                isDefault: name === defaultProfile,
                status: 'no-creds',
              });
              continue;
            }

            if (options.test === false) {
              statuses.push({
                service,
                profile: name,
                isDefault: name === defaultProfile,
                status: 'skipped',
              });
              continue;
            }

            const client = await createServiceClient(service, credentials, name);
            let result: ValidationResult;

            if (client) {
              result = await client.validate();
            } else {
              result = { valid: true, info: 'unknown service' };
            }

            statuses.push({
              service,
              profile: name,
              isDefault: name === defaultProfile,
              status: result.valid ? 'ok' : 'invalid',
              info: result.info,
              error: result.error,
            });
          }
        }

        if (statuses.length === 0) {
          console.log('No profiles configured.');
          console.log('Run: agentio <service> profile add');
          return;
        }

        // Calculate column widths
        const serviceWidth = Math.max(...statuses.map((s) => s.service.length));
        const profileWidth = Math.max(...statuses.map((s) => s.profile.length + (s.isDefault ? 1 : 0)));

        // Print each profile on one line
        for (const s of statuses) {
          const servicePad = s.service.padEnd(serviceWidth);
          const profileName = s.profile + (s.isDefault ? '*' : '');
          const profilePad = profileName.padEnd(profileWidth);

          let statusStr: string;
          let details = '';

          switch (s.status) {
            case 'ok':
              statusStr = 'ok';
              details = s.info || '';
              break;
            case 'invalid':
              statusStr = 'ERR';
              details = s.error || '';
              break;
            case 'no-creds':
              statusStr = 'ERR';
              details = 'no credentials';
              break;
            case 'skipped':
              statusStr = '-';
              break;
          }

          const line = `${servicePad}  ${profilePad}  ${statusStr.padEnd(3)}  ${details}`.trimEnd();
          console.log(line);
        }
      } catch (error) {
        console.error('Error:', error instanceof Error ? error.message : 'Unknown error');
        process.exit(1);
      }
    });
}
