import { CliError } from './errors';

/** An option given blank is refused; a value is trimmed, and an absent option stays absent. */
export function optionalText(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) return undefined;
  if (!value.trim()) throw new CliError('INVALID_PARAMS', `${flag} cannot be empty`);
  return value.trim();
}

/** `--since` / `--until`: refuse a date that does not parse instead of sending "Invalid Date" to the API. */
export function parseDateOption(value: string | undefined, flag: string): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new CliError('INVALID_PARAMS', `Invalid ${flag} date: ${value}`, 'Use YYYY-MM-DD or an ISO 8601 timestamp');
  }
  return date;
}
