import { CliError } from './errors';

/** An option given blank is refused; a value is trimmed, and an absent option stays absent. */
export function optionalText(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) return undefined;
  if (!value.trim()) throw new CliError('INVALID_PARAMS', `${flag} cannot be empty`);
  return value.trim();
}
