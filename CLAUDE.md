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
bun run build              # JS bundle to dist/index.js (run with `bun`)
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
│   ├── dropbox.ts           # Dropbox commands
│   ├── telegram.ts          # Telegram commands (send)
│   ├── gchat.ts             # Google Chat commands
│   ├── github.ts            # GitHub commands
│   ├── jira.ts              # JIRA commands
│   ├── slack.ts             # Slack commands
│   ├── revolut.ts           # Revolut Business commands
│   ├── rss.ts               # RSS feed commands
│   ├── discourse.ts         # Discourse forum commands
│   ├── sql.ts               # SQL database commands
│   ├── daemon.ts            # Daemon commands (scheduler lifecycle)
│   ├── schedule.ts          # Schedule folder registration
│   ├── mcp.ts               # Local MCP server commands
│   ├── vault-config.ts      # Vault contents: export/import/env/clear
│   ├── status.ts            # Profile status display
│   ├── update.ts            # CLI self-update
│   ├── vault.ts             # Vault group: set/status + registers the two below
│   ├── vault-init.ts        # Vault lifecycle: init/passphrase/reset
│   ├── docs.ts              # Documentation generator
│   └── claude.ts            # Claude Code plugin operations
├── services/                # API clients (one folder per service)
│   ├── gmail/client.ts      # Gmail API wrapper
│   ├── gdocs/client.ts      # Google Docs API wrapper
│   ├── gdrive/client.ts     # Google Drive API wrapper
│   ├── dropbox/client.ts    # Dropbox API wrapper
│   ├── telegram/client.ts   # Telegram Bot API wrapper
│   ├── gchat/client.ts      # Google Chat API wrapper
│   ├── github/client.ts     # GitHub API wrapper
│   ├── jira/client.ts       # JIRA API wrapper
│   ├── slack/client.ts      # Slack API wrapper
│   ├── revolut/client.ts    # Revolut Business API wrapper
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
│   ├── dropbox-oauth.ts     # Dropbox PKCE OAuth flow
│   ├── jira-oauth.ts        # JIRA OAuth flow
│   ├── revolut-oauth.ts     # Revolut JWT client-assertion + token flow
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
│   ├── dropbox.ts           # Dropbox types
│   ├── telegram.ts          # Telegram types
│   ├── gchat.ts             # Google Chat types
│   ├── github.ts            # GitHub types
│   ├── jira.ts              # JIRA types
│   ├── slack.ts             # Slack types
│   ├── revolut.ts           # Revolut types
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

### Vault

All agentio config + credentials live in a single encrypted **vault** file. `vault` is the only command that manages it; every other command requires one to exist.

```bash
agentio vault init [--path <p>] [--passphrase <v> | --passphrase-stdin] [--no-migrate]
agentio vault set <path> [--passphrase <v> | --passphrase-stdin]   # switch to an existing vault
agentio vault status                       # active path + profile count
agentio vault passphrase [--passphrase <v> | --passphrase-stdin]   # change it
agentio vault reset [--force]              # DELETES the vault file
agentio vault export [--file <path>] [--all] [--key <hex>]
agentio vault import [file] [--merge]
agentio vault env [set <k> <v> | unset <k>]
agentio vault clear [--force]
```

- Vault location defaults to `~/.config/agentio/vault.enc`; a pointer file at `~/.config/agentio/vault.path` tracks the current path.
- Passphrase is stored in `~/.config/agentio/vault.passphrase` (mode 0600). Commands read it silently. Keep this path off any cloud-synced location — the encrypted vault may be synced, the passphrase must not be.
- `AGENTIO_PASSPHRASE` env var takes precedence over the file when set.
- Runtime files (`daemon.log`) remain plaintext under `~/.config/agentio/`.

**Non-interactive passphrase** — every passphrase-taking command resolves in this order: `--passphrase-stdin` > `--passphrase` > `AGENTIO_PASSPHRASE` > interactive prompt. Off a TTY with none of the first three, they error rather than hang. Prefer `--passphrase-stdin` in scripts; `--passphrase` lands in shell history and is visible in `ps`.

**init vs set** — `init` creates a new vault (and imports legacy config unless `--no-migrate`). `set` points at a vault that already exists, which is the multi-machine case: the encrypted vault is synced, the passphrase file is not. `set` verifies by decrypting *before* writing the pointer, so a wrong passphrase changes nothing, and it never moves or deletes either vault file. To relocate a vault, move the file yourself then `vault set` the new path.

**`vault env` is not a general env-var store.** Only `AGENTIO_DAEMON_URL` and `AGENTIO_DAEMON_API_KEY` are ever read (by `daemon/client.ts`). Stored values are *not* exported to your shell or injected into processes agentio spawns — scheduled `.run.md` jobs inherit your real environment. Other keys are carried by `vault export`/`import` but nothing reads them.

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
agentio gdrive mkdir <name> [--parent <id>]
agentio gdrive rename <file-id-or-url> <new-name>
agentio gdrive move <file-id-or-url> <folder-id-or-url>
agentio gdrive trash <file-id-or-url>
agentio gdrive profile add|list|remove
```

### Dropbox

Full-Dropbox access via the HTTP API v2. There are no embedded OAuth
credentials: each user registers their own app in the Dropbox App Console and
`profile add` collects the App key.

```bash
agentio dropbox list [path] [--limit N] [--recursive] [--folders]
agentio dropbox get <path>
agentio dropbox search --query <text> [--path <p>] [--limit N] [--filename-only]
agentio dropbox download <path> [--output <p>]        # folders arrive as a zip
agentio dropbox put <file-path> [--path <dest>] [--overwrite]
agentio dropbox mkdir <path>
agentio dropbox move <from> <to>                      # also renames
agentio dropbox copy <from> <to>
agentio dropbox delete <path> [--force]
agentio dropbox link <path> [--temporary]
agentio dropbox account
agentio dropbox profile add [--app-key <key>] | list | update | remove
```

Auth notes:

- OAuth 2 with PKCE and **no redirect URI**: Dropbox renders the authorisation
  code in the browser, so there is no app-console redirect to register and no
  local callback server. `profile add` prints the consent URL and reads the
  pasted code.
- The app must be created as **Scoped access / Full Dropbox**, with these
  permissions enabled in the console: `account_info.read`,
  `files.metadata.read`, `files.content.read`, `files.content.write`,
  `sharing.read`, `sharing.write`. The scopes are also requested in the consent
  URL, so a missing one fails loudly at authorisation time.
- Access tokens last 4 hours; the refresh token is long-lived and Dropbox does
  **not** rotate it, so only the access token is replaced on refresh.
- Paths are absolute from the Dropbox root (`/Documents/report.pdf`); the
  account root is the empty string. Casing is preserved, matching is
  case-insensitive. `id:`/`rev:` identifiers are passed through untouched.
- `Dropbox-API-Arg` is an HTTP header, so its JSON is `\u`-escaped to stay
  ASCII — accented file names break otherwise.
- Uploads above 150 MB automatically switch to a chunked upload session.
- Writes (`put`, `mkdir`, `move`, `copy`, `delete`, and shared-link creation)
  honour the read-only profile flag.

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

### Revolut

Revolut Business API. Unlike the Google services there are no embedded OAuth
credentials: each business uploads its own X.509 certificate to Revolut and
receives a Client ID, so `profile add` collects those interactively.

```bash
agentio revolut accounts [--format text|json]
agentio revolut transactions [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--account <id>] [--counterparty <id>] [--type <type>] [--count N] [--format text|json|csv]
agentio revolut transaction <id> [--format text|json]
agentio revolut counterparties list [--format text|json]
agentio revolut counterparties get <id> [--format text|json]
agentio revolut counterparties add (--company-name <name> | --first-name <n> --last-name <n>) --bank-country <code> --currency <code> [--iban <iban>] [--bic <bic>] [--account-no <no>] [--sort-code <code>] [--routing-number <no>] [--email <email>] [--phone <phone>]
agentio revolut counterparties delete <id> [--force]
agentio revolut pay --from <account-id> --amount <n> --currency <code> [--to <counterparty-id|own-account-id>] [--to-account <id>] [--to-card <id>] [--reference <text>] [--charge-bearer shared|debtor] [--reason-code <code>] [--request-id <id>] [--draft] [--title <text>] [--on YYYY-MM-DD] [--link --name <recipient> [--expires-in <P1D..P7D>] [--method revolut|bank_account|card]... [--save-counterparty]] [--force] [--format text|json]
agentio revolut drafts list [--source api|integration|email|all] | get <id> | delete <id> [--force]
agentio revolut links list [--created-before <ts>] [--limit N] | get <id> | cancel <id> [--force]
agentio revolut profile add [--environment production|sandbox] [--client-id <id>] [--private-key <path>] [--redirect-uri <uri>]
agentio revolut profile list|update|remove
```

Money movement notes:

- `pay` is the single entry point for every outbound route. The destination
  decides the endpoint: a `--to` that matches one of your own accounts is an
  internal `POST /transfer`, anything else is a counterparty `POST /pay`. The
  confirmation line names the route before anything moves.
- `--draft` (implied by `--on`) creates a `POST /payment-drafts` entry instead.
  Nothing moves until it is approved in the Revolut Business app, and that is
  also the only way to schedule a payment for a future date — `/pay` has no
  `schedule_for`.
- `--link` creates a payout link: the money is blocked on the account and the
  recipient supplies their own bank details when they claim the URL. UK, EEA,
  AU and SG only.
- Every create call sends a `request_id`. A UUID is generated when
  `--request-id` is omitted; Revolut de-duplicates repeats for two weeks, so
  retrying with the same ID cannot double-pay.
- The API app must hold the `PAY` permission. A read-only Revolut app gets a
  403 no matter what the profile flag says; the local `readOnly` profile flag
  blocks the write before the request is made.

Auth notes:

- Every token request is authenticated by an RS256 JWT (`client_assertion`)
  signed with the private key, built in `src/auth/revolut-oauth.ts` using
  `node:crypto` — no JWT dependency.
- The JWT `iss` claim is the **host** of the registered redirect URI, not the
  full URI. `sub` is the Client ID and `aud` is always `https://revolut.com`.
- `profile add` prints the consent URL and accepts either the pasted redirect
  URL or a bare code. Authorisation codes expire about two minutes after issue.
- Access tokens last 40 minutes, so nearly every invocation refreshes first.
  Revolut does **not** rotate refresh tokens — only the access token is replaced.
- The private key is stored in the vault (encrypted at rest), not referenced by
  path, so no plaintext key needs to stay on disk.
- Writes (`pay`, `drafts delete`, `links cancel`, `counterparties add`/`delete`)
  honour the read-only profile flag.

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
