---
name: agentio-slack
description: Use when sending Slack messages, looking up workspace members, or creating and managing channels and their members, via the agentio CLI.
---

# Slack via agentio

Auto-generated from `agentio skill slack`. Do not edit by hand.

## agentio slack send [message]

Send a message to Slack

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json [file]`: Send Block Kit message from JSON file (or stdin if no file specified)

```
Examples:

  # send a quick text message to the default profile
  agentio slack send "deploy finished"

  # pipe message body via stdin
  echo "build failed: see logs" | agentio slack send

  # send a Block Kit payload from a JSON file
  agentio slack send --json ./alert.json

  # send to a specific profile
  agentio slack send --profile alerts "incident opened"
```

## agentio slack users list

List workspace members, with their display names

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read
- `--include-deleted`: Also list deactivated accounts
- `--include-bots`: Also list bots and Slackbot

```
Examples:

  agentio slack users list

  # members without a display name
  agentio slack users list --json | jq '.users[] | select(.displayName == null) | .email'
```

## agentio slack users get <user>

Show one member, by user id or email address

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read

```
Examples:

  agentio slack users get jane@example.com
  agentio slack users get U012AB3CD --json
```

## agentio slack channels list

List channels: every public one, and the private ones you belong to

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read
- `--private-only`: Only private channels
- `--include-archived`: Also list archived channels

```
Examples:

  agentio slack channels list
  agentio slack channels list --private-only --json
```

## agentio slack channels get <channel>

Show one channel, by id or name

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read

```
Examples:

  agentio slack channels get general
  agentio slack channels get C012AB3CD --json
```

## agentio slack channels create <name>

Create a channel; you become its first member

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read
- `--private`: Create a private channel
- `--topic <text>`: Channel topic, shown in the header
- `--purpose <text>`: Channel description

```
Examples:

  agentio slack channels create team-design --topic "Design reviews" --purpose "Where the design team works"
  agentio slack channels create hr-private --private
```

## agentio slack channels set <channel>

Change a channel's name, topic or purpose

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read
- `--name <name>`: New name
- `--topic <text>`: New topic; "" clears it
- `--purpose <text>`: New description; "" clears it

```
Examples:

  agentio slack channels set team-design --topic "Reviews on Thursdays"
  agentio slack channels set C012AB3CD --name design-team --purpose ""

Only name, topic and purpose can be changed through the API on Business+.
Posting permissions and other settings are in the Slack app.
```

## agentio slack channels archive <channel>

Archive a channel: read-only and out of the sidebar, history kept

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read

```
Examples:

  agentio slack channels archive old-project

Undo with: agentio slack channels unarchive old-project. Deleting a channel
for good is not possible through the API on Business+; an admin does it in the
Slack app (channel name, Settings, Delete this channel).
```

## agentio slack channels unarchive <channel>

Bring an archived channel back

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read

```
Examples:

  agentio slack channels unarchive old-project
```

## agentio slack channels leave <channels...>

Leave channels yourself

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read

```
Examples:

  agentio slack channels leave topic-apple topic-swift

Every channel is looked up first: one wrong name leaves none. Channels you
are not in are skipped. After leaving a private channel you no longer see it,
so only another member can invite you back.
```

## agentio slack channels members <channel>

List a channel's members

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read

```
Examples:

  agentio slack channels members team-design
  agentio slack channels members C012AB3CD --json | jq -r '.members[].email'
```

## agentio slack channels invite <channel> <users...>

Add people to a channel; Slack adds them at once, without asking them

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read

```
Examples:

  agentio slack channels invite team-design jane@example.com U012AB3CD

Every user is looked up first: one unknown email invites nobody. People
already in the channel are skipped. You must be a member of the channel.
```

## agentio slack channels uninvite <channel> <users...>

Remove people from a channel

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read

```
Examples:

  agentio slack channels uninvite team-design jane@example.com

Every user is looked up first: one unknown email removes nobody. People not
in the channel are skipped.
```

