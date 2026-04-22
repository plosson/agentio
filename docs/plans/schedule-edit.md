# `agentio schedule edit` — Design

## Goal

Add an `edit` subcommand to `agentio schedule` that lets the user interactively modify an existing schedule's frontmatter settings, while also accepting every flag `schedule add` supports.

## Command shape

```
agentio schedule edit <id> [flags]
```

- `<id>`: schedule id, resolved by walking `--folder` for `<id>.run.md` (same resolution as `show`/`remove`/`run`/`runs`).
- Errors if the file is missing or multiple files match the id.

### Flags

All flags supported by `schedule add`:

- `--folder <path>` (default: CWD)
- `--schedule <type>` — `manual | daily | weekly | monthly | interval`
- `--at <HH:MM>`, `--hour <n>`, `--minute <n>`
- `--weekdays <list>`
- `--day <n>`
- `--interval <dur>`
- `--model <opus|sonnet|haiku>`
- `--permission-mode <default|bypass|plan|accept-edits>`
- `--session-mode <new|resume|fork>`
- `--command <cmd>`
- `--host <name>`
- `--disabled`
- `-y, --yes`

Plus one new flag for symmetry:

- `--enable` — sets `enabled: true`. Mutually exclusive with `--disabled`.

## Behavior

1. Resolve the `.run.md` file for `<id>` under `--folder`.
2. Parse existing frontmatter → `currentConfig`.
3. Derive `flagsConfig` via `configFromFlags(opts)` (reused from `add`). `--enable` is a new flag; `configFromFlags` is extended to set `enabled: true` when present and to reject combining `--enable` with `--disabled`.
4. Merge: `merged = { ...currentConfig, ...flagsConfig }`. If `--schedule` was passed, replace the entire `schedule` object (same semantics as `add`); otherwise keep `currentConfig.schedule`.
5. **If `-y`:** validate that `merged.schedule` has all required fields (`missingScheduleFields`). If not, error. Otherwise skip to save.
6. **Otherwise, walk-through prompt** using `merged` values as defaults:
   1. `schedule.type` — select (current type as default).
   2. Type-specific fields for the chosen type (prompt each one, using merged values as defaults; fields not needed for the chosen type are dropped from the Schedule object):
      - `manual`: none
      - `daily`: `hour`, `minute` (single `HH:MM` prompt)
      - `weekly`: `weekdays`, `hour`, `minute`
      - `monthly`: `day`, `hour`, `minute`
      - `interval`: `intervalMinutes` (duration prompt)
   3. `model` — select.
   4. `permissionMode` — select.
   5. `sessionMode` — select.
   6. `command` — input (empty string clears the override).
   7. `host` — input (empty string clears host pinning).
   8. `enabled` — confirm (y/n).
7. Build final `FrontmatterConfig` via `mergeConfig({}, merged)`.
8. Write the frontmatter back to the file, preserving the existing body.
9. Post-write (identical to `add`):
   - If `hostMatches(finalConfig)` → `installPlist(folder, id, finalConfig)`, print "Updated schedule …".
   - Else → `uninstallPlist(folder, id)`, print host-pinning note.

### Type-change handling

When the user changes `schedule.type` in the walk-through, irrelevant fields from the old type are dropped in the resulting Schedule object (e.g. switching `weekly` → `daily` drops `weekdays`). Hour/minute carry over across any types that use them.

## Code reuse

Extract the existing `promptMissing(partial, missing)` helper into a broader helper usable by `edit`:

```ts
promptSchedule(partial, { fields }): Promise<Partial<FrontmatterConfig>>
```

Where `fields` is the set of fields to prompt. For `add`/`sync`, `fields` is the current `missing` list (behavior unchanged). For `edit`, `fields` is the full editable set.

Model/permissionMode/sessionMode/command/host/enabled prompts are new — added to the same module.

## Output

- Success on this host: `Updated schedule "<id>" in <folder>`
- Host-pinned elsewhere: `Wrote "<id>" (pinned to host "<host>"; current host is "<current>"; plist not installed)`
- Validation error or unresolved id: `CliError` with clear suggestion.

## Testing

- Unit: new `promptSchedule` helper with `fields = all` — verify correct prompt ordering and type-specific branching (mock `@inquirer/prompts`). Existing `missing`-only tests keep passing.
- Integration (command-level): reuse existing schedule test patterns — create a `.run.md` file with a fixture, invoke `edit` with flags + `-y`, assert frontmatter and plist state.
- Edge cases:
  - Ambiguous id → error.
  - Missing file → error.
  - `--enable` + `--disabled` → error.
  - Type change from weekly → daily drops `weekdays`.
  - Host change from matching to non-matching → plist uninstalled.

## Out of scope

- No renaming of the schedule id (would require renaming the file — separate concern).
- No editing of the prompt body (user edits the markdown directly).
- No multi-id batch edit.
