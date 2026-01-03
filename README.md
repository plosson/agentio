# agentio

CLI for LLM agents to interact with communication and tracking services.

## Installation

### macOS

**Homebrew (recommended):**
```bash
brew tap plosson/agentio
brew install agentio
```

**Or download binary:**
```bash
# Apple Silicon
curl -L https://github.com/plosson/agentio/releases/latest/download/agentio-darwin-arm64 -o agentio
chmod +x agentio && sudo mv agentio /usr/local/bin/

# Intel
curl -L https://github.com/plosson/agentio/releases/latest/download/agentio-darwin-x64 -o agentio
chmod +x agentio && sudo mv agentio /usr/local/bin/
```

### Linux

**Debian/Ubuntu (.deb):**
```bash
# x64
curl -LO https://github.com/plosson/agentio/releases/latest/download/agentio_0.1.3_amd64.deb
sudo dpkg -i agentio_0.1.3_amd64.deb

# ARM64
curl -LO https://github.com/plosson/agentio/releases/latest/download/agentio_0.1.3_arm64.deb
sudo dpkg -i agentio_0.1.3_arm64.deb
```

**Homebrew:**
```bash
brew tap plosson/agentio
brew install agentio
```

**Or download binary:**
```bash
# x64
curl -L https://github.com/plosson/agentio/releases/latest/download/agentio-linux-x64 -o agentio
chmod +x agentio && sudo mv agentio /usr/local/bin/

# ARM64
curl -L https://github.com/plosson/agentio/releases/latest/download/agentio-linux-arm64 -o agentio
chmod +x agentio && sudo mv agentio /usr/local/bin/
```

### Windows

**Scoop (recommended):**
```powershell
scoop bucket add agentio https://github.com/plosson/scoop-agentio
scoop install agentio
```

**Or download binary:**

Download `agentio-windows-x64.exe` from [GitHub Releases](https://github.com/plosson/agentio/releases/latest) and add to your PATH.

### npm / bun

```bash
# Run directly
bunx @plosson/agentio --help
npx @plosson/agentio --help

# Global install
bun add -g @plosson/agentio
npm install -g @plosson/agentio
```

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
