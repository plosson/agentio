import {
  chunk,
  errorMessage,
  isSuccess,
  parseChunkSize,
  parseCsvRows,
  sendAllWithRetry,
  type BatchDeps,
  type BatchSubRequest,
  type RetryOptions,
} from './batch';

/**
 * Drive shortcuts (files.create with mimeType application/vnd.google-apps.shortcut),
 * one or many, over the same batch endpoint, chunking and retries as `move`.
 */

export const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface ShortcutItem {
  targetId: string;
  parent: string;
  name?: string;
}

export interface ShortcutResult {
  targetId: string;
  parent: string;
  status: 'ok' | 'error';
  name?: string;
  shortcutId?: string;
  existing?: boolean;
  dryRun?: boolean;
  note?: string;
  error?: string;
}

export interface ShortcutSummary {
  total: number;
  ok: number;
  error: number;
  created: number;
  existing: number;
  dryRun: boolean;
}

export interface BatchShortcutOptions extends RetryOptions {
  chunkSize?: number;
  dryRun?: boolean;
  /** Create a shortcut even when one to the same target is already in the parent. */
  allowDuplicates?: boolean;
  onResult?: (result: ShortcutResult) => void;
}

/** `targetId,parentId[,name]` per line; header, blank and `#` lines are skipped; quote names holding commas. */
export function parseShortcutCsv(text: string): ShortcutItem[] {
  return parseCsvRows(text, {
    min: 2,
    max: 3,
    header: /^(target[_ -]?id|file[_ -]?id|id|target)$/i,
    usage: 'Each line must be targetId,parentId[,name] (quote a name that holds commas)',
  }).map(([targetId, parent, name]) => (name ? { targetId, parent, name } : { targetId, parent }));
}

const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

function query(params: Record<string, string>): string {
  return new URLSearchParams({ supportsAllDrives: 'true', ...params }).toString();
}

export function getTargetRequest(id: string): BatchSubRequest {
  return { method: 'GET', path: `/drive/v3/files/${encodeURIComponent(id)}?${query({ fields: 'id,name,mimeType,trashed' })}` };
}

export function getParentRequest(id: string): BatchSubRequest {
  return { method: 'GET', path: `/drive/v3/files/${encodeURIComponent(id)}?${query({ fields: 'id,name,mimeType,trashed,capabilities/canAddChildren' })}` };
}

/**
 * Lists shortcuts pointing at `targetId`; the caller keeps those in the parent.
 * Drive refuses `'<parent>' in parents` combined with `shortcutDetails.targetId`
 * ("Invalid Value"), so parents are filtered client-side.
 */
export function findExistingRequest(targetId: string): BatchSubRequest {
  const params = {
    q: `mimeType = '${SHORTCUT_MIME}' and shortcutDetails.targetId = '${q(targetId)}' and trashed = false`,
    fields: 'files(id,name,parents)',
    pageSize: '100',
    includeItemsFromAllDrives: 'true',
  };
  return { method: 'GET', path: `/drive/v3/files?${query(params)}` };
}

export function createShortcutRequest(targetId: string, parent: string, name: string): BatchSubRequest {
  return {
    method: 'POST',
    path: `/drive/v3/files?${query({ fields: 'id,name,parents,shortcutDetails' })}`,
    body: { name, mimeType: SHORTCUT_MIME, parents: [parent], shortcutDetails: { targetId } },
  };
}

/**
 * Per chunk: one round of lookups (target, parent, existing shortcut), then one
 * round of creates. Results keep the input order.
 */
export async function batchShortcut(
  items: ShortcutItem[],
  deps: BatchDeps,
  options: BatchShortcutOptions = {}
): Promise<{ results: ShortcutResult[]; summary: ShortcutSummary }> {
  const size = parseChunkSize(options.chunkSize);
  const checkExisting = !options.allowDuplicates;
  const perRow = checkExisting ? 3 : 2;
  const results: ShortcutResult[] = [];
  const seen = new Set<string>();

  for (const group of chunk(items, size)) {
    const slots: ShortcutResult[] = group.map((item) => ({ targetId: item.targetId, parent: item.parent, status: 'ok', ...(item.name ? { name: item.name } : {}) }));
    const lookups: BatchSubRequest[] = [];
    group.forEach((item) => {
      lookups.push(getTargetRequest(item.targetId), getParentRequest(item.parent));
      if (checkExisting) lookups.push(findExistingRequest(item.targetId));
    });
    const answers = await sendAllWithRetry(lookups, deps, size, options);

    const toCreate: number[] = [];
    group.forEach((item, i) => {
      const slot = slots[i];
      const fail = (error: string) => Object.assign(slot, { status: 'error', error });
      const [target, parent, existing] = answers.slice(i * perRow, i * perRow + perRow);

      const key = `${item.targetId}\u0000${item.parent}`;
      if (seen.has(key)) return fail('Duplicate targetId,parentId in input; only the first entry is used');
      seen.add(key);

      if (!isSuccess(parent)) return fail(`Parent folder not accessible: ${errorMessage(parent)}`);
      if (parent.body?.mimeType !== FOLDER_MIME) return fail(`Parent ${item.parent} is not a folder (${parent.body?.mimeType ?? 'unknown type'})`);
      if (parent.body?.trashed) return fail(`Parent ${item.parent} is in the trash`);
      if (parent.body?.capabilities?.canAddChildren === false) return fail(`No permission to add items to parent ${item.parent}`);

      if (isSuccess(target)) {
        if (!slot.name) slot.name = target.body?.name || item.targetId;
        if (target.body?.trashed) slot.note = 'Target is in the trash';
      } else if (options.dryRun || !item.name) {
        return fail(
          `Target not accessible: ${errorMessage(target)}` +
            (item.name ? '' : ' (pass a name to try creating the shortcut anyway)')
        );
      } else {
        slot.note = `Target could not be read (${errorMessage(target)}); using the given name`;
      }

      if (existing && isSuccess(existing)) {
        // `parent` may be an alias such as "root": compare with the id the parent lookup returned.
        const parentIds = [item.parent, parent.body?.id].filter(Boolean);
        const files: { id?: string; name?: string; parents?: string[] }[] = existing.body?.files ?? [];
        const found = files.find((f) => f.parents?.some((p) => parentIds.includes(p)));
        if (found?.id) {
          Object.assign(slot, { shortcutId: found.id, existing: true, note: 'A shortcut to this target already exists in the parent; none created' });
          if (found.name) slot.name = found.name;
          if (options.dryRun) slot.dryRun = true;
          return;
        }
      } else if (existing) {
        slot.note = [slot.note, `Could not check for an existing shortcut (${errorMessage(existing)})`].filter(Boolean).join('; ');
      }

      if (options.dryRun) {
        slot.dryRun = true;
        return;
      }
      toCreate.push(i);
    });

    const created = await sendAllWithRetry(
      toCreate.map((i) => createShortcutRequest(group[i].targetId, group[i].parent, slots[i].name!)),
      deps,
      size,
      options
    );
    toCreate.forEach((i, k) => {
      const res = created[k];
      if (isSuccess(res)) {
        slots[i].shortcutId = res.body?.id;
        if (res.body?.name) slots[i].name = res.body.name;
      } else {
        Object.assign(slots[i], { status: 'error', error: errorMessage(res) });
      }
    });

    for (const slot of slots) {
      results.push(slot);
      options.onResult?.(slot);
    }
  }

  const ok = results.filter((r) => r.status === 'ok');
  return {
    results,
    summary: {
      total: results.length,
      ok: ok.length,
      error: results.length - ok.length,
      created: ok.filter((r) => r.shortcutId && !r.existing && !r.dryRun).length,
      existing: ok.filter((r) => r.existing).length,
      dryRun: !!options.dryRun,
    },
  };
}
