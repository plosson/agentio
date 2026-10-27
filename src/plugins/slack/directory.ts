import { readPluginCache, writePluginCache } from '../../config/plugin-cache';
import type { SlackClient } from './client';
import type { SlackDirectoryEntry } from './types';

interface DirectoryFile {
  fetchedAt: string;
  users: Record<string, Omit<SlackDirectoryEntry, 'id'>>;
}

/** A full re-read once a day. */
const TTL_MS = 24 * 60 * 60 * 1000;
/**
 * An id the cache does not know (someone who just joined) triggers a re-read,
 * but at most this often: ids users.list never returns, such as people from
 * other workspaces in a shared channel, would otherwise re-read it every run.
 */
const UNKNOWN_REFRESH_MS = 60 * 60 * 1000;

/**
 * Workspace members' names, cached on disk per workspace and user, so each run
 * does not read users.list again. Names only: no emails or other details.
 */
export class SlackDirectory {
  constructor(
    private readonly client: SlackClient,
    /** The workspace and user the token acts as, e.g. `T0123:U0456`. */
    private readonly scope: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Every member, refreshed first when the cache is old or misses one of `ids`. */
  async entries(ids: Iterable<string>): Promise<SlackDirectoryEntry[]> {
    let data = await readPluginCache<DirectoryFile>('slack', this.scope, 'directory');
    if (!data || this.needsRefresh(data, [...ids])) data = await this.fetch();
    return Object.entries(data.users).map(([id, entry]) => ({ id, ...entry }));
  }

  private needsRefresh(data: DirectoryFile, ids: string[]): boolean {
    const age = this.now() - Date.parse(data.fetchedAt);
    if (!(age < TTL_MS)) return true;
    return age >= UNKNOWN_REFRESH_MS && ids.some((id) => !data.users[id]);
  }

  private async fetch(): Promise<DirectoryFile> {
    const users: DirectoryFile['users'] = {};
    for (const user of await this.client.listUsers({ includeDeleted: true, includeBots: true })) {
      users[user.id] = {
        name: user.name,
        ...(user.realName ? { realName: user.realName } : {}),
        ...(user.displayName ? { displayName: user.displayName } : {}),
      };
    }
    const data = { fetchedAt: new Date(this.now()).toISOString(), users };
    await writePluginCache('slack', this.scope, 'directory', data);
    return data;
  }
}
