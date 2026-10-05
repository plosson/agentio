import { CliError } from '../../utils/errors';
import type { SecretsCredentials } from './types';

export const SERVICE = 'secrets';

/** A name `exec` can export: letters, digits and _, not starting with a digit. */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new CliError(
      'INVALID_PARAMS',
      `Invalid secret name "${key}"`,
      'Use letters, digits and _, not starting with a digit, so the name can be an environment variable',
    );
  }
}

/**
 * The stored map. A Map rather than an object, so a key such as `__proto__`
 * is kept like any other. Anything that is not a map of strings reads as no
 * secrets rather than failing every command on the profile.
 */
export function valuesOf(credentials: unknown): Map<string, string> {
  const values = (credentials as { values?: unknown } | null | undefined)?.values;
  if (!values || typeof values !== 'object' || Array.isArray(values)) return new Map();
  return new Map(Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

/** What a profile write stores. `Object.fromEntries` creates own properties, `__proto__` included. */
export function toCredentials(values: Map<string, string>): SecretsCredentials {
  return { values: Object.fromEntries(values) };
}

export function missingKeyError(profile: string, key: string, values: Map<string, string>): CliError {
  const names = [...values.keys()].sort();
  return new CliError(
    'NOT_FOUND',
    `No secret "${key}" in secrets profile "${profile}"`,
    names.length ? `Secrets in this profile: ${names.join(', ')}` : 'This profile holds no secrets yet',
  );
}
