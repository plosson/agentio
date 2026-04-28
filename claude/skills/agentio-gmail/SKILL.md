---
name: agentio-gmail
description: Use when interacting with Gmail via the agentio CLI - list, read, search, send, draft, reply, archive, mark, attachments, export.
---

# Gmail via agentio

Auto-generated from `agentio skill gmail`. Do not edit by hand.

## agentio gmail list

List messages

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--limit <n>`: Number of messages (default: 10)
- `--query <query>`: Gmail search query (see "gmail search --help" for syntax)
- `--label <label>`: Filter by label (repeatable) (default: )

```
Examples:

  # 10 most recent messages
  agentio gmail list

  # 25 most recent in the inbox
  agentio gmail list --limit 25 --label INBOX

  # unread messages from the last week
  agentio gmail list --query "is:unread newer_than:7d"

  # use a specific profile
  agentio gmail list --profile alice@example.com
```

## agentio gmail get <message-id>

Get a message

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--format <format>`: Body format: text, html, or raw (default: text)
- `--body-only`: Output only the message body

```
Examples:

  # full message with headers
  agentio gmail get 18c4f1a2b3d

  # plain-text body only (good for piping to a file)
  agentio gmail get 18c4f1a2b3d --body-only > message.txt

  # raw HTML body
  agentio gmail get 18c4f1a2b3d --format html --body-only
```

## agentio gmail search

Search messages using Gmail query syntax

Options:

- `--query <query>`: Search query
- `--profile <name>`: Profile name (optional if only one profile exists)
- `--limit <n>`: Max results (default: 10)

```
Examples:

  # unread mail from a specific sender in the last week
  agentio gmail search --query "from:alice@example.com is:unread newer_than:7d"

  # messages with attachments after a date
  agentio gmail search --query "has:attachment after:2024/01/01" --limit 25

  # subject keyword in inbox, excluding spam
  agentio gmail search --query "subject:invoice label:inbox -label:spam"

  # exact phrase across all mail
  agentio gmail search --query '"quarterly report"'

Query syntax: from:, to:, cc:, subject:, label:, is:unread|starred|important,
has:attachment, after:YYYY/MM/DD, before:YYYY/MM/DD, newer_than:7d, older_than:1m.
Combine with spaces (AND), OR, or - to negate.
```

## agentio gmail send

Send an email

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--to <email>`: Recipient (repeatable, required unless --reply-to) (default: )
- `--cc <email>`: CC recipient (repeatable) (default: )
- `--bcc <email>`: BCC recipient (repeatable) (default: )
- `--subject <subject>`: Email subject (required unless --reply-to)
- `--body <body>`: Email body (or pipe via stdin)
- `--html`: Treat body as HTML
- `--reply-to <thread-id>`: Thread ID to reply to (derives to/subject from thread)
- `--attachment <path>`: File to attach (repeatable) (default: )
- `--inline <cid:path>`: Inline image (repeatable, format: contentId:filepath). Supports PNG, JPG, GIF only (not SVG) (default: )

```
Examples:

  # plain-text email
  agentio gmail send --to alice@example.com --subject "Hello" --body "Hi Alice!"

  # body from stdin (great for piping)
  echo "Sent via pipe" | agentio gmail send --to alice@example.com --subject "Note"

  # reply within an existing thread (to/subject derived from thread)
  agentio gmail send --reply-to 18c4f1a2b3d --body "Thanks!"

  # HTML body with an attachment and an inline image
  agentio gmail send --to alice@example.com --cc bob@example.com \
    --subject "Report" --html \
    --body '<p>See chart:</p><img src="cid:chart1">' \
    --attachment ./report.pdf --inline chart1:./chart.png
```

## agentio gmail draft

Create an email draft

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--to <email>`: Recipient (repeatable, required unless --reply-to) (default: )
- `--cc <email>`: CC recipient (repeatable) (default: )
- `--bcc <email>`: BCC recipient (repeatable) (default: )
- `--subject <subject>`: Email subject (required unless --reply-to)
- `--body <body>`: Email body (or pipe via stdin)
- `--html`: Treat body as HTML
- `--reply-to <thread-id>`: Thread ID to reply to (derives to/subject from thread)
- `--attachment <path>`: File to attach (repeatable) (default: )
- `--inline <cid:path>`: Inline image (repeatable, format: contentId:filepath). Supports PNG, JPG, GIF only (not SVG) (default: )

```
Examples:

  # save a draft for later editing in Gmail
  agentio gmail draft --to alice@example.com --subject "Hello" --body "Draft body"

  # draft a reply within an existing thread
  agentio gmail draft --reply-to 18c4f1a2b3d --body "Draft reply"

  # draft with attachment, body from stdin
  cat message.txt | agentio gmail draft --to alice@example.com \
    --subject "Notes" --attachment ./notes.pdf
```

## agentio gmail archive <message-id...>

Archive one or more messages

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)

```
Examples:

  # archive one message
  agentio gmail archive 18c4f1a2b3d

  # archive several at once
  agentio gmail archive 18c4f1a2b3d 18c4f1a2b3e 18c4f1a2b3f
```

## agentio gmail mark <message-id...>

Mark one or more messages as read or unread

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--read`: Mark as read
- `--unread`: Mark as unread

```
Examples:

  # mark one message as read
  agentio gmail mark 18c4f1a2b3d --read

  # mark several back to unread
  agentio gmail mark 18c4f1a2b3d 18c4f1a2b3e --unread
```

## agentio gmail labels list

List all labels

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)

```
Examples:

  # list every label (system + user)
  agentio gmail labels list

  # list labels for a specific profile
  agentio gmail labels list --profile alice@example.com
```

## agentio gmail labels create <name>

Create a new label

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)

```
Examples:

  # create a top-level label
  agentio gmail labels create receipts

  # create a nested label (use "/" for hierarchy)
  agentio gmail labels create auto/receipts

  # nested two levels deep
  agentio gmail labels create work/clients/acme
```

## agentio gmail labels delete <name-or-id>

Delete a user label

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)

```
Examples:

  # delete a user label by name
  agentio gmail labels delete receipts

  # delete a nested label
  agentio gmail labels delete auto/receipts

  # delete by label ID
  agentio gmail labels delete Label_1234567890
```

## agentio gmail labels rename <old> <new>

Rename a user label

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)

```
Examples:

  # rename a label
  agentio gmail labels rename receipts invoices

  # move a label into a nested hierarchy
  agentio gmail labels rename receipts auto/receipts
```

## agentio gmail label <id...>

Apply and/or remove labels on messages or threads

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--apply <name>`: Label to apply (name or ID, repeatable) (default: )
- `--remove <name>`: Label to remove (name or ID, repeatable) (default: )
- `--thread`: Treat IDs as thread IDs

```
Examples:

  # apply a label to one message
  agentio gmail label 18c4f1a2b3d --apply receipts

  # remove a label from several messages
  agentio gmail label 18c4f1a2b3d 18c4f1a2b3e --remove INBOX

  # archive (remove INBOX) and apply a label in one call
  agentio gmail label 18c4f1a2b3d --apply auto/receipts --remove INBOX

  # apply multiple labels to a thread
  agentio gmail label 18c4f1a2b3d --thread --apply important --apply work
```

## agentio gmail attachment <message-id>

Download attachments from a message

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--name <filename>`: Download specific attachment by filename (downloads all if not specified)
- `--output <dir>`: Output directory (default: .)

```
Examples:

  # download every attachment to the current directory
  agentio gmail attachment 18c4f1a2b3d

  # download all attachments to a specific folder
  agentio gmail attachment 18c4f1a2b3d --output ./downloads

  # download just one attachment by filename
  agentio gmail attachment 18c4f1a2b3d --name invoice.pdf --output ./downloads
```

## agentio gmail export <message-id>

Export a message as PDF

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--output <path>`: Output file path (default: message.pdf)

```
Examples:

  # export to default message.pdf in CWD
  agentio gmail export 18c4f1a2b3d

  # export to a specific path
  agentio gmail export 18c4f1a2b3d --output ./archive/invoice.pdf

Requires Chrome, Chromium, or Microsoft Edge installed locally.
```
