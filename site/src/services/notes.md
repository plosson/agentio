---
name: Apple Notes
slug: notes
auth: API Key
tagline: Read, search and write Apple Notes on your Mac from anywhere.
icon: 🗒️
order: 87
---

## What you can do

- List folders and notes, and search note titles and text
- Read a note as Markdown, plain text or HTML
- Create notes from Markdown, HTML or text, from a file or a pipe
- Rename a note, replace its body, move it to another folder, or delete it

## Setup

Run [apple-notes-api](https://github.com/plosson/apple-notes-api) on the Mac that has Notes, then:

```sh
agentio notes profile add --url https://mac-mini.example.ts.net
```

agentio asks for the API key the server printed when it was installed.

## Good to know

- Note ids look like `x-coredata://…`. Quote them in the shell.
- `update --body` replaces the whole body. Read the note first if you want to keep any of it.
- `delete` moves the note to Recently Deleted, where Notes keeps it for 30 days.
- A folder is found by its name, so two accounts with a folder of the same name are ambiguous.
- Locked notes cannot be read or changed.
