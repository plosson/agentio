import { Command } from 'commander';
import { listProfiles, listEnv, CONFIG_DIR } from '../config/config-manager';
import { getCredentials, setCredentials } from '../auth/token-store';
import { createGoogleAuth } from '../auth/token-manager';
import { refreshJiraToken } from '../auth/jira-oauth';
import { TelegramClient } from '../services/telegram/client';
import { GmailClient } from '../services/gmail/client';
import { GitHubClient } from '../services/github/client';
import { JiraClient } from '../services/jira/client';
import { GChatClient } from '../services/gchat/client';
import { SlackClient } from '../services/slack/client';
import { DiscourseClient } from '../services/discourse/client';
import { SqlClient } from '../services/sql/client';
import type { ServiceClient, ValidationResult } from '../types/service';
import type { ServiceName } from '../types/config';
import type { OAuthTokens } from '../types/tokens';
import type { TelegramCredentials } from '../types/telegram';
import type { GitHubCredentials } from '../types/github';
import type { JiraCredentials } from '../types/jira';
import type { GChatCredentials } from '../types/gchat';
import type { SlackCredentials } from '../types/slack';
import type { DiscourseCredentials } from '../types/discourse';
import type { SqlCredentials } from '../types/sql';

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

    case 'github': {
      const creds = credentials as GitHubCredentials;
      return new GitHubClient(creds);
    }

    case 'jira': {
      let creds = credentials as JiraCredentials;

      // Helper to refresh token
      const tryRefresh = async (): Promise<JiraCredentials | null> => {
        try {
          const refreshed = await refreshJiraToken(creds.refreshToken);
          const newCreds = {
            ...creds,
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            expiryDate: Date.now() + refreshed.expiresIn * 1000,
          };
          await setCredentials('jira', profileName, newCreds);
          return newCreds;
        } catch {
          return null;
        }
      };

      // Refresh token if expired or about to expire
      const bufferTime = 5 * 60 * 1000;
      if (creds.expiryDate && Date.now() + bufferTime >= creds.expiryDate) {
        const refreshedCreds = await tryRefresh();
        if (!refreshedCreds) {
          return {
            validate: async () => ({
              valid: false,
              error: 'refresh token expired, re-authenticate',
            }),
          };
        }
        creds = refreshedCreds;
      }

      // Create client and return a wrapper that attempts refresh on validation failure
      const client = new JiraClient(creds);
      return {
        validate: async () => {
          const result = await client.validate();
          if (result.valid) {
            return result;
          }

          // Validation failed - try to refresh token and retry
          const refreshedCreds = await tryRefresh();
          if (!refreshedCreds) {
            return {
              valid: false,
              error: 'refresh token expired, re-authenticate',
            };
          }

          // Retry validation with refreshed credentials
          const refreshedClient = new JiraClient(refreshedCreds);
          return refreshedClient.validate();
        },
      };
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

    case 'sql': {
      const creds = credentials as SqlCredentials;
      return new SqlClient(creds);
    }

    default:
      return null;
  }
}

interface ProfileStatus {
  service: string;
  profile: string;
  status: 'ok' | 'invalid' | 'no-creds' | 'skipped';
  info?: string;
  error?: string;
}

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show configured profiles and credential status')
    .option('--no-test', 'Skip credential testing')
    .option('--json', 'Output in JSON format')
    .action(async (options) => {
      try {
        const allProfiles = await listProfiles();
        const version = program.version();
        const envVars = await listEnv();
        const envKeys = Object.keys(envVars).sort();

        // Collect all profile statuses
        const statuses: ProfileStatus[] = [];

        for (const { service, profiles } of allProfiles) {
          for (const name of profiles) {
            const credentials = await getCredentials(service, name);

            if (!credentials) {
              statuses.push({
                service,
                profile: name,
                status: 'no-creds',
              });
              continue;
            }

            if (options.test === false) {
              statuses.push({
                service,
                profile: name,
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
              status: result.valid ? 'ok' : 'invalid',
              info: result.info,
              error: result.error,
            });
          }
        }

        // JSON output mode
        if (options.json) {
          // Group profiles by service
          const services: Record<string, Array<Omit<ProfileStatus, 'service'>>> = {};
          for (const s of statuses) {
            const { service, ...rest } = s;
            if (!services[service]) {
              services[service] = [];
            }
            services[service].push(rest);
          }
          const output = {
            version,
            configDir: CONFIG_DIR,
            env: envKeys,
            services,
          };
          console.log(JSON.stringify(output, null, 2));
          return;
        }

        // Human-readable output
        console.log(`agentio v${version}`);
        console.log(`Config: ${CONFIG_DIR}`);
        console.log(`Env: ${envKeys.length > 0 ? envKeys.join(', ') : 'none'}\n`);

        if (statuses.length === 0) {
          console.log('No profiles configured.');
          console.log('Run: agentio <service> profile add');
          return;
        }

        // Calculate column widths
        const serviceWidth = Math.max(...statuses.map((s) => s.service.length));
        const profileWidth = Math.max(...statuses.map((s) => s.profile.length));

        // Print each profile on one line
        for (const s of statuses) {
          const servicePad = s.service.padEnd(serviceWidth);
          const profilePad = s.profile.padEnd(profileWidth);

          let statusStr: string;
          let details: string;

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
              details = '';
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
