# Discord Integration - Implementation Tasks

This document outlines the implementation steps for adding Discord support to agentio, following the project's service development guidelines.

## Overview

Discord will support two profile types:
1. **Bot Profile**: Full read/write access via bot token
2. **Webhook Profile**: Write-only access via webhook URL

## Pre-Implementation Requirements

### Discord Setup (User-side)
- [ ] User creates a Discord application at https://discord.com/developers/applications
- [ ] User creates a bot and obtains bot token
- [ ] User invites bot to their server with required permissions
- [ ] (Alternative) User creates a webhook in channel settings

---

## Implementation Tasks

### Phase 1: Type Definitions

#### Task 1.1: Update ServiceName type
**File**: `src/types/config.ts`

Add `'discord'` to the `ServiceName` union type and update the `Config` interface to include discord profiles and defaults.

```typescript
export type ServiceName = 'gmail' | 'gchat' | 'jira' | 'slack' | 'telegram' | 'discord';
```

#### Task 1.2: Create Discord types
**File**: `src/types/discord.ts`

Create the following interfaces:

```typescript
// Discriminated union for bot vs webhook credentials
export type DiscordCredentials = DiscordBotCredentials | DiscordWebhookCredentials;

export interface DiscordBotCredentials {
  type: 'bot';
  botToken: string;
  channelId: string;
  guildId?: string;        // Server ID (optional, for display)
  botUsername?: string;    // For display in profile list
  channelName?: string;    // For display in profile list
}

export interface DiscordWebhookCredentials {
  type: 'webhook';
  webhookUrl: string;
  channelName?: string;    // For display in profile list
}

// Message types
export interface DiscordMessage {
  id: string;
  channelId: string;
  content: string;
  author: DiscordAuthor;
  timestamp: string;
  editedTimestamp?: string;
  attachments: DiscordAttachment[];
  embeds: DiscordEmbed[];
}

export interface DiscordAuthor {
  id: string;
  username: string;
  discriminator: string;
  bot?: boolean;
}

export interface DiscordAttachment {
  id: string;
  filename: string;
  url: string;
  size: number;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
}

// Options interfaces
export interface DiscordSendOptions {
  content: string;
  channelId?: string;      // Override default channel (bot only)
  tts?: boolean;           // Text-to-speech
}

export interface DiscordListOptions {
  limit?: number;          // Max 100, default 50
  before?: string;         // Message ID for pagination
  after?: string;          // Message ID for pagination
}

// Result types
export interface DiscordSendResult {
  messageId: string;
  channelId: string;
  timestamp: string;
}
```

---

### Phase 2: API Client

#### Task 2.1: Create Discord client
**File**: `src/services/discord/client.ts`

Implement `DiscordClient` class with the following structure:

```typescript
export class DiscordClient {
  private credentials: DiscordCredentials;
  private baseUrl = 'https://discord.com/api/v10';

  constructor(credentials: DiscordCredentials) {
    this.credentials = credentials;
  }

  // Public methods
  async send(options: DiscordSendOptions): Promise<DiscordSendResult>
  async list(options?: DiscordListOptions): Promise<DiscordMessage[]>
  async get(messageId: string): Promise<DiscordMessage>
  async delete(messageId: string): Promise<void>

  // Private helpers
  private async request<T>(endpoint: string, options?: RequestInit): Promise<T>
  private getErrorCode(status: number): string
  private parseMessage(raw: unknown): DiscordMessage
  private getChannelId(): string  // Returns channelId from credentials
}
```

**Key implementation details**:

1. **Authentication header**:
   - Bot: `Authorization: Bot ${botToken}`
   - Webhook: No header needed (token in URL)

2. **Endpoint routing by credential type**:
   - Bot send: `POST /channels/{channelId}/messages`
   - Webhook send: `POST {webhookUrl}`
   - List/Get/Delete: Bot only (throw error for webhook)

3. **Rate limit handling**:
   - Parse `X-RateLimit-Remaining` and `X-RateLimit-Reset` headers
   - On 429, use `retry_after` from response body
   - Implement exponential backoff

4. **Error mapping**:
   ```typescript
   private getErrorCode(status: number): string {
     if (status === 401) return 'AUTH_FAILED';
     if (status === 403) return 'PERMISSION_DENIED';
     if (status === 404) return 'NOT_FOUND';
     if (status === 429) return 'RATE_LIMITED';
     return 'API_ERROR';
   }
   ```

---

### Phase 3: CLI Commands

#### Task 3.1: Create Discord commands
**File**: `src/commands/discord.ts`

Implement `registerDiscordCommands(program: Command)` with the following commands:

**Operation Commands**:

```bash
# Send message (bot or webhook)
agentio discord send [message] [--profile <name>] [--channel <id>] [--tts]

# List messages (bot only)
agentio discord list [--profile <name>] [--limit <n>] [--before <id>] [--after <id>]

# Get specific message (bot only)
agentio discord get <message-id> [--profile <name>]

# Delete message (bot only)
agentio discord delete <message-id> [--profile <name>]
```

**Profile Subcommands**:

```bash
# Add new profile (interactive - asks for bot or webhook type)
agentio discord profile add [--profile <name>]

# List all profiles
agentio discord profile list

# Remove profile
agentio discord profile remove --profile <name>
```

#### Task 3.2: Implement profile setup flows

**Bot profile setup** (`setupBotProfile`):
1. Prompt for bot token
2. Validate token by calling `GET /users/@me`
3. Prompt for channel ID
4. Validate channel access by calling `GET /channels/{channelId}`
5. Store credentials with bot username and channel name

**Webhook profile setup** (`setupWebhookProfile`):
1. Prompt for webhook URL
2. Validate URL format (must match `https://discord.com/api/webhooks/{id}/{token}`)
3. Validate by calling `GET {webhookUrl}` to get channel info
4. Store credentials with channel name

#### Task 3.3: Implement client factory

```typescript
async function getDiscordClient(profileName?: string): Promise<{
  client: DiscordClient;
  profile: string
}> {
  const profile = await getProfile('discord', profileName);
  if (!profile) {
    throw new CliError(
      'PROFILE_NOT_FOUND',
      'No Discord profile configured',
      'Run: agentio discord profile add'
    );
  }

  const credentials = await getCredentials<DiscordCredentials>('discord', profile);
  if (!credentials) {
    throw new CliError(
      'AUTH_FAILED',
      'Credentials not found',
      `Run: agentio discord profile add --profile ${profile}`
    );
  }

  return { client: new DiscordClient(credentials), profile };
}
```

---

### Phase 4: Output Formatting

#### Task 4.1: Add Discord formatters to output.ts
**File**: `src/utils/output.ts`

Add the following functions:

```typescript
export function printDiscordSendResult(result: DiscordSendResult): void {
  console.log(`Message sent successfully`);
  console.log(`  Message ID: ${result.messageId}`);
  console.log(`  Channel: ${result.channelId}`);
  console.log(`  Timestamp: ${result.timestamp}`);
}

export function printDiscordMessageList(messages: DiscordMessage[]): void {
  if (messages.length === 0) {
    console.log('No messages found');
    return;
  }
  console.log(`Found ${messages.length} message(s):\n`);
  for (const msg of messages) {
    printDiscordMessageSummary(msg);
  }
}

export function printDiscordMessage(message: DiscordMessage): void {
  console.log(`Message ID: ${message.id}`);
  console.log(`Author: ${message.author.username}${message.author.bot ? ' [BOT]' : ''}`);
  console.log(`Timestamp: ${message.timestamp}`);
  if (message.editedTimestamp) {
    console.log(`Edited: ${message.editedTimestamp}`);
  }
  console.log(`\n${message.content}`);
  if (message.attachments.length > 0) {
    console.log(`\nAttachments: ${message.attachments.map(a => a.filename).join(', ')}`);
  }
}

function printDiscordMessageSummary(message: DiscordMessage): void {
  const preview = message.content.slice(0, 80) + (message.content.length > 80 ? '...' : '');
  console.log(`[${message.id}] ${message.author.username}: ${preview}`);
}
```

---

### Phase 5: Registration & Testing

#### Task 5.1: Register commands in index.ts
**File**: `src/index.ts`

```typescript
import { registerDiscordCommands } from './commands/discord';

// In the main function:
registerDiscordCommands(program);
```

#### Task 5.2: Manual Testing Checklist

**Profile Management**:
- [ ] `agentio discord profile add` - Bot profile flow
- [ ] `agentio discord profile add` - Webhook profile flow
- [ ] `agentio discord profile list` - Shows all profiles with types
- [ ] `agentio discord profile remove --profile <name>` - Removes profile

**Bot Operations**:
- [ ] `agentio discord send "test message"` - Sends to default channel
- [ ] `agentio discord send "test" --channel <id>` - Sends to specific channel
- [ ] `agentio discord list` - Lists recent messages
- [ ] `agentio discord list --limit 10` - Lists with limit
- [ ] `agentio discord get <message-id>` - Gets specific message
- [ ] `agentio discord delete <message-id>` - Deletes message
- [ ] `echo "piped message" | agentio discord send` - Stdin support

**Webhook Operations**:
- [ ] `agentio discord send "webhook test"` - Sends via webhook
- [ ] `agentio discord list` - Returns error (webhook is send-only)

**Error Handling**:
- [ ] Invalid token returns AUTH_FAILED
- [ ] Invalid channel returns NOT_FOUND
- [ ] Missing permissions returns PERMISSION_DENIED
- [ ] Rate limit returns RATE_LIMITED with retry info

---

## File Summary

| File | Action | Description |
|------|--------|-------------|
| `src/types/config.ts` | Edit | Add 'discord' to ServiceName, update Config interface |
| `src/types/discord.ts` | Create | Credentials, message, and options interfaces |
| `src/services/discord/client.ts` | Create | DiscordClient class with API methods |
| `src/commands/discord.ts` | Create | CLI commands and profile management |
| `src/utils/output.ts` | Edit | Add Discord output formatters |
| `src/index.ts` | Edit | Register Discord commands |

---

## Implementation Order

1. **Task 1.1** - Update config types (5 min)
2. **Task 1.2** - Create Discord types (15 min)
3. **Task 2.1** - Create Discord client (45 min)
4. **Task 3.1** - Create Discord commands (30 min)
5. **Task 3.2** - Implement profile setup (20 min)
6. **Task 3.3** - Implement client factory (10 min)
7. **Task 4.1** - Add output formatters (15 min)
8. **Task 5.1** - Register commands (5 min)
9. **Task 5.2** - Manual testing (30 min)

**Estimated Total**: ~3 hours

---

## Notes

### Gateway Requirement
Discord requires bots to connect to the Gateway (WebSocket) at least once before using certain REST endpoints. However, for basic message operations, this may not be strictly enforced. If issues arise, we may need to add a one-time Gateway handshake during profile setup.

### Message Content Intent
For bots in 100+ servers, the MESSAGE_CONTENT privileged intent must be approved by Discord. For smaller bots, it can be enabled in the Developer Portal. The profile setup should warn users about this requirement.

### Webhook Limitations
Webhooks cannot:
- Read messages
- Delete messages
- Edit messages
- Get channel info (beyond what's in the webhook response)

The client should throw clear errors when webhook profiles attempt read operations.
