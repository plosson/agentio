# Discord API Analysis for agentio CLI Integration

## Overview

Discord is a communication platform primarily used for communities, gaming, and team collaboration. The Discord API enables developers to build bots and applications that interact with Discord servers (guilds), channels, and users.

## API Capabilities

### Current API Version
- **API Version**: v10 (current stable version)
- **Base URL**: `https://discord.com/api/v10`
- **Protocol**: RESTful API with standard HTTP methods (GET, POST, PUT, DELETE)

### Key Endpoints for agentio Use Cases

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/channels/{channel_id}/messages` | GET | Retrieve messages from a channel |
| `/channels/{channel_id}/messages` | POST | Send a message to a channel |
| `/channels/{channel_id}/messages/{message_id}` | GET | Get a specific message |
| `/channels/{channel_id}/messages/{message_id}` | PATCH | Edit a message |
| `/channels/{channel_id}/messages/{message_id}` | DELETE | Delete a message |
| `/users/@me/guilds` | GET | List user's guilds (servers) |
| `/guilds/{guild_id}/channels` | GET | List channels in a guild |

### Webhook Support
Discord provides robust webhook support for one-way message sending:
- **URL Format**: `https://discord.com/api/webhooks/{webhook_id}/{webhook_token}`
- **Method**: POST only
- **Features**: Rich embeds, file uploads, custom username/avatar per message
- **Limitation**: Cannot receive responses or read messages (send-only)

## Authentication Methods

### 1. Bot Token Authentication (Recommended for agentio)
- **How it works**: Create an application in the Discord Developer Portal, enable the bot feature, and obtain a bot token
- **Header format**: `Authorization: Bot <token>`
- **Pros**:
  - Simple setup - single token
  - Full API access
  - No OAuth flow required for CLI usage
  - Persistent - token doesn't expire until reset
- **Cons**:
  - Bot must be invited to each server by an admin
  - Requires "privileged intents" approval if in 100+ servers

### 2. OAuth 2.0
- **Use case**: User-facing applications where the user authorizes access
- **Scopes**: `bot`, `applications.commands`, `identify`, `guilds`, etc.
- **Not ideal for agentio**: Would require browser-based authorization flow per user

### 3. Webhook Authentication
- **How it works**: URL contains embedded token
- **Pros**: Simplest setup, no bot required
- **Cons**: Send-only, no read capability

## Required Permissions/Intents

### Bot Permissions (for channel operations)
| Permission | Hex Value | Required For |
|------------|-----------|--------------|
| VIEW_CHANNEL | 0x0000000400 | Access channel |
| SEND_MESSAGES | 0x0000000800 | Send messages |
| READ_MESSAGE_HISTORY | 0x0000010000 | Retrieve message history |
| EMBED_LINKS | 0x0000004000 | Send rich embeds |
| ATTACH_FILES | 0x0000008000 | Upload attachments |
| MANAGE_MESSAGES | 0x0000002000 | Delete/pin messages |

### Privileged Gateway Intents
Three intents require special approval for verified bots (100+ servers):

1. **PRESENCE_INTENT**: User online/offline status (not needed for agentio)
2. **SERVER_MEMBERS_INTENT**: Member join/leave events (not needed for agentio)
3. **MESSAGE_CONTENT_INTENT**: Access to message content - **Required for reading messages**

**Note**: For unverified bots (< 100 servers), these intents can be enabled freely in the Developer Portal.

## Rate Limits

### Global Limits
- **50 requests per second** global rate limit
- Route-specific limits apply additionally

### Response Handling
- **429 Too Many Requests**: Response includes `retry_after` value (in seconds)
- **X-RateLimit-Remaining**: Header showing remaining requests
- **X-RateLimit-Reset**: Header with reset timestamp

### Best Practices
- Implement exponential backoff on 429 responses
- Track rate limit headers
- Avoid making requests on exhausted buckets

## Pricing & Costs

### Free Tier
- **Bot creation**: Free (unlimited bots can be created in Developer Portal)
- **API access**: Free, no pay-per-call pricing
- **Rate limits**: Same for all bots (no paid tier for higher limits)

### Considerations
- Hosting costs for bot (not Discord's concern)
- No API costs from Discord

## Feasibility Assessment

### Feasibility: HIGH

Discord integration is **highly feasible** for agentio for the following reasons:

1. **Simple Authentication**: Bot token authentication is straightforward - single token, no OAuth browser flow needed
2. **RESTful API**: Standard HTTP API matches agentio's fetch-based approach (like Telegram)
3. **Free Access**: No API costs, generous rate limits
4. **Webhook Alternative**: For send-only use cases, webhooks provide an even simpler option
5. **Well-Documented**: Extensive official documentation and community resources

### Recommended Integration Approach

Support **two profile types** (similar to planned GChat approach):

1. **Bot Profile**: Full read/write access via bot token
   - Requires: Bot token, channel ID(s)
   - Capabilities: send, list, get, delete messages

2. **Webhook Profile**: Write-only access via webhook URL
   - Requires: Webhook URL only
   - Capabilities: send messages only
   - Simpler setup, good for notifications

## Risks and Limitations

### Technical Limitations
1. **Gateway Requirement**: Before using message endpoints, bot must connect to Gateway at least once (one-time requirement)
2. **Channel-Scoped Access**: Bot only sees channels it has permission to access
3. **No DM List Access**: Cannot list all DMs, only access specific DM channels by ID
4. **Message Content Intent**: Required to read message content (free for < 100 servers, requires approval above)

### Operational Risks
1. **Server Admin Dependency**: Bot must be invited by server admin - users cannot add bot to servers they don't manage
2. **Permission Variability**: Permissions can differ per channel, requiring careful error handling
3. **Rate Limit Complexity**: Route-specific limits require per-endpoint tracking

### Security Considerations
1. **Token Security**: Bot token provides full bot access - must be stored securely (matches agentio's encrypted storage approach)
2. **No Token Expiry**: Tokens don't expire, reducing refresh complexity but increasing theft risk

## Comparison with Existing agentio Services

| Aspect | Discord | Telegram | Gmail |
|--------|---------|----------|-------|
| Auth Type | Bot Token / Webhook | Bot Token | OAuth 2.0 |
| Setup Complexity | Low | Low | Medium |
| Read Messages | Yes (with intent) | Yes | Yes |
| Send Messages | Yes | Yes | Yes |
| Webhooks | Yes | No | N/A |
| Rate Limits | 50 req/sec | 30 msg/sec | Quota-based |

Discord's integration pattern is most similar to Telegram - bot token authentication with a RESTful API.

## Conclusion

**Recommendation: PROCEED WITH IMPLEMENTATION**

Discord is an excellent fit for agentio:
- Bot token auth aligns with existing Telegram pattern
- RESTful API matches project architecture
- Dual profile support (bot/webhook) provides flexibility
- No API costs
- Strong community and documentation

The implementation should follow the existing service patterns, with discriminated union types for bot vs webhook credentials.

## Sources

- [Discord Developer Portal - OAuth2](https://discord.com/developers/docs/topics/oauth2)
- [Discord Developer Portal - Rate Limits](https://discord.com/developers/docs/topics/rate-limits)
- [Discord Developer Portal - Webhooks](https://discord.com/developers/docs/resources/webhook)
- [Discord.js Guide - Setting Up Bot Application](https://discordjs.guide/preparations/setting-up-a-bot-application.html)
- [Discord API Docs - GitHub](https://github.com/discord/discord-api-docs)
- [What are Privileged Intents - Discord Support](https://support-dev.discord.com/hc/en-us/articles/6207308062871-What-are-Privileged-Intents)
- [Discord Permissions Calculator](https://discordapi.com/permissions.html)
- [How to Configure Discord Webhooks - Hookdeck](https://hookdeck.com/webhooks/platforms/tutorial-how-to-configure-discord-webhooks-using-the-api)
