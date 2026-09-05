import { existsSync, statSync } from 'fs';
import { isAbsolute, join } from 'path';
import { CliError } from '../utils/errors';

export const DEFAULT_VAULT_FILENAME = 'agentio.vault';

export function validateVaultPath(path: string): void {
  if (!isAbsolute(path)) {
    throw new CliError(
      'INVALID_PARAMS',
      'Vault path must be absolute',
      'Use a path like /Users/you/agentio.vault'
    );
  }
}

/**
 * If the caller passes a directory (or a path ending in /), append the default
 * filename so the vault lands inside that directory instead of trying to
 * rename over it.
 */
export function normalizeVaultPath(path: string): string {
  const trailingSlash = path.endsWith('/');
  let resolved = trailingSlash ? path.slice(0, -1) : path;
  if (existsSync(resolved)) {
    try {
      if (statSync(resolved).isDirectory()) {
        return join(resolved, DEFAULT_VAULT_FILENAME);
      }
    } catch {
      // stat failed — fall through, let downstream I/O surface the error
    }
  } else if (trailingSlash) {
    return join(resolved, DEFAULT_VAULT_FILENAME);
  }
  return resolved;
}
