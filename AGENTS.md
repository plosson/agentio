# agentio — repository guide

## What this is

A CLI that gives LLM agents access to communication, productivity and tracking
services — Gmail, Google Drive/Docs/Calendar, Slack, Telegram, JIRA, GitHub,
Dropbox, Revolut, SQL and more — as plain commands that pipe and script.

Three ideas hold it together:

- **Profiles.** Every service supports multiple named accounts.
- **One encrypted vault.** All configuration and credentials live in a single
  passphrase-encrypted file, so they travel between machines as one artifact.
- **A daemon.** A long-lived HTTP process serves credentials to remote agents
  that have no vault of their own, and hosts the admin UI.

Bun and TypeScript throughout, with Commander.js for the CLI.

## Running and building

| Command | What it does |
| --- | --- |
| `bun run dev [args]` | Run the CLI from source |
| `bun run typecheck` | `tsc --noEmit` over both source and tests |
| `bun test` | Run the test suite |
| `bun run build` | JS bundle to `dist/index.js` |
| `bun run build:native` | Single-file native executable |
| `bun run build:site` | Build the static site |

The bundle targets `bun`, not node — the code uses Bun-native APIs (`Bun.serve`,
`Bun.spawn`, `SQL` from `bun`), so a node target will not run.

## Command reference

Don't transcribe the command list into documentation; it is generated and
always current:

- `agentio --help` and `agentio <service> --help`
- `agentio docs [--format markdown|json]` — the full reference, written for LLMs

## Source layout

| Path | Contents |
| --- | --- |
| `src/index.ts`, `src/cli.ts` | Entry point and program assembly |
| `src/plugins/<service>/` | One folder per service; Google services nest under `src/plugins/google/` |
| `src/plugins/registry.ts` | The catalog every service plugin registers through |
| `src/commands/` | Commands that aren't a service: vault, key, daemon, status, login, doctor |
| `src/auth/`, `src/config/`, `src/vault/` | Credentials, profiles, encrypted storage |
| `src/daemon/` | HTTP daemon: health, credential API, admin UI |
| `src/utils/`, `src/types/` | Shared helpers and types |
| `tests/` | Mirrors the source tree |
| `docs/`, `site/`, `examples/`, `docker/` | Documentation, website, runnable examples, container image |
| `dist/` | Build output (generated) |

## Adding a service

Services are in-tree plugins. The contract a plugin implements and the
step-by-step for adding one are in `docs/service-plugins.md` — follow that
rather than a copy of it here.

## Conventions

- TypeScript, ES modules, 2-space indentation, semicolons. No formatter or
  linter is configured, so match the code around you.
- File names are lowercase and kebab-case.
- Throw `CliError(code, message, suggestion)` for anything a user will see.
- Results go to stdout in a form an LLM can read; progress and errors to stderr.
  Formatting helpers live next to each plugin.

## Testing

- `bun test`. Tests live under `tests/`, mirroring `src/`.
- Point `HOME` at a `mkdtemp` directory in any test that touches the vault. The
  suite refuses vault writes outside the OS temp directory, which is what keeps
  a test run from reaching a real vault.

## Commits and pull requests

- Conventional Commits: `feat:`, `fix:`, `chore:`, `refactor:`.
- PRs carry a brief summary and rationale, linked issues, updated docs or
  examples when behaviour changes, and usage examples for new commands.

## Secrets

Never commit vault files, exported configs, or tokens. A vault export is
encrypted but is still a secret.
