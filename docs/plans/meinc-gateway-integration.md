# meinc + agentio Gateway Integration Plan

## Overview

This plan describes how **meinc** (the agent orchestration platform) integrates with **agentio gateway** to enable real-time conversational agents via WhatsApp, Telegram, and other messaging services.

**Key insight**: agentio is the I/O layer (talk to the world), meinc is the orchestration layer (what triggers agents, with what context). The gateway sends webhooks to meinc, which runs Claude Code to respond.

### Current State

- **meinc**: Cloudflare Worker that manages AI agents in GitHub repos
- **Trigger**: Cron schedule via GitHub Actions
- **Execution**: GitHub Actions runs Claude Code with agent's prompt

### Target State

- **meinc**: Dedicated server (Bun/Node) running alongside agentio gateway
- **Trigger**: Real-time messages via webhook from gateway
- **Execution**: Local Claude Code execution with sub-second latency
- **Storage**: Conversations stored in git (workspace repo)

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Dedicated Server                                   │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                        agentio gateway                                  │ │
│  │                                                                         │ │
│  │   ┌─────────────┐  ┌─────────────┐                                     │ │
│  │   │  WhatsApp   │  │  Telegram   │  ...                                │ │
│  │   │  Adapter    │  │  Adapter    │                                     │ │
│  │   └──────┬──────┘  └──────┬──────┘                                     │ │
│  │          │                │                                             │ │
│  │          ▼                ▼                                             │ │
│  │   ┌─────────────────────────────────────────────────────────────────┐  │ │
│  │   │              Message Store (SQLite)                              │  │ │
│  │   │   inbox / outbox                                                 │  │ │
│  │   └─────────────────────────────────────────────────────────────────┘  │ │
│  │          │                                                              │ │
│  │          │ Webhook (on new message)                                     │ │
│  │          ▼                                                              │ │
│  └──────────┼──────────────────────────────────────────────────────────────┘ │
│             │                                                                │
│             │  POST http://localhost:8787/webhook/gateway                    │
│             ▼                                                                │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                            meinc                                        │ │
│  │                                                                         │ │
│  │   1. Receive webhook                                                    │ │
│  │   2. Route to workspace/agent                                           │ │
│  │   3. Append message to conversation file                                │ │
│  │   4. git commit                                                         │ │
│  │   5. Run Claude Code with agent prompt + conversation context           │ │
│  │   6. Claude responds via agentio, commits changes                       │ │
│  │   7. git push                                                           │ │
│  │                                                                         │ │
│  │   port 8787 (API + web UI)                                              │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│             │                                                                │
│             │  claude -p "..."                                               │
│             ▼                                                                │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                         Claude Code                                     │ │
│  │                                                                         │ │
│  │   - Reads conversation history                                          │ │
│  │   - Uses agentio for calendar, email, etc.                              │ │
│  │   - Writes response to conversation file                                │ │
│  │   - Sends reply: agentio whatsapp inbox reply <id> "<response>"         │ │
│  │   - Commits: git commit -am "[meinc] Response to John"                  │ │
│  │                                                                         │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Design Principles

1. **Git as Source of Truth** - Every message and response is committed to the workspace repo
2. **Workspace = Git Repo** - Each workspace is a cloned GitHub repository
3. **Claude Does the Work** - meinc is thin orchestration; Claude handles conversation logic
4. **Localhost Communication** - Gateway and meinc communicate via localhost webhook
5. **No New Storage** - Conversations stored as markdown files in git, not a database

## Workspace Structure

Each workspace (git repo) gains a `conversations/` directory:

```
workspace-repo/
├── meinc.json                    # Workspace config
├── agents/
│   └── assistant/
│       ├── meinc.json            # Agent config (triggers, etc.)
│       └── prompt.md             # Agent system prompt
│
├── conversations/                # NEW: Message history
│   ├── whatsapp/
│   │   ├── +1234567890.md        # Conversation with this sender
│   │   └── +0987654321.md
│   └── telegram/
│       └── @username.md
│
└── .github/workflows/
    └── ...                       # Existing scheduled workflows
```

## Conversation File Format

Each conversation is a single markdown file, appended to over time:

`conversations/whatsapp/+1234567890.md`:

```markdown
# Conversation: John (+1234567890)

Started: 2026-01-27

---

## 2026-01-27 14:30:52 [incoming]

What's on my calendar today?

---

## 2026-01-27 14:30:58 [response]

You have 3 meetings today:
- 10:00 AM: Team standup
- 2:00 PM: Product review
- 4:00 PM: 1:1 with Sarah

---

## 2026-01-27 14:35:12 [incoming]

Cancel the 4pm

---

## 2026-01-27 14:35:18 [response]

Done. I've cancelled your 4:00 PM 1:1 with Sarah and notified her via email.

---
```

### Benefits

- Human-readable conversation history
- Full git history for audit trail
- Easy to review/edit in any text editor
- Searchable via grep/git log
- Portable (it's just files)

## Agent Configuration

Agents opt-in to real-time triggers via their config:

`agents/assistant/meinc.json`:

```json
{
  "name": "Personal Assistant",
  "description": "Handles WhatsApp messages",
  "triggers": {
    "whatsapp": {
      "enabled": true,
      "profile": "default",
      "allowList": ["+1234567890", "+0987654321"],
      "denyList": [],
      "autoAck": true
    },
    "telegram": {
      "enabled": true,
      "profile": "mybot",
      "allowList": ["@alice", "@bob"]
    }
  }
}
```

### Routing Logic

When a message arrives:

1. Find all workspaces on the server
2. For each workspace, check agents with matching trigger config
3. Route message to first matching agent (or default agent if configured)

## Webhook Payload

agentio gateway sends webhooks in this format:

```json
{
  "event": "inbox.message",
  "timestamp": 1706364652,
  "messages": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "service": "whatsapp",
      "profile": "default",
      "conversation_id": "+1234567890@s.whatsapp.net",
      "platform_id": "ABCD1234",
      "sender": {
        "id": "+1234567890@s.whatsapp.net",
        "name": "John Doe",
        "handle": "+1234567890"
      },
      "content": "What's on my calendar today?",
      "media_type": null,
      "media_path": null,
      "received_at": 1706364652
    }
  ]
}
```

## Message Processing Flow

### Step 1: Webhook Received

```typescript
app.post('/webhook/gateway', async (req) => {
  const { event, messages } = req.body;

  // Verify HMAC signature
  if (!verifySignature(req)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  for (const msg of messages) {
    await processMessage(msg);
  }

  return res.json({ ok: true });
});
```

### Step 2: Route to Agent

```typescript
async function processMessage(msg: InboxMessage) {
  // Find workspace/agent that handles this service+profile+sender
  const route = await findRoute(msg.service, msg.profile, msg.sender.handle);

  if (!route) {
    console.log(`No agent configured for ${msg.service}/${msg.profile}`);
    return;
  }

  const { workspace, agent } = route;
  await handleMessage(workspace, agent, msg);
}
```

### Step 3: Append to Conversation & Commit

```typescript
async function handleMessage(workspace: Workspace, agent: Agent, msg: InboxMessage) {
  const workspacePath = workspace.localPath;
  const convPath = `conversations/${msg.service}/${msg.sender.handle}.md`;
  const fullPath = path.join(workspacePath, convPath);

  // Ensure directory exists
  await fs.mkdir(path.dirname(fullPath), { recursive: true });

  // Append incoming message
  const timestamp = new Date(msg.received_at * 1000).toISOString();
  const entry = `
---

## ${timestamp} [incoming]

${msg.content}
`;

  await fs.appendFile(fullPath, entry);

  // Commit
  await exec(`git add . && git commit -m "[meinc] Incoming from ${msg.sender.name}"`, {
    cwd: workspacePath
  });

  // Run Claude Code
  await runClaudeCode(workspace, agent, msg, convPath);

  // Push changes (including Claude's response commit)
  await exec(`git push`, { cwd: workspacePath });
}
```

### Step 4: Run Claude Code

```typescript
async function runClaudeCode(
  workspace: Workspace,
  agent: Agent,
  msg: InboxMessage,
  convPath: string
) {
  const agentPrompt = await fs.readFile(
    path.join(workspace.localPath, `agents/${agent.id}/prompt.md`),
    'utf-8'
  );

  const systemPrompt = `
${agentPrompt}

## Current Task

A new message has arrived. You must:
1. Read the conversation history from: ${convPath}
2. Formulate an appropriate response
3. Append your response to the conversation file in this format:
   ---

   ## {timestamp} [response]

   {your response}
4. Send the response: agentio ${msg.service} inbox reply ${msg.id} "{response}"
5. Commit your changes: git commit -am "[meinc] Response to ${msg.sender.name}"

## Message Details

- Service: ${msg.service}
- Sender: ${msg.sender.name} (${msg.sender.handle})
- Message ID: ${msg.id}
- Content: "${msg.content}"
${msg.media_path ? `- Attachment: ${msg.media_path}` : ''}

## Available Tools

You have access to agentio CLI for:
- Calendar: agentio gcal events, agentio gcal create
- Email: agentio gmail list, agentio gmail send
- Messages: agentio ${msg.service} inbox reply
- And more (run: agentio --help)
`;

  await exec(`claude -p "${escapeForShell(systemPrompt)}"`, {
    cwd: workspace.localPath,
    timeout: 120000  // 2 minute timeout
  });
}
```

## Gateway Configuration

agentio gateway needs to know where to send webhooks:

`~/.config/agentio/config.json`:

```json
{
  "gateway": {
    "webhook": {
      "url": "http://localhost:8787/webhook/gateway",
      "secret": "your-hmac-secret",
      "events": ["inbox.message"],
      "debounceMs": 500
    }
  }
}
```

### Configuration via CLI

```bash
# Set webhook URL
agentio config env set GATEWAY_WEBHOOK_URL http://localhost:8787/webhook/gateway

# Set webhook secret
agentio config env set GATEWAY_WEBHOOK_SECRET $(openssl rand -hex 32)
```

## meinc Transition: Worker → Dedicated

### What Stays the Same

- Web UI (Alpine.js pages)
- GitHub OAuth for authentication
- Workspace = GitHub repo paradigm
- Agent prompt editing
- Most API endpoints

### What Changes

| Aspect | Worker | Dedicated |
|--------|--------|-----------|
| **Runtime** | Cloudflare Worker | Bun/Node server |
| **State** | KV / GitHub API | Local filesystem + git |
| **Workspaces** | Fetched via GitHub API | Cloned locally |
| **Agent execution** | GitHub Actions | Local Claude Code |
| **Session storage** | Encrypted cookie | Same (or local SQLite) |

### New Endpoints

```
POST /webhook/gateway          # Receive gateway webhooks
GET  /api/conversations/:workspace/:agent
POST /api/conversations/:workspace/:agent/clear
```

### Workspace Management

Workspaces are cloned locally and kept in sync:

```
/var/meinc/workspaces/
├── plosson/
│   ├── personal-workspace/    # git clone of plosson/personal-workspace
│   └── work-agents/           # git clone of plosson/work-agents
└── otheruser/
    └── their-workspace/
```

```typescript
// Sync workspace from GitHub
async function syncWorkspace(owner: string, repo: string) {
  const localPath = `/var/meinc/workspaces/${owner}/${repo}`;

  if (await fs.exists(localPath)) {
    await exec(`git pull`, { cwd: localPath });
  } else {
    await exec(`git clone git@github.com:${owner}/${repo}.git ${localPath}`);
  }

  return { owner, repo, localPath };
}
```

## Implementation Phases

### Phase 1: Webhook Endpoint in agentio Gateway

**Files to modify:**
- `src/gateway/daemon.ts` - Add webhook URL config
- `src/gateway/webhook.ts` - Already exists, verify payload format

**Acceptance criteria:**
- Gateway sends webhook on inbox message
- Webhook includes full message details
- HMAC signature for security

### Phase 2: meinc Dedicated Server Mode

**New mode for meinc:**
- Can run as Cloudflare Worker (existing)
- Can run as Bun server (new)

**Files to create:**
- `server/index.ts` - Bun HTTP server entry point
- `server/webhook.ts` - Webhook handler
- `server/workspaces.ts` - Local workspace management
- `server/claude.ts` - Claude Code execution

**Acceptance criteria:**
- meinc runs on dedicated server
- Web UI works as before
- Can clone/sync workspaces locally

### Phase 3: Conversation Storage

**Files to modify:**
- `server/conversations.ts` - Read/write conversation files
- Update workspace sync to handle conversations/

**Acceptance criteria:**
- Incoming messages appended to conversation file
- Commits created with proper messages
- Git history shows full conversation trail

### Phase 4: Claude Code Integration

**Implementation:**
- Build prompt from agent config + conversation history
- Execute Claude Code in workspace directory
- Handle timeouts and errors gracefully

**Acceptance criteria:**
- Claude Code runs in workspace context
- Uses agentio to read data and send replies
- Commits response to conversation file

### Phase 5: Routing & Multi-Agent

**Implementation:**
- Route messages to correct workspace/agent based on config
- Support allow/deny lists
- Support multiple agents in one workspace

**Acceptance criteria:**
- Messages route to correct agent
- Allow/deny lists work
- Multiple agents can handle different services

## Security Considerations

### Webhook Authentication

- HMAC-SHA256 signature on all webhooks
- Secret shared between gateway and meinc
- Reject requests with invalid signatures

### Sender Allow Lists

- Agents can specify allowed senders
- Unknown senders are ignored (configurable)
- Rate limiting per sender

### Workspace Isolation

- Each workspace runs in its own directory
- Git operations scoped to workspace
- Claude Code runs with workspace as cwd

## Deployment

### Single Server Setup

```bash
# Start agentio gateway
agentio gateway start

# Start meinc
cd /opt/meinc && bun run server/index.ts
```

### Systemd Services

`/etc/systemd/system/agentio-gateway.service`:
```ini
[Unit]
Description=agentio gateway
After=network.target

[Service]
Type=simple
User=meinc
ExecStart=/usr/local/bin/agentio gateway start --foreground
Restart=always

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/meinc.service`:
```ini
[Unit]
Description=meinc server
After=network.target agentio-gateway.service

[Service]
Type=simple
User=meinc
WorkingDirectory=/opt/meinc
ExecStart=/usr/local/bin/bun run server/index.ts
Restart=always
Environment=PORT=8787

[Install]
WantedBy=multi-user.target
```

## Future Extensions

### Multi-User Support

- Multiple users, each with their own workspaces
- Workspaces stored per-user
- Authentication via GitHub OAuth (existing)

### Conversation Summarization

- Periodically summarize long conversations
- Store summary in separate file
- Use summary for context window management

### Async Fallback

- If Claude Code takes too long, send "let me think..."
- Continue processing, send follow-up when done
- Track pending responses

### Media Handling

- Download media from gateway
- Pass media path to Claude Code
- Support image understanding in prompts

## Open Questions

1. **Conversation context window**: How much history to include in prompt?
   - Option A: Last N messages
   - Option B: Token-based truncation
   - Option C: Summary + recent messages

2. **Concurrent messages**: What if user sends multiple messages quickly?
   - Option A: Queue and process sequentially
   - Option B: Batch into single Claude call
   - Option C: Process in parallel (may cause confusion)

3. **Error handling**: What if Claude Code fails?
   - Option A: Silent failure (log only)
   - Option B: Send error message to user
   - Option C: Retry with backoff

4. **Git conflicts**: What if webhook arrives during Claude execution?
   - Option A: Lock per-conversation
   - Option B: Git rebase on conflict
   - Option C: Queue messages per-conversation
