# Daily Briefing Example

A minimal example that fetches unread emails and posts a categorized summary to Slack.

## Setup

### 1. Configure agentio locally

```bash
agentio gmail profile add
agentio slack profile add
agentio config export
```

### 2. Get Claude Code OAuth token

Run `claude setup-token` to authenticate and get a token for CI/CD:

```bash
claude setup-token
```

This opens a browser for authentication and outputs a token. Copy it for the next step.

### 3. Add GitHub Secrets

| Secret | Value |
|--------|-------|
| `AGENTIO_CONFIG` | `cat agentio.config \| base64` |
| `AGENTIO_KEY` | Encryption key from export |
| `CLAUDE_CODE_OAUTH_TOKEN` | Token from `claude setup-token` |

### 4. Copy this folder to your repo and push

## Files

| File | Purpose |
|------|---------|
| `agentio.json` | Declares which agentio plugins to install |
| `prompt.md` | Instructions for Claude |
| `.github/workflows/daily-briefing.yml` | GitHub Actions workflow |

## Customization

- Edit `prompt.md` to change the briefing format
- Modify the cron schedule in the workflow
- Add more plugins to `agentio.json` (e.g., `agentio-telegram@agentio`)
