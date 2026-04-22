/**
 * Parses a human-readable duration string like "30m", "2h", "1h30m".
 * Returns minutes. Throws on invalid input or zero total.
 */
export function parseDuration(input: string): number {
  if (!input) throw new Error('Duration is empty');
  const match = input.trim().match(/^(?:(\d+)h)?(?:(\d+)m)?$/);
  if (!match || (match[1] === undefined && match[2] === undefined)) {
    throw new Error(`Invalid duration: "${input}" (expected e.g. "30m", "2h", "1h30m")`);
  }
  const hours = match[1] ? parseInt(match[1], 10) : 0;
  const mins = match[2] ? parseInt(match[2], 10) : 0;
  const total = hours * 60 + mins;
  if (total <= 0) throw new Error(`Duration must be > 0: "${input}"`);
  return total;
}
