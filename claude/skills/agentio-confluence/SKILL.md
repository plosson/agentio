---
name: agentio-confluence
description: Use when interacting with confluence via the agentio CLI.
---

# Confluence via agentio

Auto-generated from `agentio skill confluence`. Do not edit by hand.

## agentio confluence spaces

List Confluence spaces

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--limit <number>`: Maximum number of spaces (default: 50)
- `--type <type>`: Filter by type (global|personal|collaboration|knowledge_base)

```
Examples:

  # list all spaces
  agentio confluence spaces

  # only global spaces
  agentio confluence spaces --type global

  # with a limit
  agentio confluence spaces --limit 10
```

## agentio confluence pages

List Confluence pages

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--space <key>`: Filter by space key
- `--space-id <id>`: Filter by space id
- `--parent <id>`: Filter by parent page id
- `--limit <number>`: Maximum number of pages (default: 25)

```
Examples:

  # pages in a space
  agentio confluence pages --space ENG

  # child pages of a parent
  agentio confluence pages --parent 123456

  # more results
  agentio confluence pages --space ENG --limit 50
```

## agentio confluence get <page-id>

Get a Confluence page (with body)

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--format <format>`: Body format (storage|atlas_doc_format|view) (default: storage)

```
Examples:

  # get a page (storage format)
  agentio confluence get 123456

  # get in view format (rendered HTML)
  agentio confluence get 123456 --format view

  # get as Atlas document format
  agentio confluence get 123456 --format atlas_doc_format
```

## agentio confluence search

Search Confluence content using CQL

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--cql <query>`: Raw CQL query
- `--space <key>`: Filter by space key
- `--type <type>`: Filter by type (page|blogpost|comment|attachment)
- `--text <text>`: Free-text search
- `--limit <number>`: Maximum number of results (default: 25)

```
Examples:

  # free-text search
  agentio confluence search --text "deployment guide"

  # raw CQL query
  agentio confluence search --cql "space = ENG AND type = page AND title ~ 'API'"

  # pages in a space matching text
  agentio confluence search --space ENG --type page --text "onboarding"
```

## agentio confluence create

Create a Confluence page

Options:

- `--title <title>`: Page title
- `--profile <name>`: Profile name (optional if only one profile exists)
- `--space <key>`: Space key (or use --space-id)
- `--space-id <id>`: Space id (or use --space)
- `--parent <id>`: Parent page id
- `--content <text>`: Page body (or pipe via stdin)

```
Examples:

  # create a page in a space with inline content
  agentio confluence create --title "My Page" --space ENG --content "<p>Hello world</p>"

  # create with body piped from a file
  cat page.html | agentio confluence create --title "My Page" --space ENG

  # create as child of another page
  agentio confluence create --title "Sub Page" --space ENG --parent 123456 --content "<p>Content</p>"
```

## agentio confluence update <page-id>

Update a Confluence page (replaces body)

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--title <title>`: New page title (defaults to current title)
- `--content <text>`: Page body (or pipe via stdin)

```
Examples:

  # update page body inline
  agentio confluence update 123456 --content "<p>Updated content</p>"

  # update with body piped from a file
  cat updated.html | agentio confluence update 123456

  # update title and body
  agentio confluence update 123456 --title "New Title" --content "<p>New content</p>"
```

## agentio confluence comments <page-id>

List footer comments on a page

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)

```
Examples:

  # list all footer comments on a page
  agentio confluence comments 123456
```

## agentio confluence comment <page-id> [body]

Add a footer comment to a page

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)

```
Examples:

  # add an inline comment
  agentio confluence comment 123456 "Looks good to me!"

  # pipe comment body from stdin
  echo "LGTM" | agentio confluence comment 123456
```
