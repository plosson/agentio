# Repository Guidelines

## Project Structure & Module Organization
- `src/` contains the TypeScript CLI implementation. Entry point is `src/index.ts`.
- `src/commands/` holds subcommand registrations (e.g., `gmail`, `slack`, `jira`).
- `src/services/`, `src/auth/`, `src/config/`, `src/gateway/`, `src/utils/`, and `src/types/` group supporting logic by concern.
- `examples/` provides runnable workflow examples for CI/CD usage.
- `docs/` and `site/` contain documentation and website assets.
- `dist/` is build output (generated).

## Build, Test, and Development Commands
- `bun run src/index.ts`: run the CLI locally in dev mode.
- `bun build src/index.ts --outdir dist --target node`: build the JS bundle to `dist/`.
- `bun build src/index.ts --compile ... --outfile dist/agentio`: build the native binary (see `package.json` script `build:native`).
- `bun run typecheck`: run `tsc --noEmit` with strict settings.

## Coding Style & Naming Conventions
- TypeScript, ES modules (`"type": "module"`). Use `import`/`export`.
- Follow existing formatting: 2-space indentation, semicolons, and alphabetical grouping for service registrations (see `src/index.ts`).
- File naming is lowercase and kebab/short names by feature (e.g., `gmail.ts`, `gdrive.ts`).
- No formatter/linter is configured; keep edits consistent with nearby code.

## Testing Guidelines
- There is no automated test suite in this repo today.
- Use `bun run typecheck` to validate types.
- If you add tests, place them near sources (e.g., `src/**/__tests__/`) and document how to run them in `package.json`.

## Commit & Pull Request Guidelines
- Commit messages follow Conventional Commits: `feat:`, `fix:`, `chore:`, `refactor:` (see recent history).
- PRs should include:
  - A brief summary and rationale.
  - Linked issues (if any).
  - Updated docs/examples when behavior changes.
  - CLI usage examples when adding commands.

## Security & Configuration Tips
- Configuration exports are encrypted and treated as secrets. Do not commit `agentio.config` or keys.
- For workflow changes, reference `examples/` and keep secrets limited to required profiles.
