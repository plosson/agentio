---
name: Dropbox
slug: dropbox
auth: OAuth (PKCE)
tagline: Browse, search, transfer, and share files across your whole Dropbox.
icon: 📦
order: 125
---

## What you can do

- List and search folders, by file name or by content
- Download files, or whole folders as a zip
- Upload files, with a chunked upload above 150 MB
- Create folders, and move, copy, rename or delete files
- Create shared links, permanent or temporary

## Setup

Register your own app in the Dropbox App Console as **Scoped access / Full Dropbox**. Enable these permissions: `account_info.read`, `files.metadata.read`, `files.content.read`, `files.content.write`, `sharing.read` and `sharing.write`. Then run:

```sh
agentio dropbox profile add --app-key <key>
```

You don't need a redirect URI. Dropbox shows the authorisation code in the browser, and you paste it into the terminal, so this also works over SSH.
