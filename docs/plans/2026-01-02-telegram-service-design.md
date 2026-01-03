# Telegram Service Design

## Overview

Add Telegram bot integration to post messages to channels. Uses Bot Token authentication (via @BotFather) with an interactive setup wizard.

## Storage

### Generic Credential Store

Refactor token storage to be service-agnostic:

```typescript
// types/tokens.ts
export interface StoredCredentials {
  [service: string]: {
    [profile: string]: Record<string, unknown>;
  };
}
```

Generic accessor functions:
```typescript
export async function getCredentials<T>(service: ServiceName, profile: string): Promise<T | null>
export async function setCredentials(service: ServiceName, profile: string, credentials: Record<string, unknown>): Promise<void>
```

### Telegram Credentials Shape

```typescript
interface TelegramCredentials {
  bot_token: string;
  channel_id: string;
  bot_username?: string;
}
```

## Interactive Wizard

`acli telegram profile add --profile <name>`:

1. **Create bot** - Guide user to @BotFather, collect token
2. **Validate token** - Call `getMe` API, display bot username
3. **Configure channel** - Prompt for channel ID/username
4. **Validate channel** - Call `getChat` API, verify bot has access
5. **Store credentials** - Save to encrypted store
6. **Show next steps** - Optional customization via @BotFather

## Commands

```
acli telegram profile add [--profile <name>]    # Interactive wizard
acli telegram profile list                       # List profiles
acli telegram profile remove --profile <name>   # Remove profile

acli telegram send [--profile <name>] <message> # Send to channel
  --parse-mode <html|markdown>                  # Optional formatting
  --silent                                      # Disable notification
```

## TelegramClient

```typescript
class TelegramClient {
  constructor(botToken: string, channelId: string)

  async getMe(): Promise<BotInfo>
  async getChat(): Promise<ChatInfo>
  async sendMessage(text: string, options?: SendOptions): Promise<Message>
}
```

Uses Telegram Bot API via `fetch` - no external dependencies.

## Files to Modify

1. `src/types/config.ts` - Add `'telegram'` to `ServiceName`
2. `src/types/tokens.ts` - Make generic
3. `src/auth/token-store.ts` - Rename to `getCredentials`/`setCredentials`
4. `src/config/config-manager.ts` - Add `'telegram'` to services list
5. `src/index.ts` - Register telegram commands
6. `src/commands/gmail.ts` - Update to use renamed functions
7. `src/auth/token-manager.ts` - Update to use generic credentials

## Files to Create

1. `src/types/telegram.ts` - Telegram API types
2. `src/services/telegram/client.ts` - Bot API wrapper
3. `src/commands/telegram.ts` - CLI commands with wizard
