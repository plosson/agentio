# agentio Brand Briefing

## Brand Essence

**One-liner:** Give your AI agents eyes, ears, and hands for the real world.

**Brand Position:** The I/O layer that connects LLM agents to email, chat, tickets, and more—designed for CI/CD pipelines.

**Core Promise:** Your agents can read Gmail, post to Slack, update JIRA, and more—without you managing servers or wrestling with APIs.

---

## Brand Personality

### Voice Attributes

| Attribute | Expression |
|-----------|------------|
| **Capable** | We handle the messy OAuth flows so you don't have to. |
| **Pragmatic** | Built for real agent workflows, not demos. |
| **Developer-first** | JSON output. Stdin support. Piping works. |
| **Quietly powerful** | Simple commands, serious capabilities. |

### Tone Guidelines

- **DO:** Show working workflows. Developers trust code over claims.
- **DO:** Acknowledge the complexity we're hiding (OAuth, tokens, APIs).
- **DON'T:** Hype "AI" as a buzzword. Our users are building with AI—they know what's real.
- **DON'T:** Compare to no-code tools. We're for developers, period.

---

## Target Audience

### Primary: The Agent Builder

- Building autonomous workflows with Claude, GPT, or local LLMs
- Runs agents on GitHub Actions, cron jobs, or custom infra
- Needs their agent to send notifications, fetch context, take actions
- Values portability (one config, runs anywhere)

### Secondary: The Claude Code Power User

- Uses Claude Code daily for development
- Wants Claude to read their email, post updates, manage tickets
- Appreciates skills that "just work" without setup friction

---

## Key Messages

### Hierarchy of Messages

1. **Agent-native communication** — Structured output LLMs can parse, stdin for piping
2. **Portable credentials** — Export once, import anywhere (encrypted)
3. **No servers required** — Runs in GitHub Actions, any CI/CD, or locally
4. **Multi-service coverage** — Gmail, Slack, Telegram, JIRA, Google Chat, and more

### Elevator Pitch (30 seconds)

> "agentio is a CLI that gives AI agents access to communication services. Your GitHub Actions agent can read Gmail, post to Slack, update JIRA—all with simple commands and encrypted credential export. No servers to manage, no Zapier subscriptions, just `agentio gmail list` or `agentio slack send`."

### Tagline Options

- **"I/O for AI agents."**
- **"Your agent's connection to the real world."**
- **"No servers. No Zapier. Just cron."**

---

## Competitive Positioning

| Competitor | Their Position | Our Differentiation |
|------------|----------------|---------------------|
| Zapier | Automation for everyone | We're for developers. Code, not clicks. |
| Make.com | Visual workflow builder | We're a CLI. Runs in CI/CD natively. |
| n8n | Self-hosted automation | We're lighter. Single binary, no Docker required. |
| Raw APIs | Maximum flexibility | We handle OAuth, retries, pagination. |

**Position Statement:**
> For developers building AI agent workflows, agentio provides a portable CLI that connects agents to email, chat, and productivity services. Unlike Zapier or Make.com, agentio runs anywhere a shell runs—GitHub Actions, your laptop, a Raspberry Pi—with encrypted credentials that travel with you.

---

## Visual Identity Direction

### Color Palette

| Role | Color | Usage |
|------|-------|-------|
| Primary | `#0969da` (Blue) | Links, CTAs, brand accent |
| Success | `#1a7f37` (Green) | Success states, confirmations |
| Warning | `#9a6700` (Amber) | Caution, pending states |
| Background | `#ffffff` / `#0d1117` | Light/dark modes |
| Text | `#1f2328` / `#e6edf3` | High contrast |

### Typography

- **Headings:** IBM Plex Sans (professional, technical)
- **Code/CLI:** IBM Plex Mono (matches terminal aesthetic)
- **Body:** System fonts stack

### Logo Concept

The agentio mark should suggest:
- **Connection** — Lines or nodes implying communication
- **Agency** — Active, not passive. Doing, not watching.
- **Technical** — Geometric, developer-friendly aesthetic

---

## Naming Conventions

### Product Names

- **agentio** (lowercase) — The CLI tool and brand
- **agentio gateway** — The background daemon for real-time messaging
- **agentio.me** — The domain

### Service Naming

Use the actual service names:
- `agentio gmail` not `agentio email`
- `agentio slack` not `agentio chat`
- `agentio jira` not `agentio tickets`

### Feature Naming

- "skills" — Claude Code integrations
- "profiles" — Multiple accounts per service
- "export/import" — Credential portability

---

## Content Strategy

### Website

- Lead with the value prop: agents that can communicate
- Show a real workflow (Gmail → Slack daily briefing)
- Platform-specific install tabs (developers expect this)

### Documentation

- One page per service with full command reference
- Working examples that can be copy-pasted
- "Agent Patterns" section showing real workflows

### GitHub README

- Quick install → first command → first result
- Badge showing supported services
- Link to Claude Code skills marketplace

### Social/Community

- Share agent workflow patterns
- Engage with AI/agent builder communities
- Post real examples (email digests, ticket automation)

---

## Use Case Messaging

### Primary Use Cases

1. **Daily Email Briefings**
   > "Your agent reads Gmail overnight, summarizes what matters, posts to Slack before standup."

2. **Deployment Notifications**
   > "CI/CD completes → agentio sends to Telegram/Slack with context your team actually needs."

3. **JIRA Automation**
   > "Agent parses email thread → creates JIRA ticket → adds to sprint. No manual data entry."

4. **RSS Monitoring**
   > "Track feeds, get AI-generated summaries, alert on what's relevant to your project."

### Claude Code Integration

> "Use `/gmail` in Claude Code to read your inbox. Ask Claude to draft replies, triage messages, or find that one email from last month. Your email, your context, your control."

---

## Brand Promise

**We will always be:**
- A portable CLI (no server dependencies)
- Secure by default (encrypted credential export)
- Developer-focused (JSON output, stdin support)
- Service-agnostic (add more services based on demand)

**We will never:**
- Require our servers for core functionality
- Store your credentials unencrypted
- Lock features behind paid tiers (open source core)
- Sacrifice developer experience for broader appeal

---

## Differentiation: Why Not Just Use the APIs?

| Pain Point | agentio Solution |
|------------|------------------|
| OAuth dance for every service | One-time auth, export encrypted config |
| Different output formats | Consistent JSON across all services |
| Rate limits and retries | Built-in handling |
| Credential management | Portable encrypted files |
| Agent-hostile output | Structured for LLM parsing |

---

## Success Metrics (Brand Health)

- Developers call us "the missing piece" for agent workflows
- First successful command within 5 minutes of install
- Active Claude Code skill usage (daily active skills)
- GitHub stars and community contributions growing

---

*Last updated: January 2026*
