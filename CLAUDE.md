# agentio - Agent I/O CLI

A CLI designed for LLM agents to interact with communication services (Gmail, Telegram, Slack) and tracking systems (JIRA, Linear). Features multi-profile support and encrypted credential storage.

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript
- **CLI Framework**: Commander.js
- **APIs**: googleapis (Gmail), Telegram Bot API (fetch-based)

## Running the CLI

```bash
# Development
bun run dev [command]
bun run dev --help

# Type checking
bun run typecheck

# Build
bun run build              # Node target
bun run build:native       # Native executable
```

## Project Structure

```
src/
├── index.ts                 # CLI entry point, registers all commands
├── commands/                # Command handlers (one file per service)
│   ├── gmail.ts             # Gmail commands + profile management
│   └── telegram.ts          # Telegram commands + profile management
├── services/                # API clients (one folder per service)
│   ├── gmail/client.ts      # Gmail API wrapper
│   └── telegram/client.ts   # Telegram Bot API wrapper
├── auth/                    # Authentication logic
│   ├── oauth.ts             # Google OAuth flow (browser-based)
│   ├── token-manager.ts     # Token validation/refresh
│   └── token-store.ts       # Encrypted credential storage
├── config/
│   └── config-manager.ts    # Profile configuration
├── types/                   # TypeScript interfaces
│   ├── config.ts            # Config and ServiceName types
│   ├── tokens.ts            # Credential storage types
│   ├── gmail.ts             # Gmail message types
│   └── telegram.ts          # Telegram API types
└── utils/
    ├── errors.ts            # CliError class and error handling
    ├── output.ts            # Output formatting functions
    └── stdin.ts             # Stdin reading utility
```

## Key Patterns

### Multi-Profile Architecture

Each service supports multiple named profiles. Config and credentials are stored separately:
- **Config**: `~/.config/agentio/config.json` - profile names and defaults
- **Credentials**: `~/.config/agentio/tokens.enc` - encrypted with AES-256-GCM

### Adding a New Service

1. Add service name to `ServiceName` type in `src/types/config.ts`
2. Create types in `src/types/<service>.ts`
3. Create API client in `src/services/<service>/client.ts`
4. Create commands in `src/commands/<service>.ts` with:
   - Service operations (list, get, send, etc.)
   - Profile subcommands (add, list, remove)
5. Register commands in `src/index.ts`

### Error Handling

Use `CliError` for all user-facing errors:
```typescript
throw new CliError('ERROR_CODE', 'message', 'suggestion');
```

Wrap command actions with `try/catch` and call `handleError(error)`.

### Output Convention

- **Success**: Print to stdout (human-readable format optimized for LLM consumption)
- **Errors/Progress**: Print to stderr
- Use formatting functions from `src/utils/output.ts`

## Current Commands

```
agentio gmail list [--limit N] [--query Q] [--label L]
agentio gmail get <message-id> [--format text|html|raw] [--body-only]
agentio gmail search --query <query> [--limit N]
agentio gmail send --to <email> --subject <subject> [--body <body>] [--attachment <path>]
agentio gmail reply --thread-id <id> [--body <body>]
agentio gmail archive <message-id>
agentio gmail mark <message-id> --read|--unread
agentio gmail profile add [--profile <name>]
agentio gmail profile list
agentio gmail profile remove --profile <name>

agentio telegram send <message> [--parse-mode html|markdown] [--silent]
agentio telegram profile add [--profile <name>]
agentio telegram profile list
agentio telegram profile remove --profile <name>
```

## Design Decisions

- **Embedded OAuth credentials**: Gmail uses embedded OAuth client ID/secret (no user setup required)
- **Machine-bound encryption**: Credentials are encrypted with a key derived from hostname+username
- **Dynamic OAuth port**: Uses ports 3000-3010 for OAuth callback
- **Stdin support**: Commands like `send` and `reply` accept body via pipe

## Service Development Guidelines

These guidelines are derived from the existing Gmail, Telegram, and GChat implementations.

### File Organization

Each service consists of exactly 3 files:

| File | Purpose |
|------|---------|
| `src/types/{service}.ts` | TypeScript interfaces (no imports from project) |
| `src/services/{service}/client.ts` | API client class |
| `src/commands/{service}.ts` | CLI commands and profile management |

### Naming Conventions

**Functions:**
- Entry point: `register{Service}Commands(program: Command)`
- Client factory: `get{Service}Client(profileName?): Promise<{client, profile}>`
- Setup helpers: `setup{Type}Profile(profileName)` (e.g., `setupWebhookProfile`)

**Types:**
- Credentials: `{Service}Credentials` (use discriminated union if multiple auth types)
- Messages: `{Service}Message`
- Options: `{Service}SendOptions`, `{Service}ListOptions`, etc.
- Results: `{Service}SendResult`

**Client:**
- Class name: `{Service}Client`
- Public methods: verb-based (`send`, `list`, `get`, `archive`, `mark`)
- Private methods: `parse{Entity}()`, `build{Thing}()`, `get{Resource}()`

### API Client Pattern

```typescript
export class {Service}Client {
  private credentials: {Service}Credentials;

  constructor(credentials: {Service}Credentials) {
    this.credentials = credentials;
  }

  // Public: one method per operation
  async send(options: {Service}SendOptions): Promise<{Service}SendResult> { }
  async list(options?: {Service}ListOptions): Promise<{Service}Message[]> { }
  async get(id: string): Promise<{Service}Message> { }

  // Private: helpers and request wrappers
  private async request<T>(method: string, params?: Record<string, unknown>): Promise<T> { }
  private parseMessage(raw: unknown): {Service}Message { }
}
```

**For services with multiple auth types** (like GChat with webhook/oauth):
- Use discriminated union: `type {Service}Credentials = WebhookCreds | OAuthCreds`
- Add `type` field to each variant
- Dispatch in public methods based on credential type

### Command Structure

```typescript
export function register{Service}Commands(program: Command): void {
  const {service} = program
    .command('{service}')
    .description('{Service} operations');

  // Operation commands
  {service}
    .command('send')
    .argument('[message]', 'Message text')
    .option('--profile <name>', 'Profile name')
    .option('--option <value>', 'Description', 'default')
    .action(async (message, options) => {
      try {
        const { client } = await get{Service}Client(options.profile);
        // Handle stdin fallback
        const text = message || await readStdin();
        if (!text) throw new CliError('INVALID_PARAMS', 'Message required');
        const result = await client.send({ text, ...options });
        print{Service}SendResult(result);
      } catch (error) {
        handleError(error);
      }
    });

  // Profile subcommands (add, list, remove)
  const profile = {service}.command('profile').description('Manage profiles');
  profile.command('add')...
  profile.command('list')...
  profile.command('remove')...
}
```

### Error Handling

**Error codes** (use consistently across all services):
- `AUTH_FAILED` - Invalid credentials or authentication failure
- `PROFILE_NOT_FOUND` - Profile doesn't exist
- `INVALID_PARAMS` - Invalid user input
- `NOT_FOUND` - Resource not found (HTTP 404)
- `PERMISSION_DENIED` - Insufficient permissions (HTTP 403)
- `RATE_LIMITED` - Rate limit exceeded (HTTP 429)
- `API_ERROR` - Generic API error
- `NETWORK_ERROR` - Network/connection error

**HTTP status mapping in client:**
```typescript
private getErrorCode(status: number): string {
  if (status === 401) return 'AUTH_FAILED';
  if (status === 403) return 'PERMISSION_DENIED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  return 'API_ERROR';
}
```

### Profile Management

**Three required subcommands:**
1. `profile add` - Interactive setup, validate credentials, store encrypted
2. `profile list` - Show all profiles with default marker and metadata
3. `profile remove` - Delete config and credentials

**Client factory pattern:**
```typescript
async function get{Service}Client(profileName?: string): Promise<{ client: {Service}Client; profile: string }> {
  const profile = await getProfile('{service}', profileName);
  if (!profile) {
    throw new CliError('PROFILE_NOT_FOUND', 'No profile configured', 'Run: agentio {service} profile add');
  }

  const credentials = await getCredentials<{Service}Credentials>('{service}', profile);
  if (!credentials) {
    throw new CliError('AUTH_FAILED', 'Credentials not found', `Run: agentio {service} profile add --profile ${profile}`);
  }

  return { client: new {Service}Client(credentials), profile };
}
```

### Type Patterns

**Credentials interface:**
```typescript
export interface {Service}Credentials {
  // Required fields for API access
  token: string;
  // Optional metadata for display
  username?: string;
  displayName?: string;
}

// For multiple auth types:
export type {Service}Credentials = {Service}TokenCredentials | {Service}OAuthCredentials;

export interface {Service}TokenCredentials {
  type: 'token';
  token: string;
}

export interface {Service}OAuthCredentials {
  type: 'oauth';
  accessToken: string;
  refreshToken: string;
  expiryDate: number;
}
```

**Options interfaces:**
```typescript
export interface {Service}SendOptions {
  // Required fields (no ?)
  text: string;
  // Optional fields
  format?: 'text' | 'html';
  silent?: boolean;
}
```

### Output Conventions

**Create formatters in `src/utils/output.ts`:**
```typescript
export function print{Service}SendResult(result: {Service}SendResult): void
export function print{Service}MessageList(messages: {Service}Message[]): void
export function print{Service}Message(message: {Service}Message): void
```

**Routing:**
- `console.log()` - Success output (stdout, for LLM parsing)
- `console.error()` - Progress, prompts, setup instructions (stderr)

### Input Handling

**Support both argument and stdin:**
```typescript
let text = argument;
if (!text) {
  text = await readStdin();
}
if (!text) {
  throw new CliError('INVALID_PARAMS', 'Message required', 'Provide message as argument or pipe via stdin');
}
```

### Checklist for New Service

- [ ] Add service name to `ServiceName` in `src/types/config.ts`
- [ ] Create `src/types/{service}.ts` with credentials and message interfaces
- [ ] Create `src/services/{service}/client.ts` with `{Service}Client` class
- [ ] Create `src/commands/{service}.ts` with `register{Service}Commands()`
- [ ] Add output formatters to `src/utils/output.ts`
- [ ] Register commands in `src/index.ts`
- [ ] Test all operations: send, list, get (as applicable)
- [ ] Test profile management: add, list, remove
