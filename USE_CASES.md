# Use Cases

## Plugin Install (`agentio claude install`)

### Team Onboarding & Consistency
- New developer clones repo, runs `agentio claude install` → gets all team skills/commands/hooks instantly
- `agentio.json` becomes like `package.json` for Claude Code plugins and marketplaces - version-controlled, reproducible environments
- Ensures everyone on the team has identical Claude Code capabilities

### CI/CD Agent Environments
- GitHub Actions / GitLab CI jobs can install plugins at workflow start
- Ephemeral runners get consistent Claude Code tooling per-project
- Different repos can have different plugin configurations

## Config Export/Import (`agentio config export/import`)

### CI/CD Credential Injection
- Export config once, store encrypted file + key as CI secrets
- Workflows import credentials at runtime → agents can send notifications, update tickets
- Credentials never baked into Docker images

### Automated Notifications Pipeline
- PR merged → agent sends Slack message
- Deployment complete → agent sends Telegram alert
- Build failed → agent emails the team
- JIRA ticket auto-transitions on release

### Team Shared Bot Accounts
- Export shared bot credentials (Telegram bot, Slack webhook, shared Gmail)
- Distribute encrypted file + key via secure channel
- Everyone uses same bot identity for consistent messaging

### Multi-Environment Setup
- Separate exports for dev/staging/prod
- CI imports the right config based on `$ENVIRONMENT`
- Same workflows, different notification targets

### Machine Migration / Backup
- Developer gets new laptop → import existing config
- Disaster recovery → restore from encrypted backup
- No re-authentication dance for every service

### Ephemeral/Containerized Agents
- Spin up agent containers that need service access
- Mount encrypted config, pass key via env var
- Container authenticates instantly, does its job, terminates

---

The common theme: **enabling LLM agents to operate autonomously in automated pipelines** while keeping credentials secure and environments reproducible.
