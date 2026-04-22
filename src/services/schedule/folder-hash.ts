/**
 * djb2 hash of a string, returned as a hex string. Matches claude-cron's label
 * hashing so behavior is consistent across both tools.
 */
export function folderHash(path: string): string {
  let hash = 5381n;
  const mask = 0xffffffffffffffffn;
  const bytes = new TextEncoder().encode(path);
  for (const b of bytes) {
    hash = ((hash * 33n) + BigInt(b)) & mask;
  }
  return hash.toString(16);
}
