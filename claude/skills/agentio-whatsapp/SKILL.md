---
name: agentio-whatsapp
description: Use when interacting with WhatsApp via the agentio CLI - send/receive, group management. Requires daemon.
---

# Whatsapp via agentio

Auto-generated from `agentio skill whatsapp`. Do not edit by hand.

## agentio whatsapp inbox pull

Get pending messages from inbox

Options:

- `--profile <name>`: Profile name
- `--limit <n>`: Maximum messages to retrieve (default: 50)
- `--status <status>`: Filter by status: pending or done (default: pending)
- `--conversation <id>`: Filter by conversation/group (name or JID)

```
Examples:

  # pending messages on the default profile
  agentio whatsapp inbox pull

  # last 100 already-acked messages
  agentio whatsapp inbox pull --status done --limit 100

  # pending messages from one group, by name
  agentio whatsapp inbox pull --conversation "Family Chat"

  # pending messages from one direct chat, by phone JID
  agentio whatsapp inbox pull --conversation 15551234567@s.whatsapp.net
```

## agentio whatsapp inbox get <id>

Get a specific inbox message

```
Examples:

  # fetch one inbox message in full
  agentio whatsapp inbox get wa_abc123
```

## agentio whatsapp inbox ack <id>

Mark a message as done

```
Examples:

  # mark a message as done so it stops appearing in pending pulls
  agentio whatsapp inbox ack wa_abc123
```

## agentio whatsapp inbox reply <id> [message]

Reply to an inbox message

```
Examples:

  # quick text reply to an incoming message
  agentio whatsapp inbox reply wa_abc123 "on my way"

  # pipe a longer reply via stdin
  cat draft.txt | agentio whatsapp inbox reply wa_abc123
```

## agentio whatsapp inbox stats

Get inbox statistics

Options:

- `--profile <name>`: Profile name

```
Examples:

  # totals across all whatsapp profiles
  agentio whatsapp inbox stats

  # totals for a single profile
  agentio whatsapp inbox stats --profile personal
```

## agentio whatsapp outbox send [message]

Queue a message for sending

Options:

- `--profile <name>`: Profile name
- `--to <phone>`: Destination phone number (with country code, e.g., +1234567890)
- `--group <name>`: Destination group (name or JID)
- `--attachment <path>`: Path to file attachment (image, video, audio, or document)
- `--type <type>`: Media type: image, video, audio, document (auto-detected if not specified)

```
Examples:

  # text message to a phone number
  agentio whatsapp outbox send --to +15551234567 "running late, 10 min"

  # text message to a group by name
  agentio whatsapp outbox send --group "Family Chat" "dinner at 7?"

  # send a photo with caption
  agentio whatsapp outbox send --to +15551234567 --attachment ./photo.jpg "from the trail"

  # send a document (PDF) auto-detected
  agentio whatsapp outbox send --group "Project Team" --attachment ./report.pdf

  # pipe message body via stdin
  echo "build complete" | agentio whatsapp outbox send --to +15551234567
```

## agentio whatsapp outbox status <id>

Check send status of a message

```
Examples:

  # check delivery state of a queued message
  agentio whatsapp outbox status ob_abc123
```

## agentio whatsapp outbox list

List outbox messages

Options:

- `--profile <name>`: Profile name
- `--status <status>`: Filter by status: pending, sending, sent, or failed
- `--limit <n>`: Maximum messages to retrieve (default: 50)

```
Examples:

  # last 50 outbox messages across all profiles
  agentio whatsapp outbox list

  # only failed messages
  agentio whatsapp outbox list --status failed

  # in-flight messages on a single profile
  agentio whatsapp outbox list --profile personal --status sending --limit 100
```

## agentio whatsapp group list

List all groups

Options:

- `--profile <name>`: Profile name

```
Examples:

  # all groups visible to the default profile
  agentio whatsapp group list

  # groups on a named profile
  agentio whatsapp group list --profile personal
```

## agentio whatsapp group get <id>

Get group details

Options:

- `--profile <name>`: Profile name

```
Examples:

  # look up a group by name (fuzzy match)
  agentio whatsapp group get "Family Chat"

  # look up by JID
  agentio whatsapp group get 120363123456789012@g.us
```

## agentio whatsapp group create <name>

Create a new group

Options:

- `--profile <name>`: Profile name
- `--participants <phones...>`: Participant phone numbers
- `--picture <path>`: Path to group profile picture

```
Examples:

  # create a group with two participants
  agentio whatsapp group create "Project Team" --participants +15551234567 +15557654321

  # create a group with a profile picture
  agentio whatsapp group create "Book Club" \
    --participants +15551234567 +15557654321 \
    --picture ./logo.png
```

## agentio whatsapp group update <id>

Update group info

Options:

- `--profile <name>`: Profile name
- `--name <name>`: New group name
- `--description <text>`: New group description
- `--picture <path>`: Path to new group profile picture

```
Examples:

  # rename a group
  agentio whatsapp group update "Old Name" --name "New Name"

  # change description
  agentio whatsapp group update "Project Team" --description "Q2 planning"

  # change profile picture
  agentio whatsapp group update "Book Club" --picture ./new-logo.png
```

## agentio whatsapp group add <id> <phones...>

Add participants to group

Options:

- `--profile <name>`: Profile name

```
Examples:

  # add one participant by group name
  agentio whatsapp group add "Project Team" +15551234567

  # add several participants at once
  agentio whatsapp group add "Project Team" +15551234567 +15557654321
```

## agentio whatsapp group remove <id> <phones...>

Remove participants from group

Options:

- `--profile <name>`: Profile name

```
Examples:

  # remove one participant
  agentio whatsapp group remove "Project Team" +15551234567

  # remove several at once
  agentio whatsapp group remove "Project Team" +15551234567 +15557654321
```

## agentio whatsapp group promote <id> <phones...>

Promote participants to admin

Options:

- `--profile <name>`: Profile name

```
Examples:

  # promote one participant to admin
  agentio whatsapp group promote "Project Team" +15551234567

  # promote several at once
  agentio whatsapp group promote "Project Team" +15551234567 +15557654321
```

## agentio whatsapp group demote <id> <phones...>

Demote admins to regular participants

Options:

- `--profile <name>`: Profile name

```
Examples:

  # demote one admin
  agentio whatsapp group demote "Project Team" +15551234567

  # demote several at once
  agentio whatsapp group demote "Project Team" +15551234567 +15557654321
```

## agentio whatsapp group leave <id>

Leave a group

Options:

- `--profile <name>`: Profile name

```
Examples:

  # leave a group by name (asks for confirmation)
  agentio whatsapp group leave "Old Project"

  # leave by JID
  agentio whatsapp group leave 120363123456789012@g.us
```

## agentio whatsapp group invite <id>

Get group invite link

Options:

- `--profile <name>`: Profile name

```
Examples:

  # get the share link for a group (admin only)
  agentio whatsapp group invite "Project Team"
```

## agentio whatsapp group join <code>

Join group via invite code or link

Options:

- `--profile <name>`: Profile name

```
Examples:

  # join via the invite code (last segment of the URL)
  agentio whatsapp group join AbCdEf1234567890

  # join via the full invite URL
  agentio whatsapp group join https://chat.whatsapp.com/AbCdEf1234567890
```
