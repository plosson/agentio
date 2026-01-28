import { Command } from 'commander';
import { listProfiles, listEnv, CONFIG_DIR } from '../config/config-manager';
import { getCredentials, setCredentials } from '../auth/token-store';
import { createGoogleAuth } from '../auth/token-manager';
import { refreshJiraToken } from '../auth/jira-oauth';
import { TelegramClient } from '../services/telegram/client';
import { GmailClient } from '../services/gmail/client';
import { GDocsClient } from '../services/gdocs/client';
import { GDriveClient } from '../services/gdrive/client';
import { GCalClient } from '../services/gcal/client';
import { GTasksClient } from '../services/gtasks/client';
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
import type { GDocsCredentials } from '../types/gdocs';
import type { GDriveCredentials } from '../types/gdrive';
import type { GCalCredentials } from '../types/gcal';
import type { GTasksCredentials } from '../types/gtasks';
import type { GChatCredentials } from '../types/gchat';
import type { SlackCredentials } from '../types/slack';
import type { DiscourseCredentials } from '../types/discourse';
import type { SqlCredentials } from '../types/sql';
import type { WhatsAppCredentials } from '../types/whatsapp';
import { isGatewayAvailable, getGatewayClient } from '../gateway/client';

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

    case 'gdocs': {
      const creds = credentials as GDocsCredentials;
      return new GDocsClient(creds);
    }

    case 'gdrive': {
      const creds = credentials as GDriveCredentials;
      return new GDriveClient(creds);
    }

    case 'gcal': {
      const creds = credentials as GCalCredentials;
      const auth = createGoogleAuth({
        access_token: creds.access_token,
        refresh_token: creds.refresh_token,
        expiry_date: creds.expiry_date,
        token_type: creds.token_type || 'Bearer',
        scope: creds.scope,
      });
      return new GCalClient(auth);
    }

    case 'gtasks': {
      const creds = credentials as GTasksCredentials;
      const auth = createGoogleAuth({
        access_token: creds.access_token,
        refresh_token: creds.refresh_token,
        expiry_date: creds.expiry_date,
        token_type: creds.token_type || 'Bearer',
        scope: creds.scope,
      });
      return new GTasksClient(auth);
    }

    case 'telegram': {
      const creds = credentials as TelegramCredentials;
      return new TelegramClient(creds.botToken, creds.channelId);
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

    case 'whatsapp': {
      const creds = credentials as WhatsAppCredentials;
      return {
        validate: async (): Promise<ValidationResult> => {
          // Check if gateway is running
          const gatewayAvailable = await isGatewayAvailable();
          if (!gatewayAvailable) {
            if (creds.paired) {
              return {
                valid: true,
                info: `${creds.phoneNumber || 'paired'} (gateway not running)`,
              };
            }
            return { valid: false, error: 'not paired (gateway not running)' };
          }

          // Check connection status via gateway - this is the source of truth
          try {
            const client = await getGatewayClient();
            const status = await client.status();
            const adapter = status.adapters.find(
              (a) => a.service === 'whatsapp' && a.profile === profileName
            );

            if (adapter?.connected) {
              // Connected via gateway = working
              return { valid: true, info: creds.phoneNumber || 'connected' };
            } else if (adapter) {
              // Adapter exists but not connected
              return {
                valid: true,
                info: `${creds.phoneNumber || 'configured'} (disconnected)`,
              };
            } else if (creds.paired) {
              // Has paired credentials but no adapter in gateway
              return {
                valid: true,
                info: `${creds.phoneNumber || 'paired'} (not loaded in gateway)`,
              };
            } else {
              return { valid: false, error: 'not paired' };
            }
          } catch {
            if (creds.paired) {
              return {
                valid: true,
                info: `${creds.phoneNumber || 'paired'} (gateway error)`,
              };
            }
            return { valid: false, error: 'gateway error' };
          }
        },
      };
    }

    default:
      return null;
  }
}

interface ProfileStatus {
  service: string;
  profile: string;
  readOnly?: boolean;
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
          for (const entry of profiles) {
            const credentials = await getCredentials(service, entry.name);

            if (!credentials) {
              statuses.push({
                service,
                profile: entry.name,
                readOnly: entry.readOnly,
                status: 'no-creds',
              });
              continue;
            }

            if (options.test === false) {
              statuses.push({
                service,
                profile: entry.name,
                readOnly: entry.readOnly,
                status: 'skipped',
              });
              continue;
            }

            const client = await createServiceClient(service, credentials, entry.name);
            let result: ValidationResult;

            if (client) {
              result = await client.validate();
            } else {
              result = { valid: true, info: 'unknown service' };
            }

            statuses.push({
              service,
              profile: entry.name,
              readOnly: entry.readOnly,
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
          const readOnlyIndicator = s.readOnly ? ' [RO]' : '';
          const profileWithRo = s.profile + readOnlyIndicator;
          const profilePad = profileWithRo.padEnd(profileWidth + 5); // +5 for [RO]

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
