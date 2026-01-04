---
name: agentio-gmail
description: Use when interacting with Gmail - list, read, search, send, reply to, archive, or mark emails. Requires agentio CLI with a configured Gmail profile.
---

# Gmail Operations with agentio

Use `agentio gmail` commands to interact with Gmail. Multiple profiles can be configured - the default profile is used unless you specify `--profile <name>`.

## List Messages

```bash
agentio gmail list [--limit N] [--query QUERY] [--label LABEL]
```

Options:
- `--limit <n>`: Number of messages (default: 10)
- `--query <query>`: Gmail search query
- `--label <label>`: Filter by label (repeatable)

## Get a Message

```bash
agentio gmail get <message-id> [--format text|html|raw] [--body-only]
```

Options:
- `--format`: Body format - `text` (default), `html`, or `raw`
- `--body-only`: Output only the message body

## Search Messages

```bash
agentio gmail search --query <query> [--limit N]
```

Query syntax:
- `from:john@example.com` - From specific sender
- `to:me` - Sent to you
- `after:2024/01/01` / `before:2024/12/31` - Date filters
- `newer_than:7d` / `older_than:1m` - Relative dates (d/m/y)
- `label:inbox` - In specific label
- `is:unread` / `is:starred` - Status filters
- `has:attachment` - With attachments
- `subject:invoice` - Search subject

Combine: `from:boss@work.com is:unread newer_than:7d`

## Send an Email

```bash
agentio gmail send --to <email> --subject <subject> [--body <body>] [options]
```

Options:
- `--to <email>`: Recipient (repeatable)
- `--cc <email>`: CC recipient (repeatable)
- `--bcc <email>`: BCC recipient (repeatable)
- `--subject <subject>`: Email subject
- `--body <body>`: Email body (or pipe via stdin)
- `--html`: Treat body as HTML
- `--attachment <path>`: File to attach (repeatable)

## Reply to a Thread

```bash
agentio gmail reply --thread-id <id> [--body <body>] [--html]
```

## Archive a Message

```bash
agentio gmail archive <message-id>
```

## Mark as Read/Unread

```bash
agentio gmail mark <message-id> --read
agentio gmail mark <message-id> --unread
```
