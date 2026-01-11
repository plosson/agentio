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

agentio provides plugins for [Claude Code](https://claude.ai/download) with skills for Gmail, Telegram, and Google Chat operations.

### Install the Plugin

```bash
# Install from GitHub
agentio claude plugin install plosson/agentio

# Or install from a full GitHub URL
agentio claude plugin install https://github.com/plosson/agentio

# Install to a specific directory
agentio claude plugin install plosson/agentio -d ~/myproject

# Install only skills (skip commands and hooks)
agentio claude plugin install plosson/agentio --skills

# Force reinstall if already exists
agentio claude plugin install plosson/agentio -f
```

Once installed, Claude Code can use the agentio CLI skills to help you manage emails, send Telegram messages, and more.

### Manage Plugins

```bash
# List installed plugins
agentio claude plugin list

# Remove a plugin
agentio claude plugin remove agentio
```

### Install from agentio.json

If your project has an `agentio.json` file listing plugins, you can install all of them at once:

```bash
# Install all plugins from agentio.json in current directory
agentio claude plugin install
```

Plugins are installed to `.claude/` in the target directory (skills, commands, and hooks subdirectories).

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
