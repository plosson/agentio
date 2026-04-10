/**
 * Configuration for the agentio HTTP MCP server (`agentio server start`).
 *
 * Stored under `config.server` in `~/.config/agentio/config.json`, mirroring
 * how the gateway daemon stores its own config under `config.gateway`.
 */
export interface ServerConfig {
  /** Operator API key. Auto-generated on first boot if missing. */
  apiKey?: string;
  /** Port to bind (default: 9999). */
  port?: number;
  /** Host to bind (default: '0.0.0.0'). */
  host?: string;
  /** Dynamically registered OAuth clients (RFC 7591). */
  clients?: OAuthClient[];
  /** Issued bearer tokens (RFC 6749). */
  tokens?: ServerToken[];
}

/**
 * An OAuth client registered via Dynamic Client Registration. Public clients
 * only — no client_secret. Identified by an opaque client_id.
 */
export interface OAuthClient {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  /** Unix epoch milliseconds. */
  createdAt: number;
}

/**
 * An issued bearer token. Opaque, 32 random bytes base64url. Persists across
 * server restarts; expires after 30 days unless revoked.
 */
export interface ServerToken {
  token: string;
  clientId: string;
  /** The `?services=...` query the client supplied at /authorize. */
  scope: string;
  /** Unix epoch milliseconds. */
  issuedAt: number;
  /** Unix epoch milliseconds. */
  expiresAt: number;
}

/**
 * A short-lived authorization code. Stored in-memory only — never persisted
 * to disk. The full flow takes seconds, so a process restart between
 * /authorize and /token is acceptable cause for re-auth.
 */
export interface AuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  /** PKCE S256 challenge from /authorize. */
  codeChallenge: string;
  scope: string;
  /** Unix epoch milliseconds. */
  expiresAt: number;
}
