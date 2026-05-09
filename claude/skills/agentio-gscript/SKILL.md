---
name: agentio-gscript
description: Use when interacting with gscript via the agentio CLI.
---

# Gscript via agentio

Auto-generated from `agentio skill gscript`. Do not edit by hand.

## agentio gscript create

Create a new Apps Script project (standalone or container-bound)

Options:

- `--title <title>`: Script project title
- `--parent <containerId>`: Bind to a Sheet/Doc/Form/Slides ID (omit for standalone)
- `--profile <name>`: Profile name

```
Examples:

  # standalone script
  agentio gscript create --title "Helper Library"

  # bound to a Sheet
  agentio gscript create --title "Sheet automation" --parent 1A2bCdEfGhIjKlMnOpQrStUvWxYz0123456789

  # bound to a Doc, with explicit profile
  agentio gscript create --title "Doc tools" --parent 1Doc... --profile work@example.com

The --parent ID is the container's Drive file ID (Sheet/Doc/Form/Slides).
```

## agentio gscript metadata <id>

Get script project metadata

Options:

- `--profile <name>`: Profile name

```
Examples:

  # show title, owner, timestamps, parent, editor URL
  agentio gscript metadata 1abc...XYZ
```

## agentio gscript list

List script projects (optionally filtered to a container)

Options:

- `--parent <containerId>`: Only list scripts bound to this container
- `--limit <n>`: Max results (default: 25)
- `--profile <name>`: Profile name

```
Examples:

  # all script projects
  agentio gscript list

  # script bound to a specific Sheet
  agentio gscript list --parent 1Sheet...

  # standalone scripts (no container) — list and inspect parentId field
  agentio gscript list --limit 100
```

## agentio gscript delete <id>

Delete a script project (moves to Drive trash)

Options:

- `--force`: Skip confirmation
- `--profile <name>`: Profile name

```
Examples:

  # confirm + delete
  agentio gscript delete 1abc...XYZ --force
```

## agentio gscript pull <id> [dir]

Download all script files to a local directory (writes .clasp.json)

Options:

- `--force`: Overwrite a directory whose .clasp.json points to a different scriptId
- `--profile <name>`: Profile name

```
Examples:

  # pull into the current directory
  agentio gscript pull 1abc...XYZ

  # pull into a fresh folder
  agentio gscript pull 1abc...XYZ ./my-script

  # overwrite a directory pointing to a different script
  agentio gscript pull 1abc...XYZ ./my-script --force

Writes Code.gs, appsscript.json, *.html files, plus .clasp.json with the scriptId.
```

## agentio gscript push [dir]

Upload all .gs/.html/appsscript.json files in a directory

Options:

- `--id <scriptId>`: Override scriptId from .clasp.json
- `--profile <name>`: Profile name

```
Examples:

  # push current directory (uses .clasp.json)
  agentio gscript push

  # push a specific directory
  agentio gscript push ./my-script

  # push to a script id that's not in .clasp.json
  agentio gscript push ./my-script --id 1abc...XYZ

Hidden files and .clasp.json are skipped. The push fails if appsscript.json is missing.
```

## agentio gscript get <id> <file>

Print one script file to stdout

Options:

- `--profile <name>`: Profile name

```
Examples:

  # print Code.gs to stdout
  agentio gscript get 1abc...XYZ Code

  # bare name and full filename both work
  agentio gscript get 1abc...XYZ Code.gs

  # the JSON manifest
  agentio gscript get 1abc...XYZ appsscript
```

## agentio gscript put <id> <file>

Replace or add a single script file (--source, --from <path>, or - for stdin)

Options:

- `--source <text>`: Inline content
- `--from <path>`: Read content from a local file
- `--profile <name>`: Profile name

```
Examples:

  # inline content
  agentio gscript put 1abc...XYZ Code --source 'function doIt(){}'

  # from a local file
  agentio gscript put 1abc...XYZ Code.gs --from ./Code.gs

  # from stdin
  echo 'function doIt(){}' | agentio gscript put 1abc...XYZ Code

  # add a new helper
  agentio gscript put 1abc...XYZ Helpers --source '// helpers go here'

Type inference: extension on the file argument decides the API type
(.gs=SERVER_JS, .html=HTML, .json=JSON-only-for-appsscript). If the
file already exists in the project, its existing type is reused.
```
