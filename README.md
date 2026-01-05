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

## Claude Code Integration

agentio provides a plugin for [Claude Code](https://claude.com/claude-code) with skills for Gmail, Telegram, and Google Chat operations.

### Add the Marketplace

```bash
/plugin marketplace add plosson/agentio
```

### Install the Plugin

```bash
/plugin install agentio@agentio
```

Once installed, Claude Code can use the agentio CLI skills to help you manage emails, send Telegram messages, and more.

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
