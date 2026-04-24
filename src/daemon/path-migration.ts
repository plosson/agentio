import { existsSync, renameSync } from 'fs';
import { join } from 'path';

const PAIRS: [string, string][] = [
  ['gateway.db', 'daemon.db'],
  ['gateway.log', 'daemon.log'],
];

/**
 * Rename legacy gateway.* files to daemon.* in the given config dir.
 * If both exist (unusual), the new one wins and the old is left alone.
 */
export function migrateLegacyFiles(configDir: string): void {
  for (const [from, to] of PAIRS) {
    const src = join(configDir, from);
    const dst = join(configDir, to);
    if (existsSync(src) && !existsSync(dst)) {
      renameSync(src, dst);
    }
  }
}
