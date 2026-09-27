---
name: WhatsApp
slug: whatsapp
auth: Linked device
tagline: Send and read messages from a linked WhatsApp account.
icon: 📱
order: 25
---

> **Ban risk.** agentio talks to WhatsApp through [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial library, and Meta can ban a number used for automation. Use a dedicated number, not your personal one.

## What you can do

- List conversations, with their unread counts
- Read the last messages of a chat
- Send text to a phone number, a group, or a known name
- List the names agentio knows, with their number

## How it works

The agentio daemon keeps one connection per linked account while the vault is unlocked. Every command, pairing included, goes through the daemon, locally or on the hub. The CLI never connects to WhatsApp itself, so the daemon must be running.

Chats, recent messages and names are kept in an encrypted store next to the vault, so they are still there after a restart. Media is shown as a placeholder such as `[image]`.

## Setup

```sh
# in another terminal: the daemon runs in the foreground
agentio daemon start

agentio whatsapp profile add --profile work
```

Scan the QR code from WhatsApp > Settings > Linked devices. Over SSH, add `--phone +33612345678` to get a code to type on the phone instead.

## Good to know

- `read` marks the messages it shows as read (blue ticks). Add `--no-read-receipts` to avoid that. A read-only profile never sends receipts or messages.
- WhatsApp sometimes identifies people by a hidden ID instead of their number. They are shown by name and ID, and you can still send to them.
- A name works only when it matches exactly one known name. Run `agentio whatsapp contacts` to see them.
