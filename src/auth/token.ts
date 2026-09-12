import { CliError } from '../utils/errors';

/**
 * The composite token an agent machine carries in AGENTIO_TOKEN:
 *
 *   agio1.<base64url({ v: 1, url, kid })>.<secret>
 *
 * The middle part is readable so the hub URL and key id can be inspected
 * without treating the whole string as a secret; only the last part is.
 */
export const TOKEN_PREFIX = 'agio1';

export interface TokenParts {
  /** Hub base URL, e.g. https://vault.example.com */
  url: string;
  /** Key id, so the hub finds the record without hashing every secret. */
  kid: string;
  secret: string;
}

export function encodeToken(parts: TokenParts): string {
  const meta = Buffer.from(JSON.stringify({ v: 1, url: parts.url, kid: parts.kid })).toString('base64url');
  return `${TOKEN_PREFIX}.${meta}.${parts.secret}`;
}

export function decodeToken(token: string): TokenParts {
  const malformed = () =>
    new CliError('CONFIG_ERROR', 'Malformed AGENTIO_TOKEN', 'Paste the token exactly as the hub showed it');

  const [prefix, meta, secret, ...rest] = token.trim().split('.');
  if (prefix !== TOKEN_PREFIX || !meta || !secret || rest.length > 0) throw malformed();

  let parsed: { v?: unknown; url?: unknown; kid?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(meta, 'base64url').toString('utf8'));
  } catch {
    throw malformed();
  }
  if (parsed.v !== 1 || typeof parsed.url !== 'string' || typeof parsed.kid !== 'string') throw malformed();

  return { url: parsed.url, kid: parsed.kid, secret };
}
