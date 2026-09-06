# agentio

**Run LLM agent workflows in GitHub Actions. No servers. No Zapier. Just cron.**

agentio is a CLI that lets LLM agents interact with Gmail, Slack, JIRA, Telegram, Google Chat, and RSS feeds. Designed for CI/CD pipelines and scheduled automation.

## Why agentio?

You want your AI agent to:
- Send a daily Slack summary of unread emails
- Monitor RSS feeds and post to Telegram
- Update JIRA tickets based on email threads
- Run on a schedule, without managing servers

**agentio makes this trivial.** Authenticate once locally, export your config as a single encrypted file, and run anywhere — GitHub Actions, GitLab CI, or any CI/CD platform.

## Quick Example

List your unread emails, then read one as plain text:

```bash
# List the 5 most recent unread messages (id, sender, subject, snippet)
agentio gmail list --query "is:unread" --limit 5

# Read one by id — body only, no headers
agentio gmail get <message-id> --format text --body-only
```

Everything is a plain CLI command, so you can pipe, script, or hand it to an agent:

```bash
# Send a Slack message
agentio slack send "Deploy finished ✅"

# Search JIRA
agentio jira search --jql "assignee = currentUser() AND status = 'In Progress'"

# Upload a file to Google Drive
agentio gdrive put ./report.pdf --folder <folder-id>
```

### Run it in a GitHub workflow

The same commands work in CI. Authenticate once locally, export your config as an
encrypted file, store it as a secret, and run anywhere:

```yaml
# .github/workflows/inbox-triage.yml
name: Inbox Triage
on:
  workflow_dispatch:

jobs:
  triage:
    runs-on: ubuntu-latest
    env:
      AGENTIO_CONFIG: ${{ secrets.AGENTIO_CONFIG }}
      AGENTIO_KEY: ${{ secrets.AGENTIO_KEY }}
    steps:
      - run: curl -LsSf https://agentio.houlahop.com/install | sh
      - run: agentio vault import
      - run: |
          agentio gmail list --query "is:unread" --limit 5
          agentio slack send "Inbox checked ✅"
```

## Install

**macOS / Linux:**
```bash
curl -LsSf https://agentio.houlahop.com/install | sh
```

**Windows (PowerShell):**
```powershell
iwr -useb https://agentio.houlahop.com/install.ps1 | iex
```

<details>
<summary><strong>Other methods</strong> (Homebrew, Scoop, npm)</summary>

**Homebrew (macOS/Linux):**
```bash
brew tap plosson/agentio
brew install agentio
```

**Scoop (Windows):**
```powershell
scoop bucket add agentio https://github.com/plosson/scoop-agentio
scoop install agentio
```

**npm / bun:**
```bash
npx @plosson/agentio --help
# or global install
npm install -g @plosson/agentio
```

agentio is a Bun program: the published package ships TypeScript sources and
runs under `bun`, so this route needs [Bun](https://bun.sh) already on your
PATH. npm will install it happily without Bun and then fail on first run. The
standalone installers above embed the runtime and have no such requirement.

</details>

## Setup: Authenticate Once, Run Anywhere

### 1. Authenticate locally

```bash
# Add your Gmail account (opens browser for OAuth)
agentio gmail profile add

# Add Slack webhook
agentio slack profile add

# Add any other services you need...
```

### 2. Export your config

```bash
agentio vault export
# Outputs:
#   ✓ Exported to agentio.config
#   ✓ Encryption key: abc123...
#
# Store BOTH in your CI/CD secrets!
```

All credentials are encrypted with AES-256-GCM. The export file is useless without the key.

**Note:** GitHub secrets are limited to 48KB per secret. Only add the profiles you need for your workflow to keep the exported config small.

### 3. Add to GitHub Secrets

| Secret | Value |
|--------|-------|
| `AGENTIO_CONFIG` | Base64-encoded contents of `agentio.config` |
| `AGENTIO_KEY` | The encryption key from export |

```bash
# Get base64 for GitHub secret
cat agentio.config | base64
```

### 4. Use in your workflow

```yaml
env:
  AGENTIO_CONFIG: ${{ secrets.AGENTIO_CONFIG }}
  AGENTIO_KEY: ${{ secrets.AGENTIO_KEY }}

steps:
  - run: agentio vault import  # Auto-detects env vars
  - run: agentio gmail list --limit 10
```

Done. Your agent can now access all your services securely in CI/CD.

## Services

| Service | Auth | Commands |
|---------|------|----------|
| **Gmail** | OAuth | `list`, `get`, `search`, `send`, `reply`, `archive`, `mark`, `attachment`, `export` |
| **Slack** | Webhook | `send` |
| **Telegram** | Bot Token | `send` |
| **Google Chat** | Webhook/OAuth | `send`, `list`, `get` |
| **JIRA** | OAuth | `projects`, `search`, `get`, `comment`, `transitions`, `transition` |
| **Revolut** | Certificate + OAuth | `accounts`, `transactions`, `transaction`, `counterparties`, `pay` (drafts only), `drafts`, `links` |
| **Discourse** | API Key | `list`, `get`, `categories` |
| **RSS** | None | `articles`, `get`, `info` |

## Usage Examples

<details>
<summary><strong>Gmail</strong></summary>

```bash
# List recent emails
agentio gmail list --limit 10

# Search
agentio gmail search --query "from:boss@company.com is:unread"

# Get specific email
agentio gmail get <message-id>

# Send (body from stdin works great with LLMs)
echo "Generated by my agent" | agentio gmail send --to user@example.com --subject "Daily Report"

# Download attachments
agentio gmail attachment <message-id> --output ./downloads

# Export as PDF
agentio gmail export <message-id> --output email.pdf
```

</details>

<details>
<summary><strong>Slack</strong></summary>

```bash
# Send message
agentio slack send "Deployment complete ✓"

# Send rich Block Kit message
agentio slack send --json blocks.json
```

</details>

<details>
<summary><strong>Telegram</strong></summary>

```bash
# Send to channel
agentio telegram send "Alert: New items found"

# With markdown
agentio telegram send --parse-mode markdown "**Bold** and _italic_"
```

</details>

<details>
<summary><strong>JIRA</strong></summary>

```bash
# List projects
agentio jira projects

# Search issues
agentio jira search --project MYPROJ --status "In Progress"
agentio jira search --jql "assignee = currentUser() AND status != Done"

# Get issue details
agentio jira get PROJ-123

# Add comment
agentio jira comment PROJ-123 "Automated update from CI"

# Transition issue
agentio jira transitions PROJ-123  # see available transitions
agentio jira transition PROJ-123 <transition-id>
```

</details>

<details>
<summary><strong>RSS</strong></summary>

```bash
# List articles (auto-discovers feed URL)
agentio rss articles https://simonwillison.net --limit 10

# Filter by date
agentio rss articles https://blog.example.com --since 2025-01-01

# Get full article
agentio rss get https://simonwillison.net <article-url>
```

</details>

## Multi-Profile Support

Manage multiple accounts per service:

```bash
# Add named profiles
agentio gmail profile add --profile work
agentio gmail profile add --profile personal

# Use specific profile
agentio gmail list --profile work
```

## Workflow Examples

The [`examples/`](./examples) folder contains ready-to-use workflows. Here's how it works:

### Daily Email Briefing → Slack

```yaml
name: Daily Briefing
on:
  schedule:
    - cron: '0 7 * * 1-5'  # Weekdays at 7 AM UTC

jobs:
  briefing:
    runs-on: ubuntu-latest
    env:
      AGENTIO_CONFIG: ${{ secrets.AGENTIO_CONFIG }}
      AGENTIO_KEY: ${{ secrets.AGENTIO_KEY }}
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
    steps:
      - uses: actions/checkout@v4
      - run: curl -LsSf https://agentio.houlahop.com/install | sh
      - run: npm install -g @anthropic-ai/claude-code
      - run: agentio vault import && agentio claude install
      - run: claude -p "$(cat prompt.md)" --max-turns 30 --dangerously-skip-permissions
```

The magic is in `prompt.md` — Claude reads your emails via the agentio plugin, analyzes them, and posts a summary to Slack:

```markdown
# Daily Email Briefing

1. Fetch unread emails from the last 24 hours using agentio-gmail
2. Categorize by urgency: Urgent / Important / FYI
3. Generate a morning briefing with one-line summaries
4. Send to Slack using agentio-slack
```

See [`examples/daily-briefing/`](./examples/daily-briefing) for the complete working example.

## Claude Code Integration

agentio includes skills for [Claude Code](https://claude.ai/download) that let Claude directly read your email, post to Slack, or query JIRA during conversations.

**Install skills:**

```bash
agentio claude install https://github.com/plosson/agentio  # marketplace
agentio claude install agentio-gmail@agentio               # Gmail skill
agentio claude install agentio-jira@agentio                # JIRA skill
```

**Then in Claude Code:**

> "Summarize my unread emails and post a summary to Slack"

Claude uses the installed skills to fetch emails and send the summary — no manual commands needed.

## Design Principles

- **Structured output** — Text output optimized for LLM parsing
- **Stdin support** — Pipe content to commands (`echo "msg" | agentio slack send`)
- **Single config export** — One encrypted file + key = full portability
- **Multi-profile** — Multiple accounts per service
- **No runtime dependencies** — Single binary, runs anywhere

## License

MIT
