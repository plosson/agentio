import { CliError } from '../../../utils/errors';

/**
 * Whether `name` is an IANA time zone name, such as Europe/Brussels or UTC.
 * Offsets such as +01:00 are refused: Google takes names only.
 */
export function isIanaTimeZone(name: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+)*$/.test(name)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** The --timezone value, checked as an IANA name; undefined when not given. */
export function parseTimeZone(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const name = value.trim();
  if (!isIanaTimeZone(name)) {
    throw new CliError('INVALID_PARAMS', `"${value}" is not an IANA time zone name`,
      'Use a name such as Europe/Brussels, America/New_York or UTC (not an offset like +01:00)');
  }
  return name;
}
