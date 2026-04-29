# Gmail Filter Management

## Goal

Add filter CRUD to `agentio gmail`, exposing the Gmail API's `users.settings.filters` endpoints in a way that matches the rest of the gmail command set.

## Commands

```
agentio gmail filters list
agentio gmail filters get <id>
agentio gmail filters create [criterion flags...] [action flags...]
agentio gmail filters delete <id...>
```

`filters` is a subcommand group under `gmail`, structured the same way as `gmail labels`.

### `filters list`

Lists every filter on the account.

```
agentio gmail filters list [--profile <name>]
```

Output: one filter per row, showing id, a short criteria summary (e.g. `from:noreply@x.com subject:invoice`), and a short action summary (e.g. `+Receipts -INBOX`). Label IDs in the action are resolved to label names for display.

### `filters get`

```
agentio gmail filters get <id> [--profile <name>]
```

Output: full breakdown — id, every populated criterion field, every action field, with label IDs resolved to names.

### `filters create`

```
agentio gmail filters create [--profile <name>]
  # criteria (at least one required)
  [--from <email>]
  [--to <email>]
  [--subject <text>]
  [--query <q>]
  [--negated-query <q>]
  [--has-attachment]
  [--exclude-chats]
  [--size <bytes> --size-comparison larger|smaller]
  # actions (at least one required)
  [--apply <label>]...        # repeatable, accepts label name or ID
  [--remove <label>]...       # repeatable
  [--forward <email>]         # must be a verified forwarding address
```

Validation:
- At least one criterion flag must be set.
- At least one action flag must be set.
- `--size` and `--size-comparison` must be set together.

`--apply` / `--remove` accept label names or IDs and resolve via the existing `GmailClient.resolveLabelIds` helper.

Output: `Filter created: <id>` plus a one-line summary of what was created.

### `filters delete`

```
agentio gmail filters delete <id...> [--profile <name>]
```

Accepts one or more filter IDs as positional args (consistent with `gmail mark`). Each ID is deleted with a separate API call — there is no batch delete endpoint for filters. Prints `Filter deleted: <id>` per success. On per-ID failure, prints the error to stderr and continues with the remaining IDs; exits non-zero if any deletion failed.

## API Mapping

| Command | Endpoint |
|---|---|
| `filters list` | `GET users/me/settings/filters` |
| `filters get` | `GET users/me/settings/filters/{id}` |
| `filters create` | `POST users/me/settings/filters` |
| `filters delete` | `DELETE users/me/settings/filters/{id}` |

Filter resource shape (subset used here):

```ts
{
  id: string;
  criteria: {
    from?: string;
    to?: string;
    subject?: string;
    query?: string;
    negatedQuery?: string;
    hasAttachment?: boolean;
    excludeChats?: boolean;
    size?: number;
    sizeComparison?: 'larger' | 'smaller';
  };
  action: {
    addLabelIds?: string[];
    removeLabelIds?: string[];
    forward?: string;
  };
}
```

## OAuth Scope

Filter create and delete require `https://www.googleapis.com/auth/gmail.settings.basic`. List and get work with the existing `gmail.modify` scope.

This scope is added to `GMAIL_SCOPES` in `src/auth/oauth.ts`. Existing profiles will need to re-run `agentio gmail profile add` to gain create/delete capability; until they do, those commands will return the standard insufficient-scope API error wrapped as `CliError('API_ERROR', ...)`. No bespoke detection or re-auth prompt — it surfaces like any other Gmail API failure.

## Files Touched

| File | Change |
|---|---|
| `src/auth/oauth.ts` | Add `gmail.settings.basic` to `GMAIL_SCOPES` |
| `src/types/gmail.ts` | Add `GmailFilter`, `GmailFilterCriteria`, `GmailFilterAction`, `GmailFilterCreateOptions` |
| `src/services/gmail/client.ts` | Add `listFilters`, `getFilter`, `createFilter`, `deleteFilter` methods |
| `src/commands/gmail.ts` | Add `filters` subcommand group with `list`, `get`, `create`, `delete` actions |
| `src/utils/output.ts` | Add `printFilterList`, `printFilter`, `printFilterCreated`, `printFilterDeleted` |
| `claude/skills/gmail/SKILL.md` (if present) | Document new commands |
| `CLAUDE.md` | Add Gmail filter commands to the Gmail section of the commands reference |

## Type Definitions

```ts
// src/types/gmail.ts

export interface GmailFilterCriteria {
  from?: string;
  to?: string;
  subject?: string;
  query?: string;
  negatedQuery?: string;
  hasAttachment?: boolean;
  excludeChats?: boolean;
  size?: number;
  sizeComparison?: 'larger' | 'smaller';
}

export interface GmailFilterAction {
  addLabelIds?: string[];
  removeLabelIds?: string[];
  forward?: string;
}

export interface GmailFilter {
  id: string;
  criteria: GmailFilterCriteria;
  action: GmailFilterAction;
}

export interface GmailFilterCreateOptions {
  criteria: GmailFilterCriteria;
  action: GmailFilterAction;
}
```

## Client Methods

```ts
// src/services/gmail/client.ts

async listFilters(): Promise<GmailFilter[]>
async getFilter(id: string): Promise<GmailFilter>
async createFilter(options: GmailFilterCreateOptions): Promise<GmailFilter>
async deleteFilter(id: string): Promise<void>
```

All four wrap `this.gmail.users.settings.filters.*`. Errors map to `CliError`:
- 404 → `CliError('NOT_FOUND', 'Filter not found: <id>')` (using the existing `isNotFoundError` helper)
- everything else → `CliError('API_ERROR', 'Gmail API error: <message>')`

For `list` and `get` the client expands `addLabelIds` / `removeLabelIds` to label names for the output layer. The simplest way: the command layer calls `listLabels()` once and passes a `Map<id, name>` to the print functions. This keeps the client thin and consistent with how label resolution works for other commands.

## Output Formatting

```ts
// src/utils/output.ts

printFilterList(filters: GmailFilter[], labelNamesById: Map<string, string>): void
printFilter(filter: GmailFilter, labelNamesById: Map<string, string>): void
printFilterCreated(filter: GmailFilter, labelNamesById: Map<string, string>): void
printFilterDeleted(id: string): void
```

`printFilterList` renders one filter per line:

```
<id>  from:noreply@x.com subject:invoice  →  +Receipts -INBOX
<id>  query:has:attachment  →  +Auto/Receipts forward:archive@me.com
```

`printFilter` renders a multi-line block similar to `printMessage`:

```
ID:       <filter-id>
Criteria:
  From:           noreply@x.com
  Subject:        invoice
Action:
  Apply labels:   Receipts, Auto/Invoices
  Remove labels:  INBOX
  Forward:        archive@me.com
```

Only populated fields are shown.

## Command Registration

In `src/commands/gmail.ts`, after the existing `labels` subcommand block:

```ts
const filters = gmail
  .command('filters')
  .description('Manage Gmail filters');
```

Then four `addExamples(filters.command(...))` calls — one per action — following the exact pattern of the labels block. Each `create`/`delete` action uses `enforceWriteAccess('gmail', profile, '...')` before calling the client.

The list/get actions fetch labels once via `client.listLabels()` and build a `Map<id, name>` to pass to the print functions.

## Examples Block

Each command gets an `addExamples` block. Sample for `create`:

```
Examples:

  # apply a label to mail from a sender
  agentio gmail filters create --from noreply@example.com --apply Receipts

  # archive newsletters automatically
  agentio gmail filters create --from news@example.com --remove INBOX

  # complex criteria + multiple actions
  agentio gmail filters create \
    --query "has:attachment subject:invoice" \
    --apply Auto/Invoices --remove INBOX

  # forward all mail from a sender (forwarding address must be verified in Gmail settings)
  agentio gmail filters create --from boss@example.com --forward archive@me.com

  # size-based filter
  agentio gmail filters create --size 5000000 --size-comparison larger --apply Large
```

## Testing

Manual verification on a real Gmail profile:

1. `agentio gmail filters list` — succeeds with current scope
2. `agentio gmail profile add` — re-auth, consent screen now lists "Manage your basic mail settings"
3. `agentio gmail filters create --from test@example.com --apply Receipts` — returns new filter
4. `agentio gmail filters get <id>` — returns filter details with label names resolved
5. `agentio gmail filters list` — new filter appears
6. `agentio gmail filters delete <id>` — removes it
7. `agentio gmail filters get <id>` — `NOT_FOUND`
8. Validation: `agentio gmail filters create` (no flags) → `INVALID_PARAMS` "at least one criterion required"
9. Validation: `agentio gmail filters create --from x@y.com` (no action) → `INVALID_PARAMS` "at least one action required"
10. Validation: `agentio gmail filters create --from x@y.com --size 1000` → `INVALID_PARAMS` "--size requires --size-comparison"

## Out of Scope

- Filter update — Gmail API has no update endpoint; users delete + create
- JSON-based create input — flags cover it; can be added later if needed for cross-profile cloning
- Bulk delete via stdin pipe — filters are typically managed individually; not worth the complexity
- Forwarding-address management (the `users.settings.forwardingAddresses` endpoints) — out of scope for this spec
