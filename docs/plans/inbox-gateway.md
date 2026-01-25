# Inbox & Gateway Feature Plan

## Overview

Add bidirectional messaging support to agentio through:
1. **Inbox** - Per-service message queues for receiving messages
2. **Gateway** - Daemon that listens to configured services and queues incoming messages
3. **Webhook** - Notification system to signal "you've got mail"

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Gateway Daemon (agentio gateway start)          │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │  Telegram    │  │  WhatsApp    │  │   Slack      │    ...       │
│  │  Listener    │  │  Listener    │  │  Listener    │              │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘              │
│         │                 │                 │                       │
│         ▼                 ▼                 ▼                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │  telegram/   │  │  whatsapp/   │  │   slack/     │              │
│  │  inbox.db    │  │  inbox.db    │  │  inbox.db    │              │
│  └──────────────┘  └──────────────┘  └──────────────┘              │
│                                                                     │
│                     Webhook Notifier                                │
│                     (debounced, normalized)                         │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                     POST /your-webhook
                     {
                       "event": "inbox.updated",
                       "timestamp": 1706189234,
                       "profiles": ["telegram.bot1", "whatsapp.pierre"]
                     }
```

## Design Principles

1. **Service Isolation** - Each service manages its own inbox storage
2. **Decoupling** - Gateway knows nothing about consumers, CLI knows nothing about gateway
3. **Webhook Simplicity** - Just signals "updates available", no business logic
4. **CLI-First** - All operations available via CLI commands

## Components

### 1. Inbox Store (per service)

**Location**: `~/.config/agentio/{service}/inbox.db`

**Schema**:
```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,              -- {profile}:{conversation}:{messageId}
  profile TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  platform_message_id TEXT NOT NULL,

  sender_id TEXT NOT NULL,
  sender_name TEXT,
  sender_handle TEXT,

  text TEXT,
  media_type TEXT,
  media_path TEXT,

  received_at INTEGER NOT NULL,
  status TEXT DEFAULT 'pending',    -- pending | processing | done | failed
  processed_at INTEGER,

  reply_to_id TEXT,
  metadata TEXT                     -- JSON blob
);
```

### 2. Inbox CLI Commands (per service)

```bash
agentio {service} inbox pull [--profile <name>] [--limit N] [--status pending|done]
agentio {service} inbox get <id>
agentio {service} inbox reply <id> "text"
agentio {service} inbox ack <id>
agentio {service} inbox stats
```

### 3. Service Listener (per service)

Each service implements a listener that:
- Connects to the platform (Telegram bot, WhatsApp socket, etc.)
- Receives incoming messages
- Writes to its inbox store
- Reports profile updates to the gateway

**Interface**:
```typescript
interface ServiceListener {
  service: string;
  start(profiles: string[], onMessage: (profile: string) => void): Promise<void>;
  stop(): Promise<void>;
}
```

### 4. Gateway Daemon

**Command**: `agentio gateway start`

**Responsibilities**:
- Read config for which services/profiles to listen
- Start each service's listener
- Collect profile update notifications
- Fire debounced webhook with list of updated profiles

**Config** (`~/.config/agentio/config.json`):
```json
{
  "gateway": {
    "webhook": {
      "url": "https://example.com/notify",
      "secret": "hmac-secret",
      "debounceMs": 2000
    }
  }
}
```

### 5. Webhook Payload

```json
{
  "event": "inbox.updated",
  "timestamp": 1706189234,
  "profiles": ["telegram.bot1", "whatsapp.pierre"]
}
```

**Headers**:
- `Content-Type: application/json`
- `X-Agentio-Signature: sha256=...` (if secret configured)

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
