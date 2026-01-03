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
