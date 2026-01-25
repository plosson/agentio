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
    "api": {
      "port": 7890,
      "host": "0.0.0.0",
      "secret": "your-api-secret"
    },
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

### 3. Gateway HTTP API

CLI communicates with gateway via authenticated HTTP API.

**Authentication**:
- Header: `Authorization: Bearer <secret>`
- Secret from config or `AGENTIO_GATEWAY_SECRET` env var

**Endpoints**:
```
POST /inbox/pull      - Get pending messages
POST /inbox/ack       - Mark message as done
POST /inbox/stats     - Get inbox statistics
POST /outbox/send     - Queue outbound message
POST /outbox/status   - Check send status
GET  /health          - Gateway health check
GET  /status          - Connected services status
```

**Example - Pull inbox**:
```bash
curl -X POST http://gateway:7890/inbox/pull \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -d '{"service": "whatsapp", "profile": "pierre", "limit": 10}'
```

**Response**:
```json
{
  "messages": [
    {
      "id": "uuid-123",
      "service": "whatsapp",
      "profile": "pierre",
      "conversation_id": "+15551234567",
      "sender_id": "+15551234567",
      "sender_name": "John",
      "content": "Hey, are you there?",
      "received_at": 1706189234,
      "status": "pending"
    }
  ]
}
```

**Example - Send message**:
```bash
curl -X POST http://gateway:7890/outbox/send \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "service": "whatsapp",
    "profile": "pierre",
    "conversation_id": "+15551234567",
    "content": "Hello!"
  }'
```

**Response**:
```json
{
  "id": "uuid-456",
  "status": "pending"
}
```

### 4. Service Adapters

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

### 5. CLI Commands (Client Mode)

CLI connects to gateway via HTTP API. Gateway URL configured via:
- Config: `~/.config/agentio/config.json` → `gateway.url`
- Env: `AGENTIO_GATEWAY_URL` (e.g., `http://localhost:7890`)
- Flag: `--gateway <url>`

```bash
# Inbox operations (per profile)
agentio whatsapp inbox pull [--profile P] [--limit N] [--status pending|done]
agentio whatsapp inbox get <id> [--profile P]
agentio whatsapp inbox ack <id> [--profile P]
agentio whatsapp inbox reply <id> <message> [--profile P]
agentio whatsapp inbox stats [--profile P]

agentio telegram inbox pull [--profile P] [--limit N] [--status pending|done]
agentio telegram inbox get <id> [--profile P]
agentio telegram inbox ack <id> [--profile P]
agentio telegram inbox reply <id> <message> [--profile P]
agentio telegram inbox stats [--profile P]

# Send operations (per profile, routes through outbox)
agentio whatsapp send <message> --to <conversation> [--profile P]
agentio telegram send <message> --to <chat-id> [--profile P]

# Outbox operations (per profile)
agentio whatsapp outbox status <id> [--profile P]
agentio whatsapp outbox list [--profile P] [--status pending|sent|failed]

agentio telegram outbox status <id> [--profile P]
agentio telegram outbox list [--profile P] [--status pending|sent|failed]
```

**Note**: `--profile` defaults to the service's default profile if not specified.

**Behavior**:
- `send` commands push to outbox, return immediately with queue ID
- Gateway processes outbox asynchronously
- CLI polls `{service} outbox status` to check delivery

**CLI Config** (client side):
```json
{
  "gateway": {
    "url": "http://192.168.1.100:7890",
    "secret": "your-api-secret"
  }
}
```

### 6. Webhook Notification

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

### Phase 1: Gateway Core
- [ ] Create `src/gateway/types.ts` - Gateway types (InboundMessage, OutboundMessage, etc.)
- [ ] Create `src/gateway/store.ts` - SQLite store with inbox/outbox tables
- [ ] Create `src/gateway/api.ts` - HTTP API server with auth
- [ ] Create `src/gateway/daemon.ts` - Daemon lifecycle (start/stop/reload)
- [ ] Create `src/gateway/webhook.ts` - Webhook notifier with debouncing

### Phase 2: Service Adapters
- [ ] Create `src/gateway/adapters/types.ts` - ServiceAdapter interface
- [ ] Create `src/gateway/adapters/whatsapp.ts` - WhatsApp adapter (using Baileys)
- [ ] Create `src/gateway/adapters/telegram.ts` - Telegram adapter (long-polling)

### Phase 3: Gateway CLI
- [ ] Create `src/commands/gateway.ts` - Gateway management commands
  - `gateway start [--foreground]`
  - `gateway stop`
  - `gateway status`
  - `gateway reload`
  - `gateway logs [--follow]`
- [ ] Register in `src/index.ts`

### Phase 4: Client CLI
- [ ] Create `src/gateway/client.ts` - HTTP client for gateway API
- [ ] Add inbox subcommands to `src/commands/whatsapp.ts`
- [ ] Add outbox subcommands to `src/commands/whatsapp.ts`
- [ ] Add inbox subcommands to `src/commands/telegram.ts`
- [ ] Add outbox subcommands to `src/commands/telegram.ts`
- [ ] Update send commands to route through gateway

### Phase 5: Testing & Polish
- [ ] End-to-end test: WhatsApp receive → inbox → ack
- [ ] End-to-end test: send → outbox → WhatsApp deliver
- [ ] End-to-end test: Telegram flow
- [ ] Webhook integration test
- [ ] Update README and skills

## CLI Examples

```bash
# === Gateway Management (on gateway host) ===
agentio gateway start                    # Start daemon in background
agentio gateway start --foreground       # Run in foreground (for debugging)
agentio gateway status                   # Show connected services
agentio gateway stop                     # Stop daemon
agentio gateway reload                   # Reload config, reconnect services

# === Inbox Operations (from any client) ===
agentio whatsapp inbox pull                          # Default profile
agentio whatsapp inbox pull --profile pierre         # Specific profile
agentio whatsapp inbox pull --profile pierre --limit 5
agentio whatsapp inbox get abc123 --profile pierre
agentio whatsapp inbox ack abc123 --profile pierre
agentio whatsapp inbox reply abc123 "Thanks!" --profile pierre
agentio whatsapp inbox stats --profile pierre

# === Send Operations (routed through gateway outbox) ===
agentio whatsapp send "Hello" --to +15551234567 --profile pierre
agentio telegram send "Hello" --to 123456789 --profile mybot

# === Outbox Operations (per profile) ===
agentio whatsapp outbox status xyz789 --profile pierre
agentio whatsapp outbox list --profile pierre --status failed
```

## Future Considerations

1. **TLS** - HTTPS support for gateway API
2. **Message Retention** - Auto-cleanup of old processed messages
3. **Attachments** - Download and store media files locally
4. **Rate Limiting** - Per-conversation send rate limits
5. **Metrics** - Prometheus endpoint for monitoring
6. **Clustering** - Multiple gateway instances with shared store
