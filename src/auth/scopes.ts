import { CliError } from '../utils/errors';

/**
 * What a client may ask for when it logs in (`agentio login --scope`). The
 * owner approves all of it or denies it. Every scope covers every profile,
 * now and future; write includes read.
 */
export const SCOPES = ['profiles:read', 'profiles:write', 'profiles:manage'] as const;
export type Scope = (typeof SCOPES)[number];

/** More entries than any honest client sends; refused before anything is stored or echoed. */
const MAX_ENTRIES = 16;

const known = (s: unknown): s is Scope => (SCOPES as readonly unknown[]).includes(s);

/** A non-empty list of known scopes, de-duplicated, in the order of SCOPES; else INVALID_PARAMS. */
export function validateScopes(input: unknown): Scope[] {
  const suggestion = `Known scopes: ${SCOPES.join(', ')}`;
  if (!Array.isArray(input) || input.length === 0 || !input.every((s) => typeof s === 'string')) {
    throw new CliError('INVALID_PARAMS', 'scopes must be a non-empty list of scope names', suggestion);
  }
  if (input.length > MAX_ENTRIES) {
    throw new CliError('INVALID_PARAMS', `scopes may list at most ${MAX_ENTRIES} entries`, suggestion);
  }
  const unknown = [...new Set(input.filter((s) => !known(s)))];
  if (unknown.length > 0) {
    throw new CliError('INVALID_PARAMS', `Unknown scope${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`, suggestion);
  }
  return SCOPES.filter((s) => input.includes(s));
}

/** The key fields a set of scopes grants. */
export function scopeAccess(scopes: readonly Scope[]): { allowedProfiles: '*'; readOnly: boolean; canManageProfiles: boolean } {
  return {
    allowedProfiles: '*',
    readOnly: !scopes.includes('profiles:write'),
    canManageProfiles: scopes.includes('profiles:manage'),
  };
}
