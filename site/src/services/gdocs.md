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

## Editing from Markdown

```sh
agentio gdocs get 1A2bCdEf... --output doc.md
# edit doc.md
agentio gdocs update 1A2bCdEf... --file doc.md
```

`update` replaces the whole document. To change one part without touching the rest, read the indices with `structure` and send requests with `batch`.

## Markdown fidelity

Google converts the Markdown in both directions: agentio does not. What comes through:

- Headings (H1 to H6), bold, italic, strikethrough, inline code, links
- Bullet and numbered lists, nested lists
- Tables, code blocks, blockquotes, horizontal rules

What is lost on the Markdown path:

- Comments and suggestions
- Headers, footers and footnotes
- Smart chips and drawings
- Exact fonts and colours
- Tabs: `get` exports every tab one after the other, each under its title as a heading, and `update` rewrites the document as a single tab. `update` refuses a document with several tabs unless you add `--force`.
