import { readFile, writeFile, mkdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { OAuth2Client } from 'google-auth-library';

interface DirectoryEntry {
  displayName: string;
  email?: string;
}

interface DirectoryFile {
  fetchedAt: string;
  syncToken?: string;
  users: Record<string, DirectoryEntry>;
}

const TTL_MS = 24 * 60 * 60 * 1000;
const READ_MASK = 'names,emailAddresses';
const SOURCE = 'DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE';

function configDir(): string {
  return join(process.env.HOME || homedir(), '.config', 'agentio');
}

function sanitize(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function directoryPath(email: string): string {
  return join(configDir(), `gchat-directory-${sanitize(email)}.json`);
}

export class GChatDirectory {
  private path: string;
  private data: DirectoryFile | null = null;
  private loaded = false;

  constructor(email: string) {
    this.path = directoryPath(email);
  }

  lookup(userId: string): DirectoryEntry | undefined {
    return this.data?.users[userId];
  }

  size(): number {
    return this.data ? Object.keys(this.data.users).length : 0;
  }

  fetchedAt(): string | undefined {
    return this.data?.fetchedAt;
  }

  filePath(): string {
    return this.path;
  }

  async ensureFresh(auth: OAuth2Client, options: { force?: boolean } = {}): Promise<void> {
    await this.load();

    if (options.force) {
      await this.fetchFull(auth);
      return;
    }

    if (!this.data) {
      await this.fetchFull(auth);
      return;
    }

    const ageMs = Date.now() - new Date(this.data.fetchedAt).getTime();
    if (ageMs < TTL_MS) return;

    if (this.data.syncToken) {
      try {
        await this.fetchIncremental(auth, this.data.syncToken);
        return;
      } catch {
        // syncToken expired or rejected; fall through to full fetch
      }
    }
    await this.fetchFull(auth);
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.path)) return;
    try {
      const content = await readFile(this.path, 'utf-8');
      this.data = JSON.parse(content) as DirectoryFile;
    } catch {
      this.data = null;
    }
  }

  private async save(): Promise<void> {
    if (!this.data) return;
    const dir = dirname(this.path);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    }
    await writeFile(this.path, JSON.stringify(this.data), { mode: 0o600 });
  }

  private async fetchFull(auth: OAuth2Client): Promise<void> {
    const token = await auth.getAccessToken();
    if (!token.token) return;

    const users: Record<string, DirectoryEntry> = {};
    let pageToken: string | undefined;
    let syncToken: string | undefined;

    do {
      const params = new URLSearchParams({
        readMask: READ_MASK,
        sources: SOURCE,
        pageSize: '1000',
        requestSyncToken: 'true',
      });
      if (pageToken) params.set('pageToken', pageToken);

      const res = await fetch(
        `https://people.googleapis.com/v1/people:listDirectoryPeople?${params}`,
        { headers: { Authorization: `Bearer ${token.token}` } }
      );
      if (!res.ok) {
        throw new Error(`listDirectoryPeople failed: ${res.status} ${await res.text()}`);
      }
      const data = await res.json() as Record<string, any>;

      for (const person of (data.people || []) as Array<Record<string, any>>) {
        ingest(users, person);
      }
      pageToken = data.nextPageToken;
      syncToken = data.nextSyncToken || syncToken;
    } while (pageToken);

    this.data = {
      fetchedAt: new Date().toISOString(),
      syncToken,
      users,
    };
    await this.save();
  }

  private async fetchIncremental(auth: OAuth2Client, syncToken: string): Promise<void> {
    if (!this.data) throw new Error('no base data');
    const token = await auth.getAccessToken();
    if (!token.token) throw new Error('no token');

    const users = { ...this.data.users };
    let pageToken: string | undefined;
    let nextSyncToken: string | undefined;

    do {
      const params = new URLSearchParams({
        readMask: READ_MASK,
        sources: SOURCE,
        pageSize: '1000',
        syncToken,
        requestSyncToken: 'true',
      });
      if (pageToken) params.set('pageToken', pageToken);

      const res = await fetch(
        `https://people.googleapis.com/v1/people:listDirectoryPeople?${params}`,
        { headers: { Authorization: `Bearer ${token.token}` } }
      );
      if (!res.ok) {
        throw new Error(`incremental sync failed: ${res.status}`);
      }
      const data = await res.json() as Record<string, any>;

      for (const person of (data.people || []) as Array<Record<string, any>>) {
        const userId = personToUserId(person.resourceName);
        if (!userId) continue;
        if (person.metadata?.deleted) {
          delete users[userId];
        } else {
          ingest(users, person);
        }
      }
      pageToken = data.nextPageToken;
      nextSyncToken = data.nextSyncToken || nextSyncToken;
    } while (pageToken);

    this.data = {
      fetchedAt: new Date().toISOString(),
      syncToken: nextSyncToken || syncToken,
      users,
    };
    await this.save();
  }
}

function personToUserId(resourceName: string | undefined): string | undefined {
  if (!resourceName) return undefined;
  const id = resourceName.replace(/^people\//, '');
  return id ? `users/${id}` : undefined;
}

function ingest(users: Record<string, DirectoryEntry>, person: Record<string, any>): void {
  const userId = personToUserId(person.resourceName);
  if (!userId) return;
  const displayName = person.names?.[0]?.displayName;
  const email = person.emailAddresses?.[0]?.value;
  if (!displayName && !email) return;
  users[userId] = { displayName: displayName || email || userId, email };
}
