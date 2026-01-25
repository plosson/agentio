# Gateway Feature Plan

## Overview

The Gateway is a persistent daemon that acts as the **single point of contact** with external messaging services (WhatsApp, Telegram, etc.). It operates like a post office:

- **Inbound**: Messages arrive from services → stored in inbox → webhook notification (optional)
- **Outbound**: CLI pushes messages to outbox → gateway relays to services

This architecture is required because:
1. **WhatsApp** - Auth is device-bound; messages must originate from the authenticated device
2. **Telegram bots** - Long-polling/webhooks require a persistent listener
3. **Reliability** - Queued messages survive CLI disconnects

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Gateway (persistent daemon)                       │
│                        agentio gateway start                             │
│                                                                          │
│   ┌─────────────────────────────────────────────────────────────────┐   │
│   │                     Service Adapters                             │   │
│   │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐           │   │
│   │  │  Telegram    │  │  WhatsApp    │  │   Slack      │   ...     │   │
│   │  │  Adapter     │  │  Adapter     │  │  Adapter     │           │   │
│   │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘           │   │
│   └─────────┼──────────────────┼──────────────────┼─────────────────┘   │
│             │                  │                  │                      │
│             ▼                  ▼                  ▼                      │
│   ┌─────────────────────────────────────────────────────────────────┐   │
│   │                     Message Store (SQLite)                       │   │
│   │  ┌──────────────┐  ┌──────────────┐                             │   │
│   │  │   INBOX      │  │   OUTBOX     │                             │   │
│   │  │  (inbound)   │  │  (outbound)  │                             │   │
│   │  └──────────────┘  └──────────────┘                             │   │
│   └─────────────────────────────────────────────────────────────────┘   │
│             │                                                            │
│             ▼                                                            │
│   ┌─────────────────────────────────────────────────────────────────┐   │
│   │  Webhook Notifier (optional, debounced)                          │   │
│   └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
        ▲                                              │
        │ CLI pushes to outbox                         │ Webhook POST
        │ CLI pulls from inbox                         ▼
┌───────────────────┐                         ┌───────────────────┐
│   agentio CLI     │                         │  Your webhook     │
│   (any machine)   │                         │  endpoint         │
└───────────────────┘                         └───────────────────┘
```

## Design Principles

1. **Gateway as Post Office** - All external service communication flows through gateway
2. **Queue-Based** - Inbox (inbound) and Outbox (outbound) queues for reliability
3. **CLI as Client** - CLI never talks directly to services, only to gateway
4. **Webhook Optional** - Simple "you've got mail" notification, no business logic
5. **Single Device** - Gateway runs persistently on one authenticated device

## Components

### 1. Message Store

**Location**: `~/.config/agentio/gateway.db`

Single SQLite database with unified schema for all services.

**Schema**:
```sql
-- Inbound messages (received from services)
CREATE TABLE inbox (
  id TEXT PRIMARY KEY,              -- uuid
  service TEXT NOT NULL,            -- telegram, whatsapp, slack
  profile TEXT NOT NULL,            -- profile name
  conversation_id TEXT NOT NULL,    -- chat/thread identifier
  platform_id TEXT NOT NULL,        -- original message ID from platform

  sender_id TEXT NOT NULL,
  sender_name TEXT,
  sender_handle TEXT,

  content TEXT,                     -- message text
  media_type TEXT,                  -- image, video, audio, document
  media_path TEXT,                  -- local path if downloaded

  received_at INTEGER NOT NULL,     -- unix timestamp
  status TEXT DEFAULT 'pending',    -- pending | claimed | done
  claimed_at INTEGER,
  done_at INTEGER,

  reply_to_id TEXT,                 -- if this is a reply
  metadata TEXT,                    -- JSON blob for service-specific data

  UNIQUE(service, profile, platform_id)
);

-- Outbound messages (queued for sending)
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,              -- uuid
  service TEXT NOT NULL,
  profile TEXT NOT NULL,
  conversation_id TEXT NOT NULL,    -- destination chat/thread

  content TEXT,
  media_path TEXT,
  media_type TEXT,

  reply_to_platform_id TEXT,        -- if replying to a message

  queued_at INTEGER NOT NULL,
  status TEXT DEFAULT 'pending',    -- pending | sending | sent | failed
  sent_at INTEGER,
  error TEXT,
  platform_id TEXT,                 -- assigned after send

  metadata TEXT                     -- JSON blob (parse_mode, etc.)
);

CREATE INDEX idx_inbox_status ON inbox(service, profile, status);
CREATE INDEX idx_outbox_status ON outbox(service, profile, status);
```

### 2. Gateway Daemon

**Commands**:
```bash
agentio gateway start [--foreground]   # Start daemon (background by default)
agentio gateway stop                    # Stop daemon
agentio gateway status                  # Show running status, connected services
agentio gateway reload                  # Reload config, reconnect services
agentio gateway logs [--follow]         # View daemon logs
```

**Responsibilities**:
- Maintain persistent connections to services (Telegram long-poll, WhatsApp socket)
- Write inbound messages to inbox table
- Process outbox queue and relay messages to services
- Fire webhook on new inbound messages (debounced)
- Handle reconnection/retry on failures

**Config** (`~/.config/agentio/config.json`):
```json
{
  "gateway": {
    "webhook": {
      "url": "https://example.com/notify",
      "secret": "hmac-secret",
      "debounceMs": 2000
    },
    "services": {
      "telegram": ["bot1", "bot2"],
      "whatsapp": ["pierre"]
    }
  }
}
```

### 3. Service Adapters

Each service implements an adapter interface:

```typescript
interface ServiceAdapter {
  service: ServiceName;

  // Connection management
  connect(profile: string, credentials: unknown): Promise<void>;
  disconnect(profile: string): Promise<void>;
  isConnected(profile: string): boolean;

  // Inbound: called by adapter when message received
  onMessage: (message: InboundMessage) => void;

  // Outbound: gateway calls this to send
  send(profile: string, message: OutboundMessage): Promise<SendResult>;
}
```

### 4. CLI Commands (Client Mode)

When gateway is running, CLI commands route through it:

```bash
# Inbox operations
agentio inbox pull [--service S] [--profile P] [--limit N] [--status pending|done]
agentio inbox get <id>
agentio inbox ack <id>              # Mark as done
agentio inbox stats

# Send operations (route through gateway outbox)
agentio telegram send <message> [--profile P]   # → queues in outbox
agentio whatsapp send <message> [--profile P]   # → queues in outbox

# Reply to inbox message
agentio inbox reply <inbox-id> <message>        # → queues reply in outbox
```

**Behavior**:
- `send` commands push to outbox, return immediately with queue ID
- Gateway processes outbox asynchronously
- CLI can check send status: `agentio outbox status <id>`

### 5. Webhook Notification

Fired when new messages arrive in inbox (debounced).

**Payload**:
```json
{
  "event": "inbox.message",
  "timestamp": 1706189234,
  "messages": [
    {
      "id": "uuid-123",
      "service": "whatsapp",
      "profile": "pierre",
      "sender": "+15551234567",
      "preview": "Hey, are you there?"
    }
  ]
}
```

**Headers**:
- `Content-Type: application/json`
- `X-Agentio-Signature: sha256=...` (HMAC of body with secret)

## Implementation Plan

### Phase 1: Core Infrastructure
- [x] Create `src/inbox/types.ts` - Shared types
- [x] Create `src/inbox/store.ts` - SQLite inbox store
- [x] Create `src/inbox/commands.ts` - Shared CLI command builder
- [ ] Create `src/inbox/index.ts` - Exports

### Phase 2: WhatsApp Integration
- [ ] Add `WhatsAppListener` class to `src/services/whatsapp/listener.ts`
- [ ] Add inbox commands to `src/commands/whatsapp.ts`
- [ ] Implement reply functionality via WhatsApp client

### Phase 3: Telegram Integration
- [ ] Add `TelegramListener` class to `src/services/telegram/listener.ts`
- [ ] Add inbox commands to `src/commands/telegram.ts`
- [ ] Implement reply functionality via Telegram client

### Phase 4: Gateway Daemon
- [ ] Create `src/gateway/daemon.ts` - Main daemon logic
- [ ] Create `src/gateway/webhook.ts` - Webhook notifier with debouncing
- [ ] Create `src/commands/gateway.ts` - Gateway CLI commands
- [ ] Register in `src/index.ts`

### Phase 5: Testing & Documentation
- [ ] Test WhatsApp inbox flow
- [ ] Test Telegram inbox flow
- [ ] Test gateway with webhook
- [ ] Update README with inbox/gateway docs

## Message ID Format

```
{profile}:{conversation}:{platformMessageId}
```

Examples:
- `bot1:-100123456:789` (Telegram)
- `pierre:+15551234567:ABC123DEF` (WhatsApp)
- `workspace1:C0123CHAN:1706189234.123456` (Slack)

## CLI Examples

```bash
# Start gateway daemon
agentio gateway start

# Check WhatsApp inbox
agentio whatsapp inbox pull
agentio whatsapp inbox pull --profile pierre --limit 5

# Reply to a message
agentio whatsapp inbox reply "pierre:+1555123:ABC" "Thanks for your message!"

# Mark as processed without replying
agentio whatsapp inbox ack "pierre:+1555123:ABC"

# Check stats
agentio whatsapp inbox stats
```

## Future Considerations

1. **Remote Queue** - Support Redis/PostgreSQL for distributed setups
2. **Multi-tenant** - Separate config directories per tenant
3. **Message Retention** - Auto-cleanup of old processed messages
4. **Attachments** - Download and store media files locally
5. **Rate Limiting** - Per-conversation reply rate limits
