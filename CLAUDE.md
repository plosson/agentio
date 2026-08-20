# agentio - Agent I/O CLI

A CLI designed for LLM agents to interact with communication services, productivity tools, and tracking systems. Features multi-profile support, encrypted credential storage, and a daemon for scheduled task execution.

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript
- **CLI Framework**: Commander.js
- **APIs**: googleapis, Telegram Bot API, Slack Web API, JIRA REST API, GitHub API

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
│   ├── gmail.ts             # Gmail commands
│   ├── gdocs.ts             # Google Docs commands
│   ├── gdrive.ts            # Google Drive commands
│   ├── telegram.ts          # Telegram commands (send)
│   ├── gchat.ts             # Google Chat commands
│   ├── github.ts            # GitHub commands
│   ├── jira.ts              # JIRA commands
│   ├── slack.ts             # Slack commands
│   ├── rss.ts               # RSS feed commands
│   ├── discourse.ts         # Discourse forum commands
│   ├── sql.ts               # SQL database commands
│   ├── daemon.ts            # Daemon commands (scheduler lifecycle)
│   ├── schedule.ts          # Schedule folder registration
│   ├── mcp.ts               # Local MCP server commands
│   ├── config.ts            # Configuration management
│   ├── status.ts            # Profile status display
│   ├── update.ts            # CLI self-update
│   ├── docs.ts              # Documentation generator
│   └── claude.ts            # Claude Code plugin operations
├── services/                # API clients (one folder per service)
│   ├── gmail/client.ts      # Gmail API wrapper
│   ├── gdocs/client.ts      # Google Docs API wrapper
│   ├── gdrive/client.ts     # Google Drive API wrapper
│   ├── telegram/client.ts   # Telegram Bot API wrapper
│   ├── gchat/client.ts      # Google Chat API wrapper
│   ├── github/client.ts     # GitHub API wrapper
│   ├── jira/client.ts       # JIRA API wrapper
│   ├── slack/client.ts      # Slack API wrapper
│   ├── rss/client.ts        # RSS feed parser
│   ├── discourse/client.ts  # Discourse API wrapper
│   └── sql/client.ts        # SQL database client
├── daemon/                  # Daemon for folder-watched scheduling
│   ├── daemon.ts            # Daemon lifecycle management
│   ├── api.ts               # HTTP API server (health + scheduler control)
│   ├── client.ts            # Daemon client for CLI
│   ├── types.ts             # Daemon type definitions
│   └── scheduler.ts         # In-process scheduler (60-second tick)
├── auth/                    # Authentication logic
│   ├── oauth.ts             # Google OAuth flow
│   ├── oauth-server.ts      # OAuth callback server
│   ├── github-oauth.ts      # GitHub OAuth flow
│   ├── jira-oauth.ts        # JIRA OAuth flow
│   ├── token-manager.ts     # Token validation/refresh
│   └── token-store.ts       # Encrypted credential storage
├── config/
│   ├── config-manager.ts    # Profile configuration
│   └── credentials.ts       # Credential helpers
├── types/                   # TypeScript interfaces
│   ├── config.ts            # Config and ServiceName types
│   ├── tokens.ts            # Credential storage types
│   ├── gmail.ts             # Gmail types
│   ├── gdocs.ts             # Google Docs types
│   ├── gdrive.ts            # Google Drive types
│   ├── telegram.ts          # Telegram types
│   ├── gchat.ts             # Google Chat types
│   ├── github.ts            # GitHub types
│   ├── jira.ts              # JIRA types
│   ├── slack.ts             # Slack types
│   ├── rss.ts               # RSS types
│   ├── discourse.ts         # Discourse types
│   ├── sql.ts               # SQL types
│   └── service.ts           # Generic service types
└── utils/
    ├── errors.ts            # CliError class and error handling
    ├── output.ts            # Output formatting functions
    ├── stdin.ts             # Stdin reading utility
    ├── interactive.ts       # Interactive prompts
    ├── client-factory.ts    # Generic client factory
    ├── profile-commands.ts  # Profile command helpers
    └── obscure.ts           # Credential obfuscation
```

## Commands Reference

### Setup (vault)

The agentio config + credentials are stored in a single encrypted **vault** file. First-time installs must run `agentio setup` before any other command.

```bash
agentio setup                  # First-time, migration, adopt existing, or manage vault
agentio setup --reset --force  # Wipe vault, pointer, and stored passphrase
```

- Vault location defaults to `~/.config/agentio/vault.enc`; a pointer file at `~/.config/agentio/vault.path` tracks the current path.
- Passphrase is stored in `~/.config/agentio/vault.passphrase` (mode 0600). Commands read it silently. Keep this path off any cloud-synced location (it's outside the typical Dropbox/iCloud roots by default).
- `AGENTIO_PASSPHRASE` env var takes precedence over the file when set.
- Runtime files (`daemon.log`) remain plaintext under `~/.config/agentio/`.

### Gmail

```bash
agentio gmail list [--limit N] [--query Q] [--label L]
agentio gmail get <message-id> [--format text|html|raw] [--body-only]
agentio gmail search --query <query> [--limit N]
agentio gmail send --to <email> --subject <subject> [--body <body>] [--attachment <path>] [--reply-to <thread-id>]
agentio gmail draft [draft-id] --to <email> --subject <subject> [--body <body>] [--attachment <path>] [--reply-to <thread-id>]  # pass draft-id to replace an existing draft
agentio gmail archive <message-id...>
agentio gmail mark <message-id...> --read|--unread
agentio gmail labels list
agentio gmail labels create <name>            # "/" nests in the Gmail UI
agentio gmail labels delete <name-or-id>      # user labels only
agentio gmail labels rename <old> <new>
agentio gmail filters list
agentio gmail filters get <id>
agentio gmail filters create [--from <email>] [--to <email>] [--subject <text>] [--query <q>] [--negated-query <q>] [--has-attachment] [--exclude-chats] [--size <bytes> --size-comparison larger|smaller] [--apply <label>]... [--remove <label>]... [--forward <email>]
agentio gmail filters delete <id...>
agentio gmail label <id...> [--apply <name>]... [--remove <name>]... [--thread]
agentio gmail attachment <message-id> [--output <dir>]
agentio gmail export <message-id> [--output <path>]  # Export as PDF
agentio gmail profile add|list|remove
```

### Google Docs

```bash
agentio gdocs list [--limit N]
agentio gdocs get <doc-id-or-url> [--format markdown|text|html]
agentio gdocs create --title <title> [--content <markdown>] [--folder <id>]
agentio gdocs profile add|list|remove
```

### Google Drive

```bash
agentio gdrive list [--limit N] [--folder <id>] [--type <mime-type>]
agentio gdrive folders [--parent <id>]
agentio gdrive get <file-id-or-url>
agentio gdrive search --query <query> [--limit N]
agentio gdrive download <file-id-or-url> [--output <path>] [--format <type>]
agentio gdrive put <file-path> [--folder <id>] [--name <name>]
agentio gdrive trash <file-id-or-url>
agentio gdrive profile add|list|remove
```

### Telegram

```bash
agentio telegram send [message] [--parse-mode html|markdown] [--silent]
agentio telegram profile add|list|remove
```

### Google Chat

```bash
agentio gchat send [message] [--profile <name>]
agentio gchat list [--limit N]           # OAuth profiles only
agentio gchat get <message-id>           # OAuth profiles only
agentio gchat spaces                     # OAuth profiles only
agentio gchat profile add|list|remove
```

### GitHub

```bash
agentio github install <repo>    # Install AGENTIO_KEY and AGENTIO_CONFIG as secrets
agentio github uninstall <repo>  # Remove secrets from repository
agentio github profile add|list|remove
```

### JIRA

```bash
agentio jira projects [--limit N]
agentio jira search --jql <query> [--limit N]
agentio jira get <issue-key>
agentio jira comment <issue-key> [body]
agentio jira transitions <issue-key>
agentio jira transition <issue-key> <transition-id>
agentio jira profile add|list|remove
```

### Slack

```bash
agentio slack send [message] [--channel <id>]
agentio slack profile add|list|remove
```

### RSS

```bash
agentio rss articles <url> [--limit N]
agentio rss get <url> <article-id>
agentio rss info <url>
```

### Discourse

```bash
agentio discourse list [--limit N] [--category <id>]
agentio discourse get <topic-id> [--limit N]  # Posts limit
agentio discourse categories
agentio discourse profile add|list|remove
```

### SQL

```bash
agentio sql query [query] [--limit N] [--format table|json|csv]
agentio sql profile add|list|remove
```

### Daemon

The daemon is a long-lived background process that fires scheduled `.run.md` prompts in watched folders.

```bash
agentio daemon install           # macOS: LaunchAgent; Linux: systemd unit
agentio daemon start [--foreground]
agentio daemon stop
agentio daemon restart
agentio daemon status
agentio daemon logs [--follow]
agentio daemon uninstall
```

The macOS LaunchAgent lives at `~/Library/LaunchAgents/me.agentio.daemon.plist` and runs as a user agent (no sudo).

### Schedule

The daemon watches folders registered via `schedule watch` and fires due `.run.md` schedules. Filesystem changes are picked up live via `fs.watch`; a 60-second tick provides the safety net. Users author `.run.md` files directly in their text editor; the CLI only manages folder registration and visibility.

```bash
agentio schedule create [name]             # Create a .run.md (interactive; -y for non-interactive)
agentio schedule watch <folder>            # Watch a folder for .run.md files
agentio schedule remove <folder>           # Stop watching a folder
agentio schedule list [--all-hosts]        # List watched folders + detected schedules
agentio schedule show <id>                 # Show one schedule's frontmatter + next run times
agentio schedule run <id>                  # Run a schedule immediately (delegates to daemon if running)
agentio schedule doctor [--model M]        # Check the claude CLI is installed and logged in
agentio schedule history                   # Last run of every job across watched folders
agentio schedule history <id>              # List all runs of one schedule
```

For the id-based commands (`show`, `run`, `history <id>`), the id is resolved by scanning all watched folders — CWD is irrelevant. Use `--folder` to disambiguate when the same id exists in multiple folders.

`.run.md` frontmatter requires a `host:` field. The daemon only fires schedules whose `host` matches the current hostname — ensures Dropbox-synced folders don't double-fire across machines.

### Configuration

```bash
agentio config export [--file <path>]      # Export as env vars or encrypted file
agentio config import [file]               # Import from file or AGENTIO_CONFIG env var
agentio config env set|get|list|remove     # Manage environment variables
agentio config clear [--force]             # Clear all config and credentials
```

### Utility Commands

```bash
agentio status [--no-test] [--json]        # Show all profiles and test credentials
agentio update [--force]                   # Update CLI to latest version
agentio docs [--format markdown|json]      # Output CLI reference for LLMs
agentio claude docs|agentio-json           # Claude Code plugin operations
```

## Key Architecture

### Multi-Profile Support

Each service supports multiple named profiles. Config and credentials are stored separately:
- **Config**: `~/.config/agentio/config.json` - profile names and defaults
- **Credentials**: `~/.config/agentio/tokens.enc` - encrypted with AES-256-GCM

### Daemon Architecture

The daemon provides:
- **HTTP API**: RESTful API on port 7890 for CLI communication (health + scheduler control)
- **In-process scheduler**: Watches registered folders and fires due `.run.md` schedules on a 60-second tick; catches up on startup for schedules that missed their last expected run

### Security

- **Machine-bound encryption**: Credentials encrypted with key derived from hostname+username
- **No plain-text secrets**: All sensitive data encrypted at rest
- **Embedded OAuth**: Google services use embedded OAuth credentials (no user setup)
- **Token refresh**: Automatic token refresh for OAuth services

## Design Decisions

- **Embedded OAuth credentials**: Gmail/GDocs/GDrive use embedded OAuth client (no user setup required)
- **Machine-bound encryption**: Credentials are encrypted with a key derived from hostname+username
- **Dynamic OAuth port**: Uses ports 3000-3010 for OAuth callback
- **Stdin support**: Commands like `send` accept body via pipe
- **Daemon for scheduling**: Folder-watched `.run.md` schedules require the daemon

## Service Development Guidelines

### File Organization

Each service consists of 2-3 files:

| File | Purpose |
|------|---------|
| `src/types/{service}.ts` | TypeScript interfaces |
| `src/services/{service}/client.ts` | API client class |
| `src/commands/{service}.ts` | CLI commands and profile management |

### Adding a New Service

1. Add service name to `ServiceName` type in `src/types/config.ts`
2. Create types in `src/types/<service>.ts`
3. Create API client in `src/services/<service>/client.ts`
4. Create commands in `src/commands/<service>.ts` with:
   - Service operations (list, get, send, etc.)
   - Profile subcommands (add, list, remove)
5. Register commands in `src/index.ts`
6. Add output formatters to `src/utils/output.ts`
7. Update status command if service has testable credentials

### Error Handling

Use `CliError` for all user-facing errors:
```typescript
throw new CliError('ERROR_CODE', 'message', 'suggestion');
```

**Error codes:**
- `AUTH_FAILED` - Invalid credentials or authentication failure
- `PROFILE_NOT_FOUND` - Profile doesn't exist
- `INVALID_PARAMS` - Invalid user input
- `NOT_FOUND` - Resource not found
- `PERMISSION_DENIED` - Insufficient permissions
- `RATE_LIMITED` - Rate limit exceeded
- `API_ERROR` - Generic API error
- `NETWORK_ERROR` - Network/connection error
- `CONFIG_ERROR` - Configuration error

### Output Convention

- **Success**: Print to stdout (human-readable format optimized for LLM consumption)
- **Errors/Progress**: Print to stderr
- Use formatting functions from `src/utils/output.ts`

### Checklist for New Service

- [ ] Add service name to `ServiceName` in `src/types/config.ts`
- [ ] Create `src/types/{service}.ts` with credentials and message interfaces
- [ ] Create `src/services/{service}/client.ts` with `{Service}Client` class
- [ ] Create `src/commands/{service}.ts` with `register{Service}Commands()`
- [ ] Add output formatters to `src/utils/output.ts`
- [ ] Register commands in `src/index.ts`
- [ ] Test all operations: send, list, get (as applicable)
- [ ] Test profile management: add, list, remove
- [ ] Update status command for the service (if relevant)
- [ ] Create an associated skill in claude/skills (look at the others for inspiration)
