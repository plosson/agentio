import { randomBytes } from 'crypto';

import type { AuthCode, OAuthClient, ServerToken } from '../types/server';

/**
 * Persistent store for OAuth state. Used by the agentio HTTP MCP server to
 * track DCR-registered clients, issued bearer tokens, and short-lived auth
 * codes.
 *
 * State held by the store:
 * - **clients**: persistent (passed in `initial`, written via `save`).
 * - **tokens**: persistent (same).
 * - **codes**: in-memory only — they live ~60 seconds during an active
 *   OAuth flow, so a process restart between /authorize and /token is
 *   acceptable cause for the user to re-run the flow.
 *
 * The store does not own its persistence: callers inject a `save` callback
 * that knows how to write `{ clients, tokens }` somewhere durable. The
 * production wiring in daemon.ts passes a callback that round-trips through
 * `loadConfig` / `saveConfig` to preserve unrelated `config.server.*`
 * fields. Tests can pass a no-op `save` and inspect the in-memory state
 * directly.
 *
 * Concurrency: this is a single-process server, but two simultaneous
 * in-flight OAuth flows could still race two `save()` calls. A tiny
 * promise-chain mutex (`withWriteLock`) serializes all mutations.
 */

const TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CODE_LIFETIME_MS = 60 * 1000; // 60 seconds

export interface PersistableOAuthState {
  clients: OAuthClient[];
  tokens: ServerToken[];
}

export interface OAuthStoreOptions {
  initial?: Partial<PersistableOAuthState>;
  /**
   * Persist the current `{ clients, tokens }` snapshot. Called after every
   * mutation, under the write mutex. Receiving a fresh snapshot (not a
   * mutation delta) keeps the contract simple.
   */
  save: (state: PersistableOAuthState) => Promise<void>;
  /**
   * Override `Date.now()` for tests that need to fast-forward time
   * (e.g. expiring tokens or codes).
   */
  now?: () => number;
}

export interface OAuthStore {
  // clients
  registerClient(args: {
    clientName?: string;
    redirectUris: string[];
  }): Promise<OAuthClient>;
  findClient(clientId: string): OAuthClient | undefined;
  listClients(): OAuthClient[];

  // tokens
  issueToken(args: { clientId: string; scope: string }): Promise<ServerToken>;
  findToken(token: string): ServerToken | undefined;
  revokeToken(token: string): Promise<boolean>;
  revokeAllTokens(): Promise<number>;
  listTokens(): ServerToken[];
  pruneExpiredTokens(): Promise<number>;

  // codes (in-memory)
  createCode(args: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scope: string;
  }): AuthCode;
  consumeCode(code: string): AuthCode | undefined;

  // diagnostics / introspection (not for hot path)
  snapshot(): PersistableOAuthState;
}

export function createOAuthStore(opts: OAuthStoreOptions): OAuthStore {
  const now = opts.now ?? (() => Date.now());
  let clients: OAuthClient[] = [...(opts.initial?.clients ?? [])];
  let tokens: ServerToken[] = [...(opts.initial?.tokens ?? [])];
  const codes = new Map<string, AuthCode>();

  let writeMutex: Promise<void> = Promise.resolve();

  function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = writeMutex.then(fn);
    writeMutex = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  function snapshot(): PersistableOAuthState {
    return { clients: [...clients], tokens: [...tokens] };
  }

  async function persist(): Promise<void> {
    await opts.save(snapshot());
  }

  return {
    /* ---- clients ---- */

    async registerClient(args) {
      return withWriteLock(async () => {
        const client: OAuthClient = {
          clientId: `cli_${randomBytes(16).toString('base64url')}`,
          clientName: args.clientName,
          redirectUris: [...args.redirectUris],
          createdAt: now(),
        };
        clients.push(client);
        await persist();
        return client;
      });
    },

    findClient(clientId) {
      return clients.find((c) => c.clientId === clientId);
    },

    listClients() {
      return [...clients];
    },

    /* ---- tokens ---- */

    async issueToken(args) {
      return withWriteLock(async () => {
        const issuedAt = now();
        const token: ServerToken = {
          token: randomBytes(32).toString('base64url'),
          clientId: args.clientId,
          scope: args.scope,
          issuedAt,
          expiresAt: issuedAt + TOKEN_LIFETIME_MS,
        };
        tokens.push(token);
        await persist();
        return token;
      });
    },

    findToken(tokenValue) {
      const t = tokens.find((x) => x.token === tokenValue);
      if (!t) return undefined;
      if (t.expiresAt < now()) return undefined;
      return t;
    },

    async revokeToken(tokenValue) {
      return withWriteLock(async () => {
        const before = tokens.length;
        tokens = tokens.filter((t) => t.token !== tokenValue);
        if (tokens.length === before) return false;
        await persist();
        return true;
      });
    },

    async revokeAllTokens() {
      return withWriteLock(async () => {
        const count = tokens.length;
        tokens = [];
        await persist();
        return count;
      });
    },

    listTokens() {
      return [...tokens];
    },

    async pruneExpiredTokens() {
      return withWriteLock(async () => {
        const cutoff = now();
        const before = tokens.length;
        tokens = tokens.filter((t) => t.expiresAt >= cutoff);
        const removed = before - tokens.length;
        if (removed > 0) await persist();
        return removed;
      });
    },

    /* ---- codes (in-memory only) ---- */

    createCode(args) {
      const code: AuthCode = {
        code: randomBytes(24).toString('base64url'),
        clientId: args.clientId,
        redirectUri: args.redirectUri,
        codeChallenge: args.codeChallenge,
        scope: args.scope,
        expiresAt: now() + CODE_LIFETIME_MS,
      };
      codes.set(code.code, code);
      return code;
    },

    consumeCode(codeValue) {
      const c = codes.get(codeValue);
      if (!c) return undefined;
      codes.delete(codeValue);
      if (c.expiresAt < now()) return undefined;
      return c;
    },

    snapshot,
  };
}
