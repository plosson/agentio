# Google Chat Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Google Chat service to agentio supporting both webhook-based and OAuth-based message sending/reading.

**Architecture:**
- **Webhook profiles**: Store webhook URLs directly, POST messages via HTTP
- **OAuth profiles**: Store Google OAuth tokens, use Google Chat API for send/list/get operations
- **Profile differentiation**: Each gchat profile stores a `type` field ('webhook' or 'oauth') to determine behavior
- **Client abstraction**: Single GChatClient accepts credentials and profile type, branches internally
- **Token management**: Reuse existing token manager for OAuth profiles, webhook profiles skip token validation

**Tech Stack:**
- Google Chat API v1 (googleapis library)
- HTTP POST for webhooks
- Same OAuth client as Gmail (added scopes)
- Commander.js for CLI commands

---

## Task 1: Create Google Chat Type Definitions

**Files:**
- Create: `src/types/gchat.ts`

**Step 1: Write type definitions file**

Create `src/types/gchat.ts` with all necessary types:

```typescript
export interface GChatMessage {
  name: string; // 'spaces/SPACE_ID/messages/MESSAGE_ID'
  displayName?: string;
  text?: string;
  createTime: string;
  updateTime: string;
  sender?: {
    name: string;
    displayName: string;
    avatarUrl?: string;
  };
  thread?: {
    name: string;
  };
}

export interface GChatSpace {
  name: string; // 'spaces/SPACE_ID'
  displayName: string;
  type: 'ROOM' | 'DM';
  description?: string;
  displaySettings?: {
    displayName: string;
  };
}

export interface GChatWebhookCredentials {
  type: 'webhook';
  webhook_url: string;
}

export interface GChatOAuthCredentials {
  type: 'oauth';
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;
  token_type: string;
  scope?: string;
}

export type GChatCredentials = GChatWebhookCredentials | GChatOAuthCredentials;

export interface GChatSendOptions {
  thread_id?: string;
  text: string;
}

export interface GChatListOptions {
  space_id: string;
  limit?: number;
}

export interface GChatGetOptions {
  space_id: string;
  message_id: string;
}

export interface GChatSendResult {
  message_id: string;
  space_id?: string;
  text: string;
}
```

**Step 2: Verify types file**

Run: `bun run typecheck`
Expected: No errors

---

## Task 2: Create Google Chat Client

**Files:**
- Create: `src/services/gchat/client.ts`

**Step 1: Create webhook-only client first (Step)**

Create `src/services/gchat/client.ts` with basic webhook support:

```typescript
import { CliError } from '../../utils/errors';
import type {
  GChatCredentials,
  GChatSendOptions,
  GChatSendResult,
  GChatWebhookCredentials,
  GChatOAuthCredentials
} from '../../types/gchat';

export class GChatClient {
  private credentials: GChatCredentials;

  constructor(credentials: GChatCredentials) {
    this.credentials = credentials;
  }

  async send(options: GChatSendOptions): Promise<GChatSendResult> {
    if (this.credentials.type === 'webhook') {
      return this.sendViaWebhook(options);
    } else {
      return this.sendViaOAuth(options);
    }
  }

  private async sendViaWebhook(options: GChatSendOptions): Promise<GChatSendResult> {
    const webhookUrl = (this.credentials as GChatWebhookCredentials).webhook_url;

    const payload = {
      text: options.text,
    };

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new CliError(
          'WEBHOOK_FAILED',
          `Failed to send message via webhook: ${response.status} ${error}`,
          'Check that the webhook URL is valid and the bot has permission to post'
        );
      }

      // Webhook doesn't return message ID, use placeholder
      return {
        message_id: 'unknown',
        text: options.text,
      };
    } catch (err) {
      if (err instanceof CliError) throw err;
      throw new CliError(
        'WEBHOOK_ERROR',
        `Webhook request failed: ${err instanceof Error ? err.message : String(err)}`,
        'Verify the webhook URL is correct and accessible'
      );
    }
  }

  private async sendViaOAuth(options: GChatSendOptions): Promise<GChatSendResult> {
    throw new CliError(
      'NOT_IMPLEMENTED',
      'OAuth-based Chat operations not yet implemented',
      'Use webhook profile for now'
    );
  }

  // OAuth-only methods (implemented in Task 3)
  async list(spaceId: string, limit?: number) {
    throw new CliError(
      'NOT_IMPLEMENTED',
      'OAuth-based Chat operations not yet implemented',
      'Use webhook profile for now'
    );
  }

  async get(spaceId: string, messageId: string) {
    throw new CliError(
      'NOT_IMPLEMENTED',
      'OAuth-based Chat operations not yet implemented',
      'Use webhook profile for now'
    );
  }
}
```

**Step 2: Verify client loads**

Run: `bun run typecheck`
Expected: No errors

---

## Task 3: Create Google Chat Commands - Profile Management

**Files:**
- Create: `src/commands/gchat.ts`

**Step 1: Create commands file with profile management**

Create `src/commands/gchat.ts`:

```typescript
import { Command } from 'commander';
import { google } from 'googleapis';
import { createInterface } from 'readline';
import { setCredentials, removeCredentials, getCredentials } from '../auth/token-store';
import { setProfile, removeProfile, listProfiles, getProfile } from '../config/config-manager';
import { performOAuthFlow } from '../auth/oauth';
import { createGoogleAuth } from '../auth/token-manager';
import { GChatClient } from '../services/gchat/client';
import { CliError, handleError } from '../utils/errors';
import { readStdin } from '../utils/stdin';
import type { GChatCredentials, GChatWebhookCredentials, GChatOAuthCredentials } from '../types/gchat';

function prompt(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function getGChatClient(profileName?: string): Promise<{ client: GChatClient; profile: string }> {
  const profile = await getProfile('gchat', profileName);

  if (!profile) {
    throw new CliError(
      'PROFILE_NOT_FOUND',
      profileName
        ? `Profile "${profileName}" not found for gchat`
        : 'No default profile configured for gchat',
      'Run: agentio gchat profile add'
    );
  }

  const credentials = await getCredentials<GChatCredentials>('gchat', profile);

  if (!credentials) {
    throw new CliError(
      'AUTH_FAILED',
      `No credentials found for gchat profile "${profile}"`,
      `Run: agentio gchat profile add --profile ${profile}`
    );
  }

  return {
    client: new GChatClient(credentials),
    profile,
  };
}

export function registerGChatCommands(program: Command): void {
  const gchat = program
    .command('gchat')
    .description('Google Chat operations');

  gchat
    .command('send')
    .description('Send a message to Google Chat')
    .option('--profile <name>', 'Profile name')
    .option('--thread <id>', 'Thread ID (optional)')
    .argument('[message]', 'Message text (or pipe via stdin)')
    .action(async (message: string | undefined, options) => {
      try {
        let text = message;

        if (!text) {
          text = await readStdin() || undefined;
        }

        if (!text) {
          throw new CliError('INVALID_PARAMS', 'Message is required. Provide as argument or pipe via stdin.');
        }

        const { client } = await getGChatClient(options.profile);
        const result = await client.send({
          text,
          thread_id: options.thread,
        });

        console.log('Message sent');
        console.log(`ID: ${result.message_id}`);
      } catch (error) {
        handleError(error);
      }
    });

  // Profile management
  const profile = gchat
    .command('profile')
    .description('Manage Google Chat profiles');

  profile
    .command('add')
    .description('Add a new Google Chat profile (webhook or OAuth)')
    .option('--profile <name>', 'Profile name', 'default')
    .action(async (options) => {
      try {
        const profileName = options.profile;

        console.error('\n💬 Google Chat Setup\n');

        const profileType = await prompt('Choose profile type (webhook/oauth): ');

        if (profileType.toLowerCase() === 'webhook') {
          await setupWebhookProfile(profileName);
        } else if (profileType.toLowerCase() === 'oauth') {
          await setupOAuthProfile(profileName);
        } else {
          throw new CliError('INVALID_PARAMS', 'Profile type must be "webhook" or "oauth"');
        }
      } catch (error) {
        handleError(error);
      }
    });

  profile
    .command('list')
    .description('List Google Chat profiles')
    .action(async () => {
      try {
        const result = await listProfiles('gchat');
        const { profiles, default: defaultProfile } = result[0];

        if (profiles.length === 0) {
          console.log('No profiles configured');
        } else {
          for (const name of profiles) {
            const marker = name === defaultProfile ? ' (default)' : '';
            const credentials = await getCredentials<GChatCredentials>('gchat', name);
            const typeInfo = credentials?.type === 'webhook' ? ' (webhook)' : ' (oauth)';
            console.log(`${name}${marker}${typeInfo}`);
          }
        }
      } catch (error) {
        handleError(error);
      }
    });

  profile
    .command('remove')
    .description('Remove a Google Chat profile')
    .requiredOption('--profile <name>', 'Profile name')
    .action(async (options) => {
      try {
        const profileName = options.profile;

        const removed = await removeProfile('gchat', profileName);
        await removeCredentials('gchat', profileName);

        if (removed) {
          console.log(`Removed profile "${profileName}"`);
        } else {
          console.error(`Profile "${profileName}" not found`);
        }
      } catch (error) {
        handleError(error);
      }
    });
}

async function setupWebhookProfile(profileName: string): Promise<void> {
  console.error('Webhook Setup\n');
  console.error('1. In Google Chat, find or create a space');
  console.error('2. Go to Space Settings → Webhooks');
  console.error('3. Create a new webhook and copy the URL\n');

  const webhookUrl = await prompt('? Paste your webhook URL: ');

  if (!webhookUrl) {
    throw new CliError('INVALID_PARAMS', 'Webhook URL is required');
  }

  // Validate webhook with a test request
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: 'Test message from agentio setup' }),
    });

    if (!response.ok) {
      throw new CliError(
        'WEBHOOK_INVALID',
        `Webhook validation failed: ${response.status}`,
        'Check the webhook URL and try again'
      );
    }
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(
      'WEBHOOK_ERROR',
      `Failed to validate webhook: ${err instanceof Error ? err.message : String(err)}`,
      'Check that the URL is correct and accessible'
    );
  }

  const credentials: GChatWebhookCredentials = {
    type: 'webhook',
    webhook_url: webhookUrl,
  };

  await setProfile('gchat', profileName);
  await setCredentials('gchat', profileName, credentials);

  console.log(`\n✅ Webhook profile "${profileName}" configured!`);
  console.log(`   Test with: agentio gchat send --profile ${profileName} "Hello from agentio"`);
}

async function setupOAuthProfile(profileName: string): Promise<void> {
  console.error('OAuth Setup\n');
  console.error('Starting OAuth flow for Google Chat profile...\n');

  const tokens = await performOAuthFlow('gchat');

  // Optionally fetch user info - Chat API doesn't have a getProfile like Gmail
  // For now, just validate the token works
  try {
    const auth = createGoogleAuth(tokens);
    const chat = google.chat({ version: 'v1', auth });
    // Simple validation: list spaces
    await chat.spaces.list({ pageSize: 1 });
  } catch (error) {
    throw new CliError(
      'AUTH_FAILED',
      'Failed to validate Google Chat access. Check OAuth scopes.',
      'Try again with: agentio gchat profile add --profile ' + profileName
    );
  }

  const credentials: GChatOAuthCredentials = {
    type: 'oauth',
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date,
    token_type: tokens.token_type,
    scope: tokens.scope,
  };

  await setProfile('gchat', profileName);
  await setCredentials('gchat', profileName, credentials);

  console.log(`\n✅ OAuth profile "${profileName}" configured!`);
  console.log(`   Test with: agentio gchat send --profile ${profileName} "Hello from agentio"`);
}
```

**Step 2: Register commands in index.ts**

Modify `src/index.ts`:

```typescript
#!/usr/bin/env bun
import { Command } from 'commander';
import { registerGmailCommands } from './commands/gmail';
import { registerTelegramCommands } from './commands/telegram';
import { registerGChatCommands } from './commands/gchat';

const program = new Command();

program
  .name('agentio')
  .description('CLI for LLM agents to interact with communication and tracking services')
  .version('0.1.0');

registerGmailCommands(program);
registerTelegramCommands(program);
registerGChatCommands(program);

program.parse();
```

**Step 3: Verify commands register**

Run: `bun run typecheck`
Expected: No errors

---

## Task 4: Update OAuth Flow to Support Google Chat Scopes

**Files:**
- Modify: `src/auth/oauth.ts`

**Step 1: Add Google Chat scopes and update performOAuthFlow**

Modify `src/auth/oauth.ts`:

```typescript
import { createServer, type Server } from 'http';
import { URL } from 'url';
import { google } from 'googleapis';
import { GOOGLE_OAUTH_CONFIG } from '../config/credentials';
import type { OAuthTokens } from '../types/tokens';

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',  // search & read emails
  'https://www.googleapis.com/auth/gmail.send',      // send emails
  'https://www.googleapis.com/auth/gmail.compose',   // create/update drafts
];

const GCHAT_SCOPES = [
  'https://www.googleapis.com/auth/chat.messages',   // send & read messages
  'https://www.googleapis.com/auth/chat.spaces',     // read space info
];

const PORT_RANGE_START = 3000;
const PORT_RANGE_END = 3010;

async function findAvailablePort(): Promise<number> {
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const server = createServer();
        server.listen(port, () => {
          server.close(() => resolve());
        });
        server.on('error', reject);
      });
      return port;
    } catch {
      continue;
    }
  }
  throw new Error(`No available port found in range ${PORT_RANGE_START}-${PORT_RANGE_END}`);
}

export async function performOAuthFlow(
  service: 'gmail' | 'gchat'
): Promise<OAuthTokens> {
  const port = await findAvailablePort();
  const redirectUri = `http://localhost:${port}/callback`;

  const oauth2Client = new google.auth.OAuth2(
    GOOGLE_OAUTH_CONFIG.clientId,
    GOOGLE_OAUTH_CONFIG.clientSecret,
    redirectUri
  );

  const scopes = service === 'gmail' ? GMAIL_SCOPES : service === 'gchat' ? GCHAT_SCOPES : [];

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent',
  });

  return new Promise((resolve, reject) => {
    let server: Server;

    const timeout = setTimeout(() => {
      server?.close();
      reject(new Error('OAuth flow timed out after 5 minutes'));
    }, 5 * 60 * 1000);

    server = createServer(async (req, res) => {
      const url = new URL(req.url || '', `http://localhost:${port}`);

      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Authorization Failed</h1><p>You can close this window.</p></body></html>');
        clearTimeout(timeout);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Missing Authorization Code</h1><p>You can close this window.</p></body></html>');
        clearTimeout(timeout);
        server.close();
        reject(new Error('Missing authorization code in OAuth callback'));
        return;
      }

      try {
        const { tokens } = await oauth2Client.getToken(code);

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Authorization Successful!</h1><p>You can close this window and return to the terminal.</p></body></html>');

        clearTimeout(timeout);
        server.close();

        resolve({
          access_token: tokens.access_token!,
          refresh_token: tokens.refresh_token || undefined,
          expiry_date: tokens.expiry_date || undefined,
          token_type: tokens.token_type || 'Bearer',
          scope: tokens.scope || undefined,
        });
      } catch (err) {
        res.writeHead(500);
        res.end('Failed to exchange authorization code');
        clearTimeout(timeout);
        server.close();
        reject(err);
      }
    });

    server.listen(port, () => {
      console.error(`\nOpening browser for authorization...`);
      console.error(`If browser doesn't open, visit:\n${authUrl}\n`);

      // Open browser
      const open = process.platform === 'darwin' ? 'open' :
                   process.platform === 'win32' ? 'start' : 'xdg-open';
      Bun.spawn([open, authUrl], { stdout: 'ignore', stderr: 'ignore' });
    });

    server.on('error', (err) => {
      clearTimeout(timeout);
      server?.close();
      reject(err);
    });
  });
}
```

**Step 2: Verify OAuth updates**

Run: `bun run typecheck`
Expected: No errors

---

## Task 5: Implement OAuth-Based Client Methods

**Files:**
- Modify: `src/services/gchat/client.ts`

**Step 1: Add full OAuth implementation**

Update `src/services/gchat/client.ts` to replace the stub methods with full OAuth support:

```typescript
import { google } from 'googleapis';
import { CliError } from '../../utils/errors';
import type {
  GChatCredentials,
  GChatSendOptions,
  GChatSendResult,
  GChatListOptions,
  GChatGetOptions,
  GChatWebhookCredentials,
  GChatOAuthCredentials,
  GChatMessage,
} from '../../types/gchat';

export class GChatClient {
  private credentials: GChatCredentials;

  constructor(credentials: GChatCredentials) {
    this.credentials = credentials;
  }

  async send(options: GChatSendOptions & { space_id?: string }): Promise<GChatSendResult> {
    if (this.credentials.type === 'webhook') {
      return this.sendViaWebhook(options);
    } else {
      return this.sendViaOAuth(options);
    }
  }

  async list(options: GChatListOptions): Promise<GChatMessage[]> {
    if (this.credentials.type === 'webhook') {
      throw new CliError(
        'NOT_SUPPORTED',
        'List is not supported for webhook profiles',
        'Use an OAuth profile to read messages'
      );
    }
    return this.listViaOAuth(options);
  }

  async get(options: GChatGetOptions): Promise<GChatMessage> {
    if (this.credentials.type === 'webhook') {
      throw new CliError(
        'NOT_SUPPORTED',
        'Get is not supported for webhook profiles',
        'Use an OAuth profile to read messages'
      );
    }
    return this.getViaOAuth(options);
  }

  private async sendViaWebhook(options: GChatSendOptions): Promise<GChatSendResult> {
    const webhookUrl = (this.credentials as GChatWebhookCredentials).webhook_url;

    const payload = {
      text: options.text,
    };

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new CliError(
          'WEBHOOK_FAILED',
          `Failed to send message via webhook: ${response.status} ${error}`,
          'Check that the webhook URL is valid and the bot has permission to post'
        );
      }

      return {
        message_id: 'unknown',
        text: options.text,
      };
    } catch (err) {
      if (err instanceof CliError) throw err;
      throw new CliError(
        'WEBHOOK_ERROR',
        `Webhook request failed: ${err instanceof Error ? err.message : String(err)}`,
        'Verify the webhook URL is correct and accessible'
      );
    }
  }

  private async sendViaOAuth(options: GChatSendOptions & { space_id?: string }): Promise<GChatSendResult> {
    const oauthCreds = this.credentials as GChatOAuthCredentials;
    const auth = this.createOAuthClient(oauthCreds);
    const chat = google.chat({ version: 'v1', auth });

    if (!options.space_id) {
      throw new CliError(
        'INVALID_PARAMS',
        'space_id is required for OAuth profiles',
        'Specify with --space or configure default in profile'
      );
    }

    try {
      const response = await chat.spaces.messages.create({
        parent: `spaces/${options.space_id}`,
        requestBody: {
          text: options.text,
        },
      });

      const messageId = response.data.name?.split('/').pop() || 'unknown';

      return {
        message_id: messageId,
        space_id: options.space_id,
        text: options.text,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new CliError(
        'API_ERROR',
        `Failed to send message: ${message}`,
        'Check that the space ID is valid and OAuth token is not expired'
      );
    }
  }

  private async listViaOAuth(options: GChatListOptions): Promise<GChatMessage[]> {
    const oauthCreds = this.credentials as GChatOAuthCredentials;
    const auth = this.createOAuthClient(oauthCreds);
    const chat = google.chat({ version: 'v1', auth });

    try {
      const response = await chat.spaces.messages.list({
        parent: `spaces/${options.space_id}`,
        pageSize: options.limit || 10,
      });

      return response.data.messages || [];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new CliError(
        'API_ERROR',
        `Failed to list messages: ${message}`,
        'Check that the space ID is valid and OAuth token is not expired'
      );
    }
  }

  private async getViaOAuth(options: GChatGetOptions): Promise<GChatMessage> {
    const oauthCreds = this.credentials as GChatOAuthCredentials;
    const auth = this.createOAuthClient(oauthCreds);
    const chat = google.chat({ version: 'v1', auth });

    try {
      const response = await chat.spaces.messages.get({
        name: `spaces/${options.space_id}/messages/${options.message_id}`,
      });

      if (!response.data) {
        throw new Error('Message not found');
      }

      return response.data as GChatMessage;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new CliError(
        'API_ERROR',
        `Failed to get message: ${message}`,
        'Check that the space ID and message ID are valid'
      );
    }
  }

  private createOAuthClient(credentials: GChatOAuthCredentials) {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_OAUTH_CLIENT_ID || '',
      process.env.GOOGLE_OAUTH_CLIENT_SECRET || ''
    );

    oauth2Client.setCredentials({
      access_token: credentials.access_token,
      refresh_token: credentials.refresh_token,
      expiry_date: credentials.expiry_date,
    });

    return oauth2Client;
  }
}
```

**Step 2: Verify OAuth client implementation**

Run: `bun run typecheck`
Expected: No errors

---

## Task 6: Add list/get Commands

**Files:**
- Modify: `src/commands/gchat.ts`

**Step 1: Add list and get commands**

Add these commands to `src/commands/gchat.ts` after the send command:

```typescript
  gchat
    .command('list')
    .description('List messages from a Google Chat space (OAuth profiles only)')
    .option('--profile <name>', 'Profile name')
    .requiredOption('--space <id>', 'Space ID')
    .option('--limit <n>', 'Number of messages', '10')
    .action(async (options) => {
      try {
        const { client } = await getGChatClient(options.profile);
        const messages = await client.list({
          space_id: options.space,
          limit: parseInt(options.limit, 10),
        });

        if (messages.length === 0) {
          console.log('No messages found');
        } else {
          console.log(`Messages (${messages.length})\n`);
          for (const msg of messages) {
            console.log(`ID: ${msg.name}`);
            console.log(`From: ${msg.sender?.displayName || 'Unknown'}`);
            console.log(`Text: ${msg.text || '(empty)'}`);
            console.log(`Date: ${msg.createTime}`);
            console.log('---');
          }
        }
      } catch (error) {
        handleError(error);
      }
    });

  gchat
    .command('get <message-id>')
    .description('Get a message from a Google Chat space (OAuth profiles only)')
    .option('--profile <name>', 'Profile name')
    .requiredOption('--space <id>', 'Space ID')
    .action(async (messageId: string, options) => {
      try {
        const { client } = await getGChatClient(options.profile);
        const message = await client.get({
          space_id: options.space,
          message_id: messageId,
        });

        console.log(`ID: ${message.name}`);
        console.log(`From: ${message.sender?.displayName || 'Unknown'}`);
        console.log(`Date: ${message.createTime}`);
        if (message.text) {
          console.log('---');
          console.log(message.text);
        }
      } catch (error) {
        handleError(error);
      }
    });
```

**Step 2: Update send command to support space_id for OAuth**

Modify the send command in `src/commands/gchat.ts` to add `--space` option:

```typescript
  gchat
    .command('send')
    .description('Send a message to Google Chat')
    .option('--profile <name>', 'Profile name')
    .option('--space <id>', 'Space ID (required for OAuth profiles)')
    .option('--thread <id>', 'Thread ID (optional)')
    .argument('[message]', 'Message text (or pipe via stdin)')
    .action(async (message: string | undefined, options) => {
      try {
        let text = message;

        if (!text) {
          text = await readStdin() || undefined;
        }

        if (!text) {
          throw new CliError('INVALID_PARAMS', 'Message is required. Provide as argument or pipe via stdin.');
        }

        const { client } = await getGChatClient(options.profile);
        const result = await client.send({
          text,
          thread_id: options.thread,
          space_id: options.space,
        });

        console.log('Message sent');
        console.log(`ID: ${result.message_id}`);
        if (result.space_id) {
          console.log(`Space: ${result.space_id}`);
        }
      } catch (error) {
        handleError(error);
      }
    });
```

**Step 3: Verify commands compile**

Run: `bun run typecheck`
Expected: No errors

---

## Task 7: Full Integration Test

**Files:**
- No new files

**Step 1: Type check everything**

Run: `bun run typecheck`
Expected: No errors

**Step 2: Build**

Run: `bun run build`
Expected: Build succeeds

**Step 3: Test help output**

Run: `bun run dev gchat --help`
Expected: Shows gchat commands

**Step 4: Test webhook profile setup (interactive)**

Run: `bun run dev gchat profile add --profile test-webhook`
At prompt, answer: `webhook`
At webhook URL prompt, enter a test webhook URL (or skip if you don't have one)
Expected: Profile added successfully

**Step 5: Test profile list**

Run: `bun run dev gchat profile list`
Expected: Shows test-webhook profile

**Step 6: Commit all changes**

Run:
```bash
git add -A
git commit -m "feat: add Google Chat service with webhook and OAuth support

- Add gchat types for webhook and OAuth credentials
- Implement GChatClient supporting both profile types
- Add gchat commands: send, list, get, profile management
- Update OAuth flow to include Chat API scopes
- Webhook profiles support send-only
- OAuth profiles support send, list, and get operations
- Profile setup guides users through webhook or OAuth flow"
```

Expected: Commit succeeds

---

## Testing Checklist

- [ ] Type checking passes
- [ ] Build succeeds
- [ ] Help text shows all commands
- [ ] Webhook profile can be added (with validation)
- [ ] Profile list shows profiles with type
- [ ] OAuth flow initializes correctly (opens browser)
- [ ] Webhook send works with test webhook
- [ ] OAuth send works with valid space ID

---

## Future Enhancements

1. **Default space ID per profile**: Allow `agentio gchat send "msg"` without `--space`
2. **Edit/delete messages**: Add OAuth methods for updating/removing messages
3. **Thread management**: Support replying to specific threads
4. **Mentions and formatting**: Support @mentions and rich text formatting
5. **Batch operations**: Send to multiple spaces

