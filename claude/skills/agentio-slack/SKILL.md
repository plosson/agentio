---
name: agentio-slack
description: Use when sending or reading Slack messages, downloading files shared in Slack, reading or writing Slack canvases as Markdown, looking up workspace members, or creating and managing channels and their members, via the agentio CLI.
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

## agentio slack messages

Read every message since a date in the conversations you are in (with --include-public, every public channel too), threads included (needs a user token profile)

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read
- `--since <date>`: Start, included: YYYY-MM-DD (midnight UTC) or an ISO 8601 timestamp
- `--until <date>`: End, included, same formats; a date alone means the end of that day (default: now)
- `--channel <channel>`: Only this conversation, by id or name; repeat for more
- `--types <list>`: Comma-separated: channel, private, dm, group (default: all)
- `--include-public`: Also read public channels you are not in, without joining them
- `--raw`: Keep Slack's text markup as sent: <@U…> mentions, <url|label> links

```
Examples:

  # everything since Monday, for a digest
  agentio slack messages --since 2026-10-26

  # one week of two channels, as JSON
  agentio slack messages --since 2026-10-01 --until 2026-10-08 --channel eng --channel '#design' --json

  # direct messages only
  agentio slack messages --since 2026-10-20 --types dm,group

  # also the public channels you never joined; nothing is joined or marked read
  agentio slack messages --since 2026-10-26 --include-public

Replies in threads that started before --since are found through search
(needs search:read); without it they are left out, with a warning.

In --json, each conversation has isMember; each message has permalink, and
realName and displayName for its author; each file has id, name, mimetype,
size, urlPrivateDownload and permalink (download it with: agentio slack download).
Links read "label (url)" and mentions "@name"; --raw keeps Slack's markup.
```

## agentio slack download <file>

Download one file shared in Slack (needs files:read)

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read
- `--out <path>`: File to write, or a folder to write into (default: the file's name in the current folder)

```
Examples:

  # file ids are in: agentio slack messages --json (files[].id)
  agentio slack download F0123ABCDEF --out ./screenshot.png

  # by link, into a folder
  agentio slack download https://files.slack.com/files-pri/T0123ABCD-F0123ABCDEF/download/report.pdf --out ./files/
```

## agentio slack attachments

Download every file shared in a date range, with a manifest (needs files:read)

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read
- `--since <date>`: Start, included: YYYY-MM-DD (midnight UTC) or an ISO 8601 timestamp
- `--until <date>`: End, included, same formats; a date alone means the end of that day (default: now)
- `--channel <channel>`: Only this conversation, by id or name; repeat for more (default: all)
- `--types <list>`: Comma-separated: channel, private, dm, group (default: all)
- `--include-public`: Also public channels you are not in, without joining them
- `--out <dir>`: Folder to save files and manifest.json / manifest.csv into (default: slack-attachments)
- `--dry-run`: Only list the files and write the manifest; download nothing

```
Examples:

  # every file shared in one channel this month
  agentio slack attachments --channel eng --since 2026-10-01 --out ./eng-files

  # see what would be saved, without downloading
  agentio slack attachments --since 2026-10-26 --dry-run

Files are named <YYYY-MM-DD>_<sender>_<file name>; clashes get " (2)", " (3)"...
The manifest has one row per file: conversation, message ts and permalink,
sender, file id, name, type, size, saved path, status and error. Deleted files,
files hidden by the plan's history limit and links to files stored outside
Slack are recorded as skipped. A file that fails is recorded with its error and
the run continues; the exit code is 1 if any failed.
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

  agentio slack channels leave old-project team-offsite

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

## agentio slack canvases list

List the canvases you can see, newest edit first

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read
- `--channel <channel>`: Only this channel's canvas
- `--mine`: Only canvases you created

```
Examples:

  agentio slack canvases list
  agentio slack canvases list --mine --json
  agentio slack canvases list --channel '#eng'
```

## agentio slack canvases get <canvas>

Print a canvas as Markdown; what cannot be written back is listed on stderr

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read

```
Examples:

  agentio slack canvases get F07ABC1234 > plan.md
  agentio slack canvases get https://example.slack.com/docs/T0123/F07ABC1234
  agentio slack canvases get '#eng' --json
```

## agentio slack canvases create [title] [file]

Create a canvas from Markdown (file or stdin)

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read
- `--channel <channel>`: Create this channel's canvas instead; then give no title

```
Examples:

  agentio slack canvases create "Release notes" notes.md
  echo "# Runbook" | agentio slack canvases create "Runbook"
  agentio slack canvases create --channel '#eng' plan.md
```

## agentio slack canvases set <canvas> [file]

Replace a canvas's whole content with Markdown (file or stdin)

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read
- `--force`: Allow empty content, which clears the canvas

```
Examples:

  agentio slack canvases get F07ABC1234 > plan.md
  # edit plan.md
  agentio slack canvases set F07ABC1234 plan.md

Parts listed by get as "can't be written back" (embedded files, layouts) are
replaced by what the Markdown says.
```

## agentio slack canvases rename <canvas> <title>

Change a canvas's title

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read

```
Examples:

  agentio slack canvases rename F07ABC1234 "Plan, v2"
```

## agentio slack canvases share <canvas>

Give users or channels access to a canvas

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read
- `--to <targets...>`: Users (U…, or email) and channels (#name, C…); comma-separated or repeated
- `--level <level>`: read, write or owner (default: read)

```
Examples:

  agentio slack canvases share F07ABC1234 --to '#eng' --to alice@example.com
  agentio slack canvases share F07ABC1234 --to U012AB3CD --level write
```

## agentio slack canvases unshare <canvas>

Remove users' or channels' access to a canvas

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read
- `--from <targets...>`: Users (U…, or email) and channels (#name, C…); comma-separated or repeated

```
Examples:

  agentio slack canvases unshare F07ABC1234 --from '#eng'
```

## agentio slack canvases delete <canvas>

Delete a canvas; this cannot be undone

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read
- `-y, --yes`: Do not ask for confirmation

```
Examples:

  agentio slack canvases delete F07ABC1234
  agentio slack canvases delete F07ABC1234 --yes   # from a script
```

