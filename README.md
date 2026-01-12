# agentio

CLI for LLM agents to interact with communication and tracking services.

## Quick Install

**macOS / Linux:**
```bash
curl -LsSf https://agentio.work/install | sh
```

**Windows (PowerShell):**
```powershell
iwr -useb https://agentio.work/install.ps1 | iex
```

## Update

```bash
agentio update
```

## Alternative Installation Methods

<details>
<summary>Homebrew (macOS/Linux)</summary>

```bash
brew tap plosson/agentio
brew install agentio
```
</details>

<details>
<summary>Scoop (Windows)</summary>

```powershell
scoop bucket add agentio https://github.com/plosson/scoop-agentio
scoop install agentio
```
</details>

<details>
<summary>npm / bun</summary>

```bash
# Run directly
bunx @plosson/agentio --help
npx @plosson/agentio --help

# Global install
bun add -g @plosson/agentio
npm install -g @plosson/agentio
```
</details>

<details>
<summary>Direct binary download</summary>

Download from [GitHub Releases](https://github.com/plosson/agentio/releases/latest):
- macOS: `agentio-darwin-arm64` (Apple Silicon) or `agentio-darwin-x64` (Intel)
- Linux: `agentio-linux-x64` or `agentio-linux-arm64`
- Windows: `agentio-windows-x64.exe`
</details>

## Services

| Service | Status | Commands |
|---------|--------|----------|
| Gmail | Available | `list`, `get`, `search`, `send`, `reply`, `archive`, `mark`, `attachment`, `export` |
| Telegram | Available | `send` |
| Google Chat | Available | `send`, `list`, `get` |
| Slack | Available | `send` |
| JIRA | Available | `projects`, `search`, `get`, `comment`, `transitions`, `transition` |
| RSS | Available | `articles`, `get`, `info` |
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

# Download attachments
agentio gmail attachment <message-id>
agentio gmail attachment <message-id> --name "document.pdf" --output ./downloads

# Export email as PDF
agentio gmail export <message-id>
agentio gmail export <message-id> --output email.pdf
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

### Google Chat

```bash
# Set up profile (webhook or OAuth)
agentio gchat profile add

# Send message via webhook
agentio gchat send "Hello from agentio!"

# Send with JSON payload for rich messages
agentio gchat send --json message.json

# List messages (OAuth profiles only)
agentio gchat list --space <space-id>

# Get a specific message (OAuth profiles only)
agentio gchat get <message-id> --space <space-id>
```

### Slack

```bash
# Set up webhook profile
agentio slack profile add

# Send message
agentio slack send "Hello from agentio!"

# Send Block Kit message from JSON file
agentio slack send --json blocks.json
```

### JIRA

```bash
# Authenticate with OAuth
agentio jira profile add

# List projects
agentio jira projects

# Search issues
agentio jira search --project MYPROJ --status "In Progress"
agentio jira search --jql "assignee = currentUser() AND status != Done"

# Get issue details
agentio jira get PROJ-123

# Add a comment
agentio jira comment PROJ-123 "This is my comment"

# View available transitions
agentio jira transitions PROJ-123

# Transition an issue
agentio jira transition PROJ-123 <transition-id>
```

### RSS

```bash
# List articles from a blog (feed URL auto-discovered)
agentio rss articles https://simonwillison.net
agentio rss articles https://steipete.me --limit 5

# Filter by date
agentio rss articles https://blog.fsck.com --since 2025-01-01

# Get feed info (shows discovered feed URL)
agentio rss info https://kau.sh

# Get a specific article
agentio rss get https://simonwillison.net <article-url>
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

## Claude Code Integration

agentio provides plugins for [Claude Code](https://claude.ai/download) with skills for Gmail, Telegram, Google Chat, JIRA, and RSS operations.

### Install Marketplaces and Plugins

```bash
# Add a marketplace (auto-detected from URL)
agentio claude install https://github.com/plosson/agentio

# Install a plugin (auto-detected from name@marketplace format)
agentio claude install agentio-gmail@agentio

# Install all from agentio.json
agentio claude install
```

### Manage Plugins

```bash
# List marketplaces and plugins from agentio.json
agentio claude list

# Update marketplaces
agentio claude update
agentio claude update https://github.com/plosson/agentio

# Remove a marketplace or plugin
agentio claude remove https://github.com/plosson/agentio
agentio claude remove agentio-gmail@agentio
```

### agentio.json

Projects can define marketplaces and plugins in an `agentio.json` file:

```json
{
  "marketplaces": [
    "https://github.com/plosson/agentio"
  ],
  "plugins": [
    "agentio-gmail@agentio",
    "agentio-rss@agentio"
  ]
}
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

### Export/Import

Transfer configuration between machines:

```bash
# Export configuration (generates encryption key)
agentio config export

# Export with custom output file
agentio config export --output backup.config

# Import on another machine
agentio config import agentio.config --key <encryption-key>

# Or use environment variable
AGENTIO_KEY=<key> agentio config import agentio.config

# Merge with existing config instead of replacing
agentio config import agentio.config --key <key> --merge
```

## License

MIT
