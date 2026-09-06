---
name: agentio-dropbox
description: Use when interacting with Dropbox via the agentio CLI - list, search, download, upload, move, copy, delete, share links.
---

# Dropbox via agentio

Auto-generated from `agentio skill dropbox`. Do not edit by hand.

## agentio dropbox list [path]

List a folder

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--limit <n>`: Maximum entries to return (default: 100)
- `--recursive`: Include everything below the folder
- `--folders`: Only show folders

```
Examples:

  # everything at the top level of the account
  agentio dropbox list

  # one folder
  agentio dropbox list /Documents

  # the whole tree below a folder
  agentio dropbox list /Documents --recursive --limit 500

  # only the subfolders
  agentio dropbox list /Documents --folders

Paths are absolute and start at the Dropbox root, e.g. "/Documents/report.pdf".
Casing is preserved but matching is case-insensitive.
```

## agentio dropbox get <path>

Get metadata for a file or folder

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)

```
Examples:

  # size, revision and modification time of a file
  agentio dropbox get /Documents/report.pdf

  # confirm a folder exists
  agentio dropbox get /Documents
```

## agentio dropbox search

Search for files and folders

Options:

- `--query <text>`: Search text
- `--profile <name>`: Profile name (optional if only one profile exists)
- `--path <path>`: Restrict the search to a folder
- `--limit <n>`: Maximum results to return (default: 20)
- `--filename-only`: Match names only, not file contents

```
Examples:

  # search names and contents across the account
  agentio dropbox search --query "quarterly report"

  # search inside one folder
  agentio dropbox search --query invoice --path /Accounting

  # match file names only
  agentio dropbox search --query 2026 --filename-only --limit 50

Newly uploaded files can take a few minutes to become searchable.
```

## agentio dropbox download <path>

Download a file, or a folder as a zip archive

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--output <path>`: Local output path (default: the remote name)

```
Examples:

  # download a file next to the current directory
  agentio dropbox download /Documents/report.pdf

  # download to a chosen path
  agentio dropbox download /Documents/report.pdf --output ~/Desktop/report.pdf

  # download a whole folder (arrives as Documents.zip)
  agentio dropbox download /Documents

  # download a folder to a named archive
  agentio dropbox download /Photos/2026 --output ./photos-2026.zip

Folder downloads are capped by Dropbox at 20 GB and 10,000 files.
```

## agentio dropbox put <file-path>

Upload a file

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--path <path>`: Destination path or folder (default: account root)
- `--overwrite`: Replace an existing file at the destination

```
Examples:

  # upload to the account root, keeping the local name
  agentio dropbox put ./report.pdf

  # upload into a folder (trailing slash keeps the local name)
  agentio dropbox put ./report.pdf --path /Documents/

  # upload under a different name
  agentio dropbox put ./out.csv --path /Reports/2026-results.csv

  # update a file that already exists
  agentio dropbox put ./report.pdf --path /Documents/report.pdf --overwrite

Without --overwrite an existing destination is an error, never a silent replace.
Files above 150 MB are uploaded in 8 MB chunks automatically.
```

## agentio dropbox mkdir <path>

Create a folder

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)

```
Examples:

  # create a folder at the root
  agentio dropbox mkdir /Reports

  # create a nested folder (parents are created as needed)
  agentio dropbox mkdir /Reports/2026/Q1
```

## agentio dropbox move <from> <to>

Move or rename a file or folder

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)

```
Examples:

  # rename a file in place
  agentio dropbox move /Documents/draft.pdf /Documents/final.pdf

  # move a file to another folder
  agentio dropbox move /Inbox/scan.pdf /Documents/scan.pdf

  # move a whole folder
  agentio dropbox move /Inbox/2025 /Archive/2025
```

## agentio dropbox copy <from> <to>

Copy a file or folder

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)

```
Examples:

  # copy a file
  agentio dropbox copy /Documents/report.pdf /Archive/report-2026.pdf

  # copy a folder and everything in it
  agentio dropbox copy /Templates /Projects/new-client
```

## agentio dropbox delete <path>

Delete a file or folder (recoverable from the Dropbox trash)

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--force`: Skip the confirmation prompt

```
Examples:

  # delete a file with a confirmation prompt
  agentio dropbox delete /Documents/old.pdf

  # delete without prompting
  agentio dropbox delete /Documents/old.pdf --force

  # delete a folder and all of its contents
  agentio dropbox delete /Archive/2019 --force

Deleted items go to the Dropbox trash and stay recoverable for 30 days
(180 days on business plans).
```

## agentio dropbox link <path>

Get a shareable link

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--temporary`: Direct download URL that expires in 4 hours (files only)

```
Examples:

  # permanent share link (reuses the existing one if there is one)
  agentio dropbox link /Documents/report.pdf

  # share a folder
  agentio dropbox link /Photos/2026

  # direct download URL for a script to fetch, valid 4 hours
  agentio dropbox link /Documents/report.pdf --temporary
```

## agentio dropbox account

Show the connected Dropbox account

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)

```
Examples:

  # which account this profile is connected to
  agentio dropbox account
```

