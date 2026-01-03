# agentio

CLI for LLM agents to interact with communication and tracking services.

## Installation

### Via npm/bun (recommended)

```bash
# Using bun
bunx agentio --help

# Using npm
npx agentio --help

# Global install
bun add -g agentio
# or
npm install -g agentio
```

### Native binaries

Download from [GitHub Releases](https://github.com/plosson/agentio/releases):

| Platform | Binary |
|----------|--------|
| macOS Intel | `agentio-darwin-x64` |
| macOS Apple Silicon | `agentio-darwin-arm64` |
| Linux x64 | `agentio-linux-x64` |
| Linux ARM64 | `agentio-linux-arm64` |
| Windows x64 | `agentio-windows-x64.exe` |

## Services

| Service | Status | Commands |
|---------|--------|----------|
| Gmail | Available | `list`, `get`, `search`, `send`, `reply`, `archive`, `mark` |
| Telegram | Available | `send` |
| Slack | Planned | - |
| JIRA | Planned | - |
| Linear | Planned | - |

## Usage

### Gmail

```bash
# First, authenticate
agentio gmail profile add

# List recent emails
agentio gmail list --limit 10

# Search emails
agentio gmail search --query "from:boss@company.com is:unread"

# Get a specific email
agentio gmail get <message-id>

# Send an email
agentio gmail send --to user@example.com --subject "Hello" --body "Message body"

# Or pipe content
echo "Message body" | agentio gmail send --to user@example.com --subject "Hello"
```

### Telegram

```bash
# Set up bot profile (interactive wizard)
agentio telegram profile add

# Send message to channel
agentio telegram send "Hello from agentio!"

# Send with formatting
agentio telegram send --parse-mode markdown "**Bold** and _italic_"
```

## Multi-Profile Support

Each service supports multiple named profiles:

```bash
# Add profiles for different accounts
agentio gmail profile add --profile work
agentio gmail profile add --profile personal

# Use specific profile
agentio gmail list --profile work
```

## Design

agentio is designed for LLM consumption:

- **Structured output**: Human-readable text output optimized for LLM parsing
- **Clear errors**: Error messages written to stderr with suggestions
- **Stdin support**: Pipe content to commands that accept body text
- **Multi-profile**: Manage multiple accounts per service

## Configuration

Configuration is stored in `~/.config/agentio/`:

- `config.json` - Profile names and defaults
- `tokens.enc` - Encrypted credentials (AES-256-GCM)

## License

MIT
