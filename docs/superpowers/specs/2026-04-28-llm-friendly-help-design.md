# LLM-Friendly `--help` Design

**Date:** 2026-04-28
**Status:** Draft — pending user review

## Goal

Make every `agentio` command's `--help` output self-sufficient for an LLM agent: a single `agentio <cmd> --help` call should give the agent enough information — including 2–4 realistic invocation examples — to use the command correctly on the next try, without any prior training or external skill file.

The same per-command examples are also the single source of truth for the `claude/skills/agentio-<service>/SKILL.md` files, which are regenerated from the command tree by a new `agentio skill <service>` command. No example string is ever written in two places.

## Motivation

Agents reach for `--help` reflexively — it is the universal CLI affordance. Today, `agentio gmail send --help` lists flags but no example invocations, so an agent that has never seen `agentio` before cannot reliably guess that `--reply-to` takes a thread id and not a message id, or that `--inline` uses `cid:path` syntax. The hand-written SKILL.md files in `claude/skills/agentio-<service>/` cover this well, but only six services have them, and they are invisible to any agent that does not already know skills exist.

Consolidating examples into per-command help text fixes both problems with one source of truth.

## Non-goals

- Cross-command tutorials or narrative prose in `--help`. A "see also" pointer to another command's help is the only inter-command reference allowed.
- Auto-generated examples (e.g. by inspecting flag types). Examples are hand-written, because realistic values matter — `--query "from:boss is:unread"` is useful, `--query <string>` is not.
- Backwards-compatibility for the existing hand-written SKILL.md files. They are regenerated and committed; the previous prose is lost where it cannot be expressed as per-command examples.
- Localisation of `--help` text. English only.

## Design

### Source of truth: `.addHelpText('after', ...)` per leaf command

Every leaf command (anything with an `.action()`) gains an `.addHelpText('after', ...)` block containing 2–4 realistic example invocations. The format is fixed:

```
Examples:

  # Short intent description
  agentio gmail send --to alice@example.com --subject "Hi" --body "Hello"

  # Reply to a thread (find the id with: agentio gmail search --help)
  agentio gmail send --reply-to 18c4f1a2b3d --body "Thanks"

  # Inline image in HTML body
  agentio gmail send --to alice@example.com --subject "Chart" --html \
    --body '<p>See:</p><img src="cid:c1">' --inline c1:./chart.png
```

Rules:

- Heading is always `Examples:` followed by a blank line.
- Each example is a one-line `#` intent comment followed by the invocation.
- Examples use realistic placeholder values (`alice@example.com`, not `<email>`).
- Multi-line invocations use trailing `\` for shell continuation.
- Cross-command pointers — when a flag value comes from another command's output — go in the intent comment as `(find the id with: agentio <cmd> --help)`. No prose paragraphs.

The existing `gmail search` command already follows the spirit of this (its `addHelpText` lists query-syntax variants); that block becomes the model for the rest.

### Top-level pointer

`agentio --help` gains a one-line footer:

```
For agent/LLM usage: run `agentio skill <service>` to dump a full SKILL.md, or `agentio docs` for the machine-readable command index.
```

Individual command `--help` outputs do **not** include this pointer — keeping the per-command footer to just the `Examples:` block.

### New command: `agentio skill <service>`

A new top-level command (registered with `{ hidden: true }`, like `docs`) that walks the Commander tree for one service and emits a complete SKILL.md to stdout, ready to drop into `claude/skills/agentio-<service>/SKILL.md`.

```bash
agentio skill gmail              # → SKILL.md content for gmail
agentio skill gmail > claude/skills/agentio-gmail/SKILL.md
agentio skill --all              # write all services' SKILL.md files in place
agentio skill --list             # list services that have any commands
```

The generator:

1. Walks the same Commander tree as `agentio docs`, scoped to one service.
2. For each leaf command, emits a section with: heading (`## agentio gmail send`), description, `Options:` block, and the verbatim `Examples:` block extracted from `.addHelpText('after', ...)`.
3. Prepends a fixed two-line frontmatter block:
   ```
   ---
   name: agentio-<service>
   description: Use when interacting with <service> via the agentio CLI. Auto-generated from `agentio skill <service>`.
   ---
   ```
4. Does not include any hand-written prose. The per-service `description` field is fetched from a small lookup table in `src/commands/skill.ts` (one line per service) — the only place hand-written service-level prose lives.

### Where examples live in code

Examples live next to the `.command(...)` chain that defines them. For services whose flags are shared across multiple commands (gmail's `addComposeOptions` adds the same flags to both `send` and `draft`), each command still gets its own `.addHelpText('after', ...)` — a `send` example and a `draft` example are different in intent even when they share flags.

### Existing SKILL.md files

The six existing files (`agentio-gmail`, `agentio-telegram`, `agentio-jira`, `agentio-gchat`, `agentio-rss`, `agentio-schedule`) are regenerated by `agentio skill --all` and committed in the same change. Any prose they contained that does not survive the round-trip (e.g. multi-paragraph workflow narratives) is recast as either:

- A multi-flag example in the relevant command's `--help`, or
- A short comment in an example's intent line (`# combines --html + --inline`).

If a section truly cannot be expressed as a per-command example, it is dropped. This keeps the "no duplication" invariant ironclad.

### Build/CI gate

A new test (`src/commands/help-examples.test.ts`) walks the Commander tree and asserts that every leaf command (anything with an `.action()`) has a non-empty `.addHelpText('after', ...)` block whose first non-blank line is `Examples:`.

Exemptions:

- `profile add | list | remove` subcommands — mechanical and identical across services.
- Hidden commands (`{ hidden: true }`): `claude`, `docs`, and the new `skill` command itself. These are internal/meta and not surfaced to agents.

The test produces a list of offenders so a single CI failure tells the author exactly which commands still need examples.

## Components

### `src/commands/skill.ts` (new)

- `registerSkillCommand(program: Command)` — registers `agentio skill`.
- Subcommands: bare `<service>`, `--all`, `--list`.
- A `SERVICE_DESCRIPTIONS: Record<string, string>` constant — one line per service, used for SKILL.md frontmatter.
- Reuses `collectCommands()` from `docs.ts` (extracted into a shared helper if needed).

### `src/commands/docs.ts` (modified)

- Extract the `collectCommands()` function into `src/utils/command-tree.ts` so both `docs` and `skill` use it.
- Extend `CommandInfo` to include the raw `addHelpText` block (Commander exposes this via `cmd._helpText` or by calling `cmd.helpInformation()` and slicing — verify during implementation).

### `src/commands/help-examples.test.ts` (new)

- Single test: walks the tree, collects leaf commands lacking the required `Examples:` block, asserts the list is empty.
- Failure message lists the offending command paths.

### Per-service command files (modified)

Every leaf command in:

- `src/commands/gmail.ts`, `gdocs.ts`, `gdrive.ts`, `telegram.ts`, `gchat.ts`, `github.ts`, `jira.ts`, `slack.ts`, `rss.ts`, `discourse.ts`, `sql.ts`, `whatsapp.ts`, `daemon.ts`, `schedule.ts`, `gateway.ts`, `config.ts`, `status.ts`, `update.ts`, `setup.ts`, `doctor.ts`, `mcp.ts`, `server.ts`, `gcal.ts`, `gsheets.ts`, `gtasks.ts`, `reauth.ts`, `profile.ts`

…gains an `.addHelpText('after', ...)` block for each leaf command (excluding the standard `profile add|list|remove` triplet).

This is the bulk of the change by line count, but each addition is mechanical: read the existing SKILL.md (where it exists) for inspiration, write 2–4 examples, paste in.

### `claude/skills/agentio-<service>/SKILL.md` (regenerated)

Six existing files are overwritten by `agentio skill --all`. New files are produced for every service that previously lacked one. The generator output is committed.

## Data flow

```
                 ┌────────────────────────────────────────────────┐
                 │  src/commands/<service>.ts                     │
                 │    .command(...).addHelpText('after', `...`)   │
                 └────────────────────┬───────────────────────────┘
                                      │ (single source of truth)
                ┌─────────────────────┼─────────────────────┐
                │                     │                     │
                ▼                     ▼                     ▼
   `agentio <cmd> --help`    `agentio skill <s>`     `agentio docs`
   (Commander built-in)      (new command)           (existing, unchanged)
                                      │
                                      ▼
                 claude/skills/agentio-<service>/SKILL.md
                       (regenerated, committed)
```

## Testing

- `help-examples.test.ts` — gates that every leaf command has examples.
- A second test in `help-examples.test.ts` runs `agentio skill --list` and asserts the output is non-empty and matches the set of services with examples.
- Manual spot-check: `agentio gmail send --help` shows examples; `agentio skill gmail` produces a SKILL.md identical to the committed file (modulo trailing newline). The latter check could be a snapshot test, but is not required.

## Open questions

None — design is settled.

## Out of scope (explicit)

- A `--examples-only` flag on the existing `agentio docs` command. If asked for later, it is a small addition; not in this spec.
- Embedding skills into the binary at build time. Skills live as files on disk in `claude/skills/`; the runtime never reads them.
- Translating examples to PowerShell / cmd.exe syntax for Windows. Bash only.
