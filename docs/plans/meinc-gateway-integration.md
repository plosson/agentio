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
- **Storage**: Full Claude Code sessions stored in git (workspace repo)

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
5. **No New Storage** - Sessions stored in git, not a database
6. **Full Session Continuity** - Claude resumes with complete history (thinking, tool calls, reasoning)

## Workspace Structure

Each workspace (git repo) stores full Claude Code sessions:

```
workspace-repo/
├── meinc.json                    # Workspace config
├── agents/
│   └── assistant/
│       ├── meinc.json            # Agent config (triggers, etc.)
│       └── prompt.md             # Agent system prompt
│
├── sessions/                     # Full Claude Code sessions (NEW)
│   ├── whatsapp/
│   │   ├── +1234567890/
│   │   │   ├── session.jsonl     # Full Claude Code transcript
│   │   │   └── metadata.json     # Session ID, last activity
│   │   └── +0987654321/
│   │       └── ...
│   └── telegram/
│       └── @username/
│           └── ...
│
├── conversations/                # Human-readable logs (optional, derived)
│   └── whatsapp/
│       └── +1234567890.md        # Markdown summary for review
│
└── .github/workflows/
    └── ...                       # Existing scheduled workflows
```

## Session Storage: The Key Insight

**Why store full sessions instead of just conversation logs?**

### Conversation Log (Limited)

```
User: What's on my calendar?
Claude: You have 3 meetings...
```

Claude only sees text. It loses context of *how* it answered.

### Full Session (Complete)

```jsonl
{"type":"user","content":"What's on my calendar?"}
{"type":"thinking","content":"Let me check the calendar using agentio..."}
{"type":"tool_use","name":"bash","input":"agentio gcal events --date today"}
{"type":"tool_result","output":"10:00 Team standup\n14:00 Product review\n16:00 1:1 with Sarah"}
{"type":"thinking","content":"I found 3 meetings. Let me format this nicely..."}
{"type":"assistant","content":"You have 3 meetings today:\n- 10:00 AM: Team standup\n- 2:00 PM: Product review\n- 4:00 PM: 1:1 with Sarah"}
```

Claude remembers *everything*:
- Its reasoning process
- What tools it called
- What results it got
- Failed attempts and learnings
- Full context for follow-up questions

### Benefits

- **True continuity**: Claude doesn't repeat mistakes or forget discoveries
- **Contextual responses**: "Last time I checked your calendar..." is possible
- **Portable**: Move meinc to new server, sessions come with it (they're in git)
- **Auditable**: Full trace of what Claude did and why
- **Resumable**: `claude --resume session-id` works with full history

## Claude Code Session Management

### How Sessions Work

Claude Code stores sessions as JSONL files in `~/.claude/projects/<project>/`.

Key CLI features:
```bash
claude --resume          # Interactive session picker
claude --resume name     # Resume specific session by name
claude -c                # Continue most recent session
```

### Session Sync Strategy

After each Claude run, sync session to git:

```bash
# Copy session from Claude's storage to workspace
cp ~/.claude/projects/workspace/sessions/john-whatsapp.jsonl \
   workspace/sessions/whatsapp/+1234567890/session.jsonl

# Commit
git add sessions/ && git commit -m "[meinc] Session: John"
git push
```

On new machine, restore:

```bash
# Clone workspace
git clone repo workspace

# Restore sessions to Claude's storage
mkdir -p ~/.claude/projects/workspace/sessions/
cp workspace/sessions/whatsapp/+1234567890/session.jsonl \
   ~/.claude/projects/workspace/sessions/john-whatsapp.jsonl
```

### Session Naming Convention

```
{service}-{sender-handle}

Examples:
- whatsapp-+1234567890
- telegram-@alice
- slack-U12345678
```

## Human-Readable Logs (Optional)

For easy review, also generate markdown summaries:

`conversations/whatsapp/+1234567890.md`:

```markdown
# Conversation: John (+1234567890)

Started: 2026-01-27
Session: whatsapp-+1234567890

---

## 2026-01-27 14:30:52 [incoming]

What's on my calendar today?

## 2026-01-27 14:30:58 [response]

You have 3 meetings today:
- 10:00 AM: Team standup
- 2:00 PM: Product review
- 4:00 PM: 1:1 with Sarah

*[Claude checked calendar via agentio gcal events]*

---

## 2026-01-27 14:35:12 [incoming]

Cancel the 4pm

## 2026-01-27 14:35:18 [response]

Done. I've cancelled your 4:00 PM 1:1 with Sarah and notified her via email.

*[Claude ran: agentio gcal delete <event-id>, agentio gmail send ...]*

---
```

These are **derived** from the session JSONL, not the source of truth.

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

### Step 3: Handle Message with Session

```typescript
async function handleMessage(workspace: Workspace, agent: Agent, msg: InboxMessage) {
  const workspacePath = workspace.localPath;
  const sessionName = `${msg.service}-${msg.sender.handle}`;
  const sessionDir = `sessions/${msg.service}/${msg.sender.handle}`;

  // Ensure session directory exists
  await fs.mkdir(path.join(workspacePath, sessionDir), { recursive: true });

  // Check if session exists
  const sessionExists = await checkSessionExists(workspacePath, sessionName);

  // Run Claude Code (resume or new)
  await runClaudeCode(workspace, agent, msg, sessionName, sessionExists);

  // Sync session from Claude's storage to workspace
  await syncSessionToWorkspace(workspacePath, sessionName, sessionDir);

  // Generate human-readable log (optional)
  await generateConversationLog(workspacePath, sessionDir, msg);

  // Commit and push
  await exec(`git add . && git commit -m "[meinc] Session: ${msg.sender.name}"`, {
    cwd: workspacePath
  });
  await exec(`git push`, { cwd: workspacePath });
}

async function checkSessionExists(workspacePath: string, sessionName: string): boolean {
  const claudeSessionPath = path.join(
    os.homedir(),
    '.claude/projects',
    path.basename(workspacePath),
    'sessions',
    `${sessionName}.jsonl`
  );
  return await fs.exists(claudeSessionPath);
}

async function syncSessionToWorkspace(
  workspacePath: string,
  sessionName: string,
  sessionDir: string
) {
  const claudeSessionPath = path.join(
    os.homedir(),
    '.claude/projects',
    path.basename(workspacePath),
    'sessions',
    `${sessionName}.jsonl`
  );
  const targetPath = path.join(workspacePath, sessionDir, 'session.jsonl');

  await fs.copyFile(claudeSessionPath, targetPath);

  // Update metadata
  const metadata = {
    sessionName,
    lastUpdated: new Date().toISOString(),
    messageCount: await countMessages(targetPath)
  };
  await fs.writeFile(
    path.join(workspacePath, sessionDir, 'metadata.json'),
    JSON.stringify(metadata, null, 2)
  );
}
```

### Step 4: Run Claude Code (Resume or New)

```typescript
async function runClaudeCode(
  workspace: Workspace,
  agent: Agent,
  msg: InboxMessage,
  sessionName: string,
  sessionExists: boolean
) {
  const agentPrompt = await fs.readFile(
    path.join(workspace.localPath, `agents/${agent.id}/prompt.md`),
    'utf-8'
  );

  const messagePrompt = `
New message from ${msg.sender.name} (${msg.sender.handle}):

"${msg.content}"
${msg.media_path ? `\nAttachment: ${msg.media_path}` : ''}

Reply using: agentio ${msg.service} inbox reply ${msg.id} "<your response>"
`;

  if (sessionExists) {
    // RESUME existing session - Claude has full history
    await exec(
      `claude --resume ${sessionName} -p "${escapeForShell(messagePrompt)}"`,
      {
        cwd: workspace.localPath,
        timeout: 120000
      }
    );
  } else {
    // NEW session - include system prompt
    const systemPrompt = `
${agentPrompt}

## Your Role

You are responding to messages via ${msg.service}. The user is ${msg.sender.name} (${msg.sender.handle}).

## How to Respond

1. Use agentio CLI to access calendar, email, and other services
2. Send your response: agentio ${msg.service} inbox reply <message-id> "<response>"
3. Keep responses concise (appropriate for ${msg.service})

## Available Tools

- Calendar: agentio gcal events, agentio gcal create
- Email: agentio gmail list, agentio gmail send
- Reply: agentio ${msg.service} inbox reply
- And more: agentio --help
`;

    await exec(
      `claude -p "${escapeForShell(messagePrompt)}" ` +
      `--append-system-prompt "${escapeForShell(systemPrompt)}" ` +
      `--session ${sessionName}`,
      {
        cwd: workspace.localPath,
        timeout: 120000
      }
    );
  }
}
```

### Session Restoration on New Machine

When meinc starts or a workspace is synced:

```typescript
async function restoreWorkspaceSessions(workspace: Workspace) {
  const sessionsDir = path.join(workspace.localPath, 'sessions');
  if (!await fs.exists(sessionsDir)) return;

  const claudeProjectDir = path.join(
    os.homedir(),
    '.claude/projects',
    path.basename(workspace.localPath),
    'sessions'
  );
  await fs.mkdir(claudeProjectDir, { recursive: true });

  // Walk sessions directory and restore each
  for await (const service of await fs.readdir(sessionsDir)) {
    const servicePath = path.join(sessionsDir, service);
    for await (const sender of await fs.readdir(servicePath)) {
      const sessionFile = path.join(servicePath, sender, 'session.jsonl');
      if (await fs.exists(sessionFile)) {
        const sessionName = `${service}-${sender}`;
        const targetPath = path.join(claudeProjectDir, `${sessionName}.jsonl`);
        await fs.copyFile(sessionFile, targetPath);
        console.log(`Restored session: ${sessionName}`);
      }
    }
  }
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

### Phase 3: Session Storage & Sync

**Files to create:**
- `server/sessions.ts` - Session sync logic (Claude ↔ workspace)
- `server/restore.ts` - Session restoration on startup

**Implementation:**
- After each Claude run, copy session JSONL to workspace
- On startup, restore sessions from workspace to Claude's storage
- Optionally generate human-readable markdown logs

**Acceptance criteria:**
- Sessions stored in `sessions/{service}/{sender}/session.jsonl`
- Sessions survive meinc restart
- Sessions portable to new machines via git

### Phase 4: Claude Code Integration with Resume

**Implementation:**
- Check if session exists for sender
- If yes: `claude --resume {session} -p "new message"`
- If no: `claude -p "..." --session {session}` with system prompt
- Handle timeouts and errors gracefully

**Acceptance criteria:**
- Claude Code resumes with full history (thinking, tool calls, etc.)
- New conversations start with agent's system prompt
- Uses agentio to read data and send replies

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

1. **Session size over time**: Sessions grow indefinitely. How to manage?
   - Option A: Let Claude Code handle context window internally
   - Option B: Periodically archive old sessions, start fresh with summary
   - Option C: Use Claude's built-in session summarization (if available)
   - **Note**: This is less urgent than with conversation logs since Claude Code manages context

2. **Concurrent messages**: What if user sends multiple messages quickly?
   - Option A: Queue and process sequentially (recommended)
   - Option B: Batch into single Claude call (loses granularity)
   - Option C: Process in parallel (may cause session corruption)
   - **Recommendation**: Lock per-session, queue messages

3. **Error handling**: What if Claude Code fails?
   - Option A: Silent failure (log only)
   - Option B: Send error message to user
   - Option C: Retry with backoff
   - **Recommendation**: Send brief error message, log full details

4. **Git conflicts**: What if webhook arrives during Claude execution?
   - Option A: Lock per-conversation (recommended)
   - Option B: Git rebase on conflict
   - Option C: Queue messages per-conversation
   - **Note**: Session files are per-sender, so conflicts only occur if same sender sends rapidly

5. **Session portability**: Claude Code sessions tied to project path
   - If workspace moves to different path, sessions may not match
   - May need to update session metadata or re-import
   - **TODO**: Test session restoration across different machines/paths

6. **Session export format**: Claude Code doesn't have native export
   - Currently using raw JSONL from `~/.claude/projects/`
   - May need community tools (cctrace, etc.) for reliable export
   - **Risk**: Format may change between Claude Code versions
