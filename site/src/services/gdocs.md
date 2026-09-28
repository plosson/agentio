---
name: Google Docs
slug: gdocs
auth: OAuth
tagline: Read, create and update Docs as Markdown.
icon: 📄
order: 110
---

## What you can do

- Pull a Doc as Markdown for an LLM to summarize
- Create new Docs from Markdown content
- Replace a Doc's content with Markdown, keeping its ID, link and sharing
- List recent Docs in your Drive
- Make precise edits with raw Docs API requests (`structure`, `tabs`, `batch`)

## Setup

```sh
agentio gdocs profile add
```

gdocs asks for full Google Drive access, so `update` can rewrite documents agentio did not create. A profile signed in with an earlier version must sign in again: `agentio profile reauth gdocs <profile>`.

## Editing from Markdown

```sh
agentio gdocs get 1A2bCdEf... --output doc.md
# edit doc.md
agentio gdocs update 1A2bCdEf... --file doc.md
```

`update` replaces the whole document. It refuses, unless you add `--force`, when that would lose something Markdown cannot carry: extra tabs, pending suggestions, or open comments. To change one part without touching the rest, read the indices with `structure` and send requests with `batch`.

## Markdown fidelity

Google converts the Markdown in both directions: agentio does not. What comes through:

- Headings, bold, italic, strikethrough, inline code, links
- Bullet, numbered and check lists, nested lists
- Tables, code blocks, blockquotes, horizontal rules, footnotes
- Images, fetched from their URL when the document is created

What is lost or changed:

- Comments and suggestions. `get` exports a pending suggestion as plain text, with both the inserted and the deleted words, so accept or reject suggestions before a round trip.
- Headers, footers, smart chips, drawings, exact fonts and colours
- Tabs: `get` exports every tab one after the other, each under its title as a heading; `update` rewrites the document as a single tab.
- Consecutive blockquotes merge into one, and nested checklist items become plain text.
- An escaped pipe in a table cell (`a \| b`) comes back unescaped, which drops the rest of the cell on the next `update`.
- `get` returns images as embedded base64 data, which makes the Markdown large.
