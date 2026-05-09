# gscript — Google Apps Script Command Design

**Date:** 2026-05-09
**Status:** Approved

## Overview

Add a `gscript` command to agentio CLI following the same pattern as `gdocs`, `gsheets`, and `gslides`. The command provides programmatic management of Google Apps Script projects via the Apps Script API (`script.googleapis.com`), with a primary use case of attaching scripting to an existing Google Sheet.

Scope is intentionally minimal for v1: create/inspect/edit script projects and round-trip script files between local disk and the API. Versions, deployments, and `scripts.run` are explicitly out of scope.

## Architecture

Same seven-file pattern as every other Google service:

| File | Purpose |
|------|---------|
| `src/types/gscript.ts` | TypeScript interfaces (credentials, project, file) |
| `src/services/gscript/client.ts` | `GScriptClient` class |
| `src/commands/gscript.ts` | `registerGScriptCommands()` |
| `src/utils/output.ts` | Output formatter additions |
| `src/auth/oauth.ts` | `GSCRIPT_SCOPES` + `saveGScriptTokens()` |
| `src/types/config.ts` | `gscript` added to `ServiceName` |
| `src/index.ts` | `registerGScriptCommands` import + call |
| `src/commands/status.ts` | gscript credential check |

No new npm dependencies — `googleapis` already in deps and exposes `google.script({version:'v1', auth})`.

## Commands

### Project lifecycle

#### `gscript create --title <title> [--parent <containerId>] [--profile <name>]`
Create a script project. Without `--parent`: standalone script in Drive root. With `--parent`: container-bound to the given Spreadsheet/Doc/Form/Slides ID. Calls `script.projects.create({ title, parentId })`. Prints `scriptId`, `title`, `parentId`, `createTime`, and the script editor URL.

#### `gscript metadata <id>`
Calls `script.projects.get`. Prints `scriptId`, `title`, `parentId`, `createTime`, `updateTime`, owner email, last-modify user.

#### `gscript list [--parent <containerId>] [--limit N]`
List script projects via Drive API (`mimeType='application/vnd.google-apps.script'`). Without `--parent`: lists all script projects accessible to the profile. With `--parent`: lists script projects bound to the given container — useful for finding the script attached to a specific Sheet. Default limit: 25.

#### `gscript delete <id>`
Deletes the script project via Drive `files.delete` (the Apps Script API has no delete endpoint). Asks for confirmation unless `--force` is passed.

### File round-trip

#### `gscript pull <id> [dir]`
Calls `script.projects.getContent`. Writes each file to `dir` (default cwd) using clasp's filename convention:

| API `type` | Local extension |
|------------|-----------------|
| `SERVER_JS` | `.gs` |
| `JSON` | `.json` (always exactly one, named `appsscript`) |
| `HTML` | `.html` |

Also writes `.clasp.json`:
```json
{ "scriptId": "<id>", "rootDir": "." }
```

If `dir` already contains a `.clasp.json` with a *different* `scriptId`, refuse unless `--force`.

#### `gscript push [dir] [--id <id>]`
Reads `.clasp.json` from `dir` (default cwd) to resolve `scriptId`, unless `--id` is given. Reads all `.gs`, `.json`, `.html` files under `rootDir`, packages them into the API's `files[]` shape (inverse of the table above), and calls `script.projects.updateContent`.

Fails fast if `appsscript.json` is missing — the API requires it.

### Single-file ops

#### `gscript get <id> <file>`
Calls `getContent`, finds the file by name, prints its `source` to stdout. The `<file>` argument accepts either the bare API name (`Code`) or the local filename with extension (`Code.gs`); extensions are stripped before matching. Errors with `NOT_FOUND` if no file matches.

#### `gscript put <id> <file> --source <text> | --from <path> | -`
Replaces or adds one file. Fetches existing content via `getContent`, replaces or appends the named file, writes back via `updateContent`. The `-` form reads from stdin. The `<file>` argument accepts either a bare API name (`Code`) or a filename with extension (`Code.gs`). Type inference, in order:

1. If an entry with the same bare name exists in the project, reuse its `type` (extension on the argument is ignored).
2. Else, infer from the argument's extension: `.gs` → `SERVER_JS`, `.html` → `HTML`, `.json` (only the bare name `appsscript` is allowed) → `JSON`.
3. Else (no existing entry, no extension), default to `SERVER_JS`.

### Profile

#### `gscript profile add|list|remove`
Standard OAuth profile management. `add` triggers the OAuth flow and stores credentials under the profile name (defaulting to the account email, like every other Google service).

## Client Methods (`GScriptClient`)

| Method | API call(s) |
|--------|------------|
| `validate()` | `drive.files.list` with `mimeType='application/vnd.google-apps.script'`, `pageSize: 1` — same pattern as `GSlidesClient.validate()` |
| `createProject({ title, parentId? })` | `script.projects.create` |
| `getProject(scriptId)` | `script.projects.get` |
| `listProjects({ parentId?, limit })` | `drive.files.list` with `mimeType='application/vnd.google-apps.script'` (+ optional `'<parentId>' in parents`) |
| `deleteProject(scriptId)` | `drive.files.delete` |
| `getContent(scriptId)` | `script.projects.getContent` |
| `updateContent(scriptId, files)` | `script.projects.updateContent` |

## Auth & Scopes

New scope set in `src/auth/oauth.ts`:

```ts
const GSCRIPT_SCOPES = [
  'https://www.googleapis.com/auth/script.projects',  // create/read/update Apps Script projects
  'https://www.googleapis.com/auth/drive',            // list scripts by container, delete scripts
  'https://www.googleapis.com/auth/userinfo.email',   // profile naming
];
```

`drive` (full) rather than `drive.readonly` because `delete` mutates Drive. New `saveGScriptTokens()` helper following the pattern of `saveGDocsTokens()`.

## File-type round-trip rules

The API's `File` shape is `{ name, type, source }` where `name` has no extension and `type` ∈ {`SERVER_JS`, `JSON`, `HTML`}. Locally we store with extensions for editor ergonomics. The mapping is:

```
API: { name: "Code",        type: "SERVER_JS" }  ↔  local: Code.gs
API: { name: "appsscript",  type: "JSON" }       ↔  local: appsscript.json
API: { name: "Sidebar",     type: "HTML" }       ↔  local: Sidebar.html
```

`pull` writes; `push` reads. Subdirectories under `rootDir` are not supported in v1 (Apps Script projects are flat). Hidden files (leading `.`) and `.clasp.json` itself are skipped on push.

## Error Handling

Use `CliError` codes already in use across the codebase:

| Condition | Code | Message intent |
|-----------|------|----------------|
| Missing/invalid token | `AUTH_FAILED` | "Run `agentio gscript profile add`" |
| Profile not found | `PROFILE_NOT_FOUND` | inherited from common helper |
| Script id not found | `NOT_FOUND` | API 404 from `projects.get` |
| `--parent` not a valid container | `INVALID_PARAMS` | API 400 from `projects.create` |
| File not found in `get`/`put` | `NOT_FOUND` | "no file named `<name>` in script `<id>`" |
| `push` with no `appsscript.json` | `INVALID_PARAMS` | "Apps Script API requires an appsscript.json manifest" |
| `pull` over a different scriptId without `--force` | `INVALID_PARAMS` | suggest `--force` or a different dir |
| Generic API failure | `API_ERROR` | passthrough |

## Output Conventions

Same as gdocs/gsheets — human-readable lines, no JSON-only mode in v1. New formatters in `src/utils/output.ts`:

- `formatGScriptProject(project)` — multi-line: id, title, parent, timestamps, editor URL
- `formatGScriptList(projects)` — one line per project: `<scriptId>  <title>  [bound to <parentId>]`
- `formatGScriptFiles(files)` — used by `pull` and `push` to confirm what was written/uploaded

## Status Command

`agentio status` calls `GScriptClient.validate()` (the `drive.files.list` path described above). A 200 with any result count confirms auth.

## Skill

Per the project's "Adding a New Service" checklist, ship `claude/skills/gscript/SKILL.md` mirroring the existing `gsheets`/`gdocs` skill format so Claude Code users discover the commands.

## Out of scope (v1)

- `scripts.run` (function execution) — requires user-managed GCP project; defer.
- `versions` and `deployments` subcommands — only useful for web-app deployments and `run`; no need for the bound-script use case.
- Library management (script project dependencies on other scripts).
- Trigger management — Apps Script API does not expose installable triggers; out of reach.
- Subdirectories under `rootDir` in pull/push — Apps Script projects are flat.
- JSON output mode — match the rest of the CLI.

## Test Plan

- `gscript profile add` — OAuth flow stores credentials under profile email.
- `gscript create --title TestStandalone` — creates standalone, returns scriptId.
- `gscript create --title TestBound --parent <a-test-spreadsheet-id>` — creates bound script.
- `gscript metadata <scriptId>` — prints metadata.
- `gscript list` — shows both projects.
- `gscript list --parent <spreadsheetId>` — shows only the bound one.
- `gscript pull <scriptId> /tmp/test-script` — writes `Code.gs`, `appsscript.json`, `.clasp.json`.
- Edit `Code.gs` locally; `gscript push /tmp/test-script` — uploads.
- `gscript get <scriptId> Code` — prints updated source.
- `echo "function x(){}" | gscript put <scriptId> Helper -` — adds new file.
- `gscript delete <scriptId> --force` — cleans up.
- `agentio status` — gscript shows green for the profile.
