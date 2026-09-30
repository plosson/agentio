---
name: agentio-kite
description: Use when publishing Markdown or HTML documents as private web pages on Kite, sharing them, or reading and answering their comments via the agentio CLI.
---

# Kite via agentio

Auto-generated from `agentio skill kite`. Do not edit by hand.

## agentio kite publish <file>

Publish a Markdown or HTML file as a new document, or update one with --id

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read
- `--id <id>`: Update this document (art_…) instead of publishing a new one
- `--title <title>`: Document title

```
Examples:

  # publish a Markdown file; prints its id and private link
  agentio kite publish notes.md --title "Weekly notes" --json

  # publish a new version of an existing document
  agentio kite publish notes.md --id art_abc123

Updating fails if someone changed the document since you last read it;
read it again with `agentio kite get` and re-apply your change.
```

## agentio kite get <id-or-link>

Read a document by id or link

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read
- `--out <file>`: Write the content to this file (replacing it if it exists) instead of printing it

```
Examples:

  # read a document someone sent you a link to
  agentio kite get https://kite.example.com/a/Xy7fQ2

  # save your own document to a file, to edit and publish again
  agentio kite get art_abc123 --out notes.md --json
```

## agentio kite list

List your documents, newest first

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read

```
Examples:

  # every document you own
  agentio kite list --json
```

## agentio kite delete <id>

Delete a document for good

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read
- `--confirm`: Required: deleting cannot be undone

```
Examples:

  # delete a document and its link
  agentio kite delete art_abc123 --confirm
```

## agentio kite share show <id>

Show who can open a document

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read

```
Examples:

  agentio kite share show art_abc123 --json
```

## agentio kite share add <id> <email-or-domain>

Share a document with a person (emailed) or everyone at a domain

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read

```
Examples:

  # share with one person; they get an email the first time
  agentio kite share add art_abc123 alice@example.com

  # share with everyone signed in with an example.com address
  agentio kite share add art_abc123 example.com
```

## agentio kite share remove <id> <email-or-domain>

Stop sharing a document with a person or a domain

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read

```
Examples:

  agentio kite share remove art_abc123 alice@example.com
```

## agentio kite share public <id>

Let anyone with the link open the document

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read

```
Examples:

  agentio kite share public art_abc123
```

## agentio kite share private <id>

Only the people and domains it is shared with can open the document

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read

```
Examples:

  agentio kite share private art_abc123
```

## agentio kite share expiry <id> <duration>

Set when sharing ends

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read

```
Examples:

  # sharing ends in 30 days
  agentio kite share expiry art_abc123 30d

  # sharing never ends
  agentio kite share expiry art_abc123 forever
```

## agentio kite comments list <id>

List comment threads on a document

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read
- `--status <status>`: open or resolved
- `--since <timestamp>`: Only threads with a comment after this ISO 8601 time

```
Examples:

  # open threads on a document
  agentio kite comments list art_abc123 --status open --json

  # what is new since you last looked
  agentio kite comments list art_abc123 --since 2026-01-31T09:00:00Z
```

## agentio kite comments add <id>

Comment on a document, a passage or an element

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read
- `--body <text>`: The comment; @email mentions notify people
- `--snippet <text>`: Exact text of the passage, as rendered (8 to 2000 characters)
- `--heading <id>`: Search for the snippet only under this heading id (needs --snippet)
- `--element-id <id>`: HTML documents: the id of the element to comment on

```
Examples:

  # a comment on the whole document
  agentio kite comments add art_abc123 --body "Looks good overall"

  # a comment on a passage, found anywhere in the document
  agentio kite comments add art_abc123 --snippet "ship it by Friday" --body "Is Friday realistic?"

  # only look for the passage under one heading
  agentio kite comments add art_abc123 --snippet "ship it by Friday" --heading timeline --body "Which Friday?"
```

## agentio kite comments reply <thread-id>

Reply to a comment thread

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read
- `--body <text>`: The reply

```
Examples:

  agentio kite comments reply thr_abc123 --body "Done, see version 3"
```

## agentio kite comments resolve <thread-id>

Mark a comment thread resolved

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read

```
Examples:

  agentio kite comments resolve thr_abc123
```

## agentio kite comments reopen <thread-id>

Reopen a resolved comment thread

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--json`: Output JSON for programs to read

```
Examples:

  agentio kite comments reopen thr_abc123
```
