# Gmail Filter Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full CRUD for Gmail filters under `agentio gmail filters` (list, get, create, delete) so agents can manage server-side mail rules without leaving the CLI.

**Architecture:** Wraps `users.settings.filters.*` from the googleapis Gmail v1 client. Adds a new `filters` subcommand group under `gmail`, mirroring the existing `labels` subcommand block. Adds the `gmail.settings.basic` OAuth scope (required for create/delete; list/get already work under `gmail.modify`). Label-name resolution for `--apply`/`--remove` uses the existing `GmailClient.resolveLabelIds` helper; for output, label IDs are reverse-resolved to names via a single `listLabels()` call cached at the command layer.

**Tech Stack:** Bun, TypeScript, Commander.js, `@googleapis/gmail` v1.

**Spec:** `docs/superpowers/specs/2026-04-29-gmail-filters-design.md`

**Note on testing:** This project has no automated test suite. Verification is `bun run typecheck` after each task, plus manual smoke tests in Task 8 once a re-authed profile is available.

---

## File Structure

| File | Role |
|---|---|
| `src/auth/oauth.ts` | Add `gmail.settings.basic` to `GMAIL_SCOPES` |
| `src/types/gmail.ts` | New `GmailFilter`, `GmailFilterCriteria`, `GmailFilterAction`, `GmailFilterCreateOptions` types |
| `src/services/gmail/client.ts` | New methods: `listFilters`, `getFilter`, `createFilter`, `deleteFilter` |
| `src/utils/output.ts` | New formatters: `printFilterList`, `printFilter`, `printFilterCreated`, `printFilterDeleted` |
| `src/commands/gmail.ts` | New `filters` subcommand group with 4 actions |
| `claude/skills/agentio-gmail/SKILL.md` | Document new commands |
| `CLAUDE.md` | Add filter commands to the Gmail commands reference |

---

## Task 1: Add `gmail.settings.basic` OAuth scope

**Files:**
- Modify: `src/auth/oauth.ts`

- [ ] **Step 1: Edit GMAIL_SCOPES**

In `src/auth/oauth.ts`, replace the existing `GMAIL_SCOPES` block:

```ts
const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',  // search & read emails
  'https://www.googleapis.com/auth/gmail.send',      // send emails
  'https://www.googleapis.com/auth/gmail.compose',   // create/update drafts
  'https://www.googleapis.com/auth/gmail.modify',    // archive, mark read/unread, label CRUD, modify labels on messages/threads
  'https://www.googleapis.com/auth/userinfo.email',  // get email for profile naming
];
```

with:

```ts
const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',       // search & read emails
  'https://www.googleapis.com/auth/gmail.send',           // send emails
  'https://www.googleapis.com/auth/gmail.compose',        // create/update drafts
  'https://www.googleapis.com/auth/gmail.modify',         // archive, mark read/unread, label CRUD, modify labels on messages/threads
  'https://www.googleapis.com/auth/gmail.settings.basic', // create/delete filters
  'https://www.googleapis.com/auth/userinfo.email',       // get email for profile naming
];
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/auth/oauth.ts
git commit -m "feat(gmail): add gmail.settings.basic scope for filter management"
```

---

## Task 2: Add filter types

**Files:**
- Modify: `src/types/gmail.ts`

- [ ] **Step 1: Append the four new interfaces**

Append to the end of `src/types/gmail.ts`:

```ts
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

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/types/gmail.ts
git commit -m "feat(gmail): add filter types"
```

---

## Task 3: Add client methods for filters

**Files:**
- Modify: `src/services/gmail/client.ts`

- [ ] **Step 1: Update the type import**

In `src/services/gmail/client.ts` line 4, replace:

```ts
import type { GmailMessage, GmailListOptions, GmailSendOptions, GmailAttachment, GmailAttachmentInfo, GmailLabel } from '../../types/gmail';
```

with:

```ts
import type { GmailMessage, GmailListOptions, GmailSendOptions, GmailAttachment, GmailAttachmentInfo, GmailLabel, GmailFilter, GmailFilterCriteria, GmailFilterAction, GmailFilterCreateOptions } from '../../types/gmail';
```

- [ ] **Step 2: Add a `mapFilter` helper and four public methods**

Insert this block in `src/services/gmail/client.ts` immediately before the `private isNotFoundError` method (at line 869 in the current file):

```ts
  private mapFilter(filter: gmail_v1.Schema$Filter): GmailFilter {
    const rawCriteria = filter.criteria || {};
    const criteria: GmailFilterCriteria = {};
    if (rawCriteria.from) criteria.from = rawCriteria.from;
    if (rawCriteria.to) criteria.to = rawCriteria.to;
    if (rawCriteria.subject) criteria.subject = rawCriteria.subject;
    if (rawCriteria.query) criteria.query = rawCriteria.query;
    if (rawCriteria.negatedQuery) criteria.negatedQuery = rawCriteria.negatedQuery;
    if (rawCriteria.hasAttachment) criteria.hasAttachment = true;
    if (rawCriteria.excludeChats) criteria.excludeChats = true;
    if (typeof rawCriteria.size === 'number') criteria.size = rawCriteria.size;
    if (rawCriteria.sizeComparison === 'larger' || rawCriteria.sizeComparison === 'smaller') {
      criteria.sizeComparison = rawCriteria.sizeComparison;
    }

    const rawAction = filter.action || {};
    const action: GmailFilterAction = {};
    if (rawAction.addLabelIds?.length) action.addLabelIds = rawAction.addLabelIds;
    if (rawAction.removeLabelIds?.length) action.removeLabelIds = rawAction.removeLabelIds;
    if (rawAction.forward) action.forward = rawAction.forward;

    return { id: filter.id!, criteria, action };
  }

  async listFilters(): Promise<GmailFilter[]> {
    try {
      const response = await this.gmail.users.settings.filters.list({ userId: 'me' });
      return (response.data.filter || []).map((f) => this.mapFilter(f));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Gmail API error: ${message}`);
    }
  }

  async getFilter(id: string): Promise<GmailFilter> {
    try {
      const response = await this.gmail.users.settings.filters.get({ userId: 'me', id });
      return this.mapFilter(response.data);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        throw new CliError('NOT_FOUND', `Filter not found: ${id}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Gmail API error: ${message}`);
    }
  }

  async createFilter(options: GmailFilterCreateOptions): Promise<GmailFilter> {
    try {
      const response = await this.gmail.users.settings.filters.create({
        userId: 'me',
        requestBody: {
          criteria: options.criteria,
          action: options.action,
        },
      });
      return this.mapFilter(response.data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Failed to create filter: ${message}`);
    }
  }

  async deleteFilter(id: string): Promise<void> {
    try {
      await this.gmail.users.settings.filters.delete({ userId: 'me', id });
    } catch (error) {
      if (this.isNotFoundError(error)) {
        throw new CliError('NOT_FOUND', `Filter not found: ${id}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Failed to delete filter: ${message}`);
    }
  }
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/services/gmail/client.ts
git commit -m "feat(gmail): add filter CRUD client methods"
```

---

## Task 4: Add filter output formatters

**Files:**
- Modify: `src/utils/output.ts`

- [ ] **Step 1: Update the type import**

Find the existing import of `GmailLabel` from `../types/gmail` near the top of `src/utils/output.ts` and add `GmailFilter`, `GmailFilterCriteria`, `GmailFilterAction` alongside it. If the file uses one combined import line such as `import type { GmailMessage, GmailLabel } from '../types/gmail';`, change it to:

```ts
import type { GmailMessage, GmailLabel, GmailFilter, GmailFilterCriteria, GmailFilterAction } from '../types/gmail';
```

(Keep any other type names already present on that line.)

- [ ] **Step 2: Append the four formatter functions**

Append at the end of `src/utils/output.ts`:

```ts
function resolveLabelNames(ids: string[] | undefined, labelNamesById: Map<string, string>): string[] {
  if (!ids?.length) return [];
  return ids.map((id) => labelNamesById.get(id) ?? id);
}

function summarizeFilterCriteria(c: GmailFilterCriteria): string {
  const parts: string[] = [];
  if (c.from) parts.push(`from:${c.from}`);
  if (c.to) parts.push(`to:${c.to}`);
  if (c.subject) parts.push(`subject:${c.subject}`);
  if (c.query) parts.push(`query:${c.query}`);
  if (c.negatedQuery) parts.push(`-query:${c.negatedQuery}`);
  if (c.hasAttachment) parts.push('has:attachment');
  if (c.excludeChats) parts.push('exclude:chats');
  if (typeof c.size === 'number' && c.sizeComparison) {
    parts.push(`size:${c.sizeComparison}:${c.size}`);
  }
  return parts.length ? parts.join(' ') : '(no criteria)';
}

function summarizeFilterAction(a: GmailFilterAction, labelNamesById: Map<string, string>): string {
  const parts: string[] = [];
  for (const name of resolveLabelNames(a.addLabelIds, labelNamesById)) parts.push(`+${name}`);
  for (const name of resolveLabelNames(a.removeLabelIds, labelNamesById)) parts.push(`-${name}`);
  if (a.forward) parts.push(`forward:${a.forward}`);
  return parts.length ? parts.join(' ') : '(no action)';
}

export function printFilterList(filters: GmailFilter[], labelNamesById: Map<string, string>): void {
  if (filters.length === 0) {
    console.log('No filters found');
    return;
  }
  const idWidth = Math.max(2, ...filters.map((f) => f.id.length));
  for (const filter of filters) {
    const criteria = summarizeFilterCriteria(filter.criteria);
    const action = summarizeFilterAction(filter.action, labelNamesById);
    console.log(`${filter.id.padEnd(idWidth)}  ${criteria}  ->  ${action}`);
  }
  console.log(`\n${filters.length} filter(s)`);
}

export function printFilter(filter: GmailFilter, labelNamesById: Map<string, string>): void {
  console.log(`ID:       ${filter.id}`);

  const c = filter.criteria;
  const criteriaLines: string[] = [];
  if (c.from) criteriaLines.push(`  From:           ${c.from}`);
  if (c.to) criteriaLines.push(`  To:             ${c.to}`);
  if (c.subject) criteriaLines.push(`  Subject:        ${c.subject}`);
  if (c.query) criteriaLines.push(`  Query:          ${c.query}`);
  if (c.negatedQuery) criteriaLines.push(`  Negated query:  ${c.negatedQuery}`);
  if (c.hasAttachment) criteriaLines.push(`  Has attachment: yes`);
  if (c.excludeChats) criteriaLines.push(`  Exclude chats:  yes`);
  if (typeof c.size === 'number' && c.sizeComparison) {
    criteriaLines.push(`  Size:           ${c.sizeComparison} ${c.size} bytes`);
  }
  if (criteriaLines.length) {
    console.log('Criteria:');
    for (const line of criteriaLines) console.log(line);
  }

  const a = filter.action;
  const actionLines: string[] = [];
  const apply = resolveLabelNames(a.addLabelIds, labelNamesById);
  const remove = resolveLabelNames(a.removeLabelIds, labelNamesById);
  if (apply.length) actionLines.push(`  Apply labels:   ${apply.join(', ')}`);
  if (remove.length) actionLines.push(`  Remove labels:  ${remove.join(', ')}`);
  if (a.forward) actionLines.push(`  Forward:        ${a.forward}`);
  if (actionLines.length) {
    console.log('Action:');
    for (const line of actionLines) console.log(line);
  }
}

export function printFilterCreated(filter: GmailFilter, labelNamesById: Map<string, string>): void {
  console.log(`Created filter: ${filter.id}`);
  console.log(`  ${summarizeFilterCriteria(filter.criteria)}  ->  ${summarizeFilterAction(filter.action, labelNamesById)}`);
}

export function printFilterDeleted(id: string): void {
  console.log(`Deleted filter: ${id}`);
}
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/utils/output.ts
git commit -m "feat(gmail): add filter output formatters"
```

---

## Task 5: Wire `filters list` and `filters get` commands

**Files:**
- Modify: `src/commands/gmail.ts`

- [ ] **Step 1: Update the output import**

In `src/commands/gmail.ts` line 10, append the four new formatter names to the existing import. Find:

```ts
import { printMessageList, printMessage, printSendResult, printDraftResult, printArchived, printMarked, printAttachmentList, printAttachmentDownloaded, printLabelList, printLabelCreated, printLabelDeleted, printLabelRenamed, printLabelModified, printBatchProgress, printBatchSummary, printBatchDryRun, raw } from '../utils/output';
```

Replace with:

```ts
import { printMessageList, printMessage, printSendResult, printDraftResult, printArchived, printMarked, printAttachmentList, printAttachmentDownloaded, printLabelList, printLabelCreated, printLabelDeleted, printLabelRenamed, printLabelModified, printBatchProgress, printBatchSummary, printBatchDryRun, printFilterList, printFilter, printFilterCreated, printFilterDeleted, raw } from '../utils/output';
```

- [ ] **Step 1b: Update the type import**

In `src/commands/gmail.ts` line 15, find:

```ts
import type { GmailAttachment, GmailSendOptions } from '../types/gmail';
```

Replace with:

```ts
import type { GmailAttachment, GmailSendOptions, GmailFilterCriteria, GmailFilterAction } from '../types/gmail';
```

- [ ] **Step 2: Add a label-name lookup helper**

Insert this helper just below `parseChunkOpts` (around line 173 in the current file, before `export function registerGmailCommands`):

```ts
async function buildLabelNamesById(client: GmailClient): Promise<Map<string, string>> {
  const labels = await client.listLabels();
  return new Map(labels.map((l) => [l.id, l.name]));
}
```

- [ ] **Step 3: Add the `filters` subcommand group with `list` and `get`**

Inside `registerGmailCommands`, immediately after the `labels` block (after the `addExamples(labels.command('rename')...)` call but before the `addExamples(gmail.command('label')...)` block — i.e. after line 560 in the current file), insert:

```ts
  const filters = gmail
    .command('filters')
    .description('Manage Gmail filters');

  addExamples(
    filters
      .command('list')
      .description('List all filters')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .action(async (options) => {
        try {
          const { client } = await getGmailClient(options.profile);
          const [filterList, labelNamesById] = await Promise.all([
            client.listFilters(),
            buildLabelNamesById(client),
          ]);
          printFilterList(filterList, labelNamesById);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # list every filter
  agentio gmail filters list

  # list filters for a specific profile
  agentio gmail filters list --profile alice@example.com`,
  );

  addExamples(
    filters
      .command('get')
      .argument('<id>', 'Filter ID')
      .description('Get a filter')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .action(async (id: string, options) => {
        try {
          const { client } = await getGmailClient(options.profile);
          const [filter, labelNamesById] = await Promise.all([
            client.getFilter(id),
            buildLabelNamesById(client),
          ]);
          printFilter(filter, labelNamesById);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # show full filter details
  agentio gmail filters get ANe1BmgABCDEF1234567890`,
  );
```

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 5: Smoke-test list (works under existing `gmail.modify` scope)**

Run: `bun run dev gmail filters list`
Expected: either "No filters found" or one row per filter; exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/commands/gmail.ts
git commit -m "feat(gmail): add 'filters list' and 'filters get' commands"
```

---

## Task 6: Wire `filters create`

**Files:**
- Modify: `src/commands/gmail.ts`

- [ ] **Step 1: Add a flag-to-criteria/action parser helper**

Insert just below `buildLabelNamesById` (added in Task 5), before `export function registerGmailCommands`:

```ts
function parseFilterCriteriaFromOptions(options: Record<string, unknown>): GmailFilterCriteria {
  const criteria: GmailFilterCriteria = {};

  const from = options.from as string | undefined;
  const to = options.to as string | undefined;
  const subject = options.subject as string | undefined;
  const query = options.query as string | undefined;
  const negatedQuery = options.negatedQuery as string | undefined;
  const hasAttachment = options.hasAttachment === true;
  const excludeChats = options.excludeChats === true;
  const sizeRaw = options.size as string | undefined;
  const sizeComparison = options.sizeComparison as string | undefined;

  if (from) criteria.from = from;
  if (to) criteria.to = to;
  if (subject) criteria.subject = subject;
  if (query) criteria.query = query;
  if (negatedQuery) criteria.negatedQuery = negatedQuery;
  if (hasAttachment) criteria.hasAttachment = true;
  if (excludeChats) criteria.excludeChats = true;

  const sizeProvided = sizeRaw !== undefined;
  const cmpProvided = sizeComparison !== undefined;
  if (sizeProvided !== cmpProvided) {
    throw new CliError('INVALID_PARAMS', '--size and --size-comparison must be set together');
  }
  if (sizeProvided && cmpProvided) {
    if (sizeComparison !== 'larger' && sizeComparison !== 'smaller') {
      throw new CliError('INVALID_PARAMS', '--size-comparison must be "larger" or "smaller"');
    }
    const sizeNum = parseInt(sizeRaw!, 10);
    if (!Number.isFinite(sizeNum) || sizeNum < 0) {
      throw new CliError('INVALID_PARAMS', '--size must be a non-negative integer (bytes)');
    }
    criteria.size = sizeNum;
    criteria.sizeComparison = sizeComparison;
  }

  return criteria;
}
```

- [ ] **Step 2: Add the `filters create` command**

Inside `registerGmailCommands`, immediately after the `filters get` block added in Task 5, insert:

```ts
  addExamples(
    filters
      .command('create')
      .description('Create a Gmail filter')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .option('--from <email>', 'Match sender')
      .option('--to <email>', 'Match recipient')
      .option('--subject <text>', 'Match subject text')
      .option('--query <q>', 'Gmail search query (same syntax as "gmail search")')
      .option('--negated-query <q>', 'Gmail search query that must NOT match')
      .option('--has-attachment', 'Match only messages with attachments')
      .option('--exclude-chats', 'Exclude chat messages')
      .option('--size <bytes>', 'Match by message size (paired with --size-comparison)')
      .option('--size-comparison <cmp>', 'Size comparison: larger|smaller (paired with --size)')
      .option('--apply <label>', 'Label to apply (name or ID, repeatable)', (val: string, acc: string[]) => [...acc, val], [])
      .option('--remove <label>', 'Label to remove (name or ID, repeatable)', (val: string, acc: string[]) => [...acc, val], [])
      .option('--forward <email>', 'Forward to a verified forwarding address')
      .action(async (options) => {
        try {
          const criteria = parseFilterCriteriaFromOptions(options);
          if (Object.keys(criteria).length === 0) {
            throw new CliError('INVALID_PARAMS', 'At least one criterion is required', 'Use --from, --to, --subject, --query, --negated-query, --has-attachment, --exclude-chats, or --size');
          }

          const apply = options.apply as string[];
          const remove = options.remove as string[];
          const forward = options.forward as string | undefined;
          if (!apply.length && !remove.length && !forward) {
            throw new CliError('INVALID_PARAMS', 'At least one action is required', 'Use --apply, --remove, or --forward');
          }

          const { client, profile } = await getGmailClient(options.profile);
          await enforceWriteAccess('gmail', profile, 'create filter');

          const [addLabelIds, removeLabelIds] = await Promise.all([
            client.resolveLabelIds(apply),
            client.resolveLabelIds(remove),
          ]);

          const action: GmailFilterAction = {};
          if (addLabelIds.length) action.addLabelIds = addLabelIds;
          if (removeLabelIds.length) action.removeLabelIds = removeLabelIds;
          if (forward) action.forward = forward;

          const filter = await client.createFilter({ criteria, action });
          const labelNamesById = await buildLabelNamesById(client);
          printFilterCreated(filter, labelNamesById);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # apply a label to mail from a sender
  agentio gmail filters create --from noreply@example.com --apply Receipts

  # archive newsletters automatically
  agentio gmail filters create --from news@example.com --remove INBOX

  # complex criteria + multiple actions
  agentio gmail filters create \\
    --query "has:attachment subject:invoice" \\
    --apply Auto/Invoices --remove INBOX

  # forward all mail from a sender (forwarding address must be verified in Gmail settings)
  agentio gmail filters create --from boss@example.com --forward archive@me.com

  # size-based filter (5MB or larger)
  agentio gmail filters create --size 5000000 --size-comparison larger --apply Large`,
  );
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 4: Smoke-test the validation paths (no API call needed)**

Run: `bun run dev gmail filters create`
Expected: exits non-zero, error: `At least one criterion is required`.

Run: `bun run dev gmail filters create --from x@y.com`
Expected: exits non-zero, error: `At least one action is required`.

Run: `bun run dev gmail filters create --from x@y.com --size 1000`
Expected: exits non-zero, error: `--size and --size-comparison must be set together`.

- [ ] **Step 5: Commit**

```bash
git add src/commands/gmail.ts
git commit -m "feat(gmail): add 'filters create' command"
```

---

## Task 7: Wire `filters delete`

**Files:**
- Modify: `src/commands/gmail.ts`

- [ ] **Step 1: Add the `filters delete` command**

Inside `registerGmailCommands`, immediately after the `filters create` block added in Task 6, insert:

```ts
  addExamples(
    filters
      .command('delete')
      .argument('<id...>', 'Filter ID(s)')
      .description('Delete one or more filters')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .action(async (ids: string[], options) => {
        try {
          const { client, profile } = await getGmailClient(options.profile);
          await enforceWriteAccess('gmail', profile, 'delete filter');

          let failures = 0;
          for (const id of ids) {
            try {
              await client.deleteFilter(id);
              printFilterDeleted(id);
            } catch (error) {
              failures++;
              const message = error instanceof Error ? error.message : String(error);
              console.error(`Failed to delete filter ${id}: ${message}`);
            }
          }
          if (failures > 0) process.exit(5);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # delete one filter
  agentio gmail filters delete ANe1BmgABCDEF1234567890

  # delete several at once
  agentio gmail filters delete ANe1Bmg... ANe1Bmh... ANe1Bmi...`,
  );
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/commands/gmail.ts
git commit -m "feat(gmail): add 'filters delete' command"
```

---

## Task 8: End-to-end manual smoke test

**Files:** none (verification only).

This step requires re-authing a Gmail profile so the new `gmail.settings.basic` scope is granted. Without re-auth, create/delete will fail with an insufficient-scope API error (which is the expected, documented behavior).

- [ ] **Step 1: Re-auth a profile**

Run: `bun run dev gmail profile add`
Expected: OAuth flow opens browser; consent screen now lists "See, edit, create, or change your email settings and filters in Gmail" (the user-facing string for `gmail.settings.basic`); flow completes.

- [ ] **Step 2: Create a filter**

Run: `bun run dev gmail filters create --from agentio-test@example.com --apply INBOX`
Expected: prints `Created filter: <id>` plus a one-line summary. Capture the `<id>` for the next steps.

- [ ] **Step 3: List filters**

Run: `bun run dev gmail filters list`
Expected: the new filter appears in the list with `from:agentio-test@example.com  ->  +INBOX`.

- [ ] **Step 4: Get the filter**

Run: `bun run dev gmail filters get <id>`
Expected: multi-line block showing `ID:`, `Criteria: From: agentio-test@example.com`, `Action: Apply labels: INBOX`.

- [ ] **Step 5: Delete the filter**

Run: `bun run dev gmail filters delete <id>`
Expected: prints `Deleted filter: <id>`.

- [ ] **Step 6: Verify deletion**

Run: `bun run dev gmail filters get <id>`
Expected: exits non-zero with `Filter not found: <id>`.

- [ ] **Step 7: Verify multi-delete partial failure**

Run: `bun run dev gmail filters delete bogus-id-1 bogus-id-2`
Expected: prints two `Failed to delete filter ...: Filter not found: ...` lines on stderr; exits with code 5.

No commit — this task is verification only.

---

## Task 9: Update documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `claude/skills/agentio-gmail/SKILL.md`

- [ ] **Step 1: Update CLAUDE.md Gmail section**

In `CLAUDE.md`, find the `### Gmail` section's command list. After the line `agentio gmail labels rename <old> <new>`, insert these lines (maintain existing indentation/formatting style):

```
agentio gmail filters list
agentio gmail filters get <id>
agentio gmail filters create [--from <email>] [--to <email>] [--subject <text>] [--query <q>] [--negated-query <q>] [--has-attachment] [--exclude-chats] [--size <bytes> --size-comparison larger|smaller] [--apply <label>]... [--remove <label>]... [--forward <email>]
agentio gmail filters delete <id...>
```

- [ ] **Step 2: Update the gmail SKILL.md**

In `claude/skills/agentio-gmail/SKILL.md`, find the section header `## agentio gmail labels rename <old> <new>` (around line 270) and insert these four sections immediately after that section ends (i.e. before `## agentio gmail label [id...]`):

````markdown
## agentio gmail filters list

List all Gmail filters

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)

```
Examples:

  # list every filter
  agentio gmail filters list

  # list filters for a specific profile
  agentio gmail filters list --profile alice@example.com
```

## agentio gmail filters get <id>

Get a single filter by ID

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)

```
Examples:

  # show full filter details
  agentio gmail filters get ANe1BmgABCDEF1234567890
```

## agentio gmail filters create

Create a Gmail filter. At least one criterion AND at least one action are required. Filters trigger on incoming mail server-side; they do not retroactively process the existing inbox.

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)
- `--from <email>`: Match sender
- `--to <email>`: Match recipient
- `--subject <text>`: Match subject text
- `--query <q>`: Gmail search query (same syntax as "gmail search")
- `--negated-query <q>`: Gmail search query that must NOT match
- `--has-attachment`: Match only messages with attachments
- `--exclude-chats`: Exclude chat messages
- `--size <bytes>`: Match by message size (paired with --size-comparison)
- `--size-comparison <cmp>`: Size comparison, `larger` or `smaller` (paired with --size)
- `--apply <label>`: Label to apply (name or ID, repeatable)
- `--remove <label>`: Label to remove (name or ID, repeatable)
- `--forward <email>`: Forward to a verified forwarding address (must already be verified in Gmail settings)

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

  # size-based filter (5MB or larger)
  agentio gmail filters create --size 5000000 --size-comparison larger --apply Large
```

## agentio gmail filters delete <id...>

Delete one or more filters. Each ID is deleted individually; failures on one ID do not abort the rest. Exits with code 5 if any deletion failed.

Options:

- `--profile <name>`: Profile name (optional if only one profile exists)

```
Examples:

  # delete one filter
  agentio gmail filters delete ANe1BmgABCDEF1234567890

  # delete several at once
  agentio gmail filters delete ANe1Bmg... ANe1Bmh... ANe1Bmi...
```

````

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md claude/skills/agentio-gmail/SKILL.md
git commit -m "docs: document gmail filter commands"
```

---

## Task 10: Bump version

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Bump the patch version**

In `package.json`, change `"version": "1.5.3"` to `"version": "1.5.4"`.

- [ ] **Step 2: Commit and tag**

```bash
git add package.json
git commit -m "chore: bump version to 1.5.4"
git tag v1.5.4
```

(Do not push — leave that to the user.)

---

## Done

All filter CRUD operations are wired up, validated, documented, and version-bumped. Existing profiles can use `filters list` and `filters get` immediately; create/delete becomes available after the user re-runs `agentio gmail profile add`.
