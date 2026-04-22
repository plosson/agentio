import { readdirSync, statSync } from 'fs';
import { join } from 'path';

export interface RunFile {
  /** absolute path */
  path: string;
  /** id = basename without ".run.md" */
  id: string;
}

const SKIP_DIRS = new Set(['node_modules', '.git']);

export function walkRunFiles(root: string): RunFile[] {
  const out: RunFile[] = [];
  walk(root, root, out);
  return out;
}

function walk(root: string, dir: string, out: RunFile[]): void {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      if (full === join(root, '.agentio', 'runs')) continue;
      walk(root, full, out);
    } else if (st.isFile() && name.endsWith('.run.md')) {
      out.push({ path: full, id: name.slice(0, -'.run.md'.length) });
    }
  }
}
