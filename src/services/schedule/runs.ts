import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

export interface RunEntry {
  file: string;
  path: string;
  startedAt?: string;
  endedAt?: string;
  status?: string;
  exitCode?: number;
  durationMs?: number;
  sessionId?: string;
}

export function listRuns(folder: string, id: string): RunEntry[] {
  const dir = join(folder, '.agentio', 'runs', id);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.log'))
    .sort()
    .reverse();
  return files.map((file) => {
    const path = join(dir, file);
    const entry: RunEntry = { file, path };
    try {
      const raw = readFileSync(path, 'utf-8');
      const lines = raw.trim().split('\n');
      const last = lines[lines.length - 1];
      const obj = JSON.parse(last);
      if (obj.type === 'summary') {
        entry.status = obj.status;
        entry.exitCode = obj.exitCode;
        entry.durationMs = obj.durationMs;
        entry.sessionId = obj.sessionId;
        entry.startedAt = obj.startedAt;
        entry.endedAt = obj.endedAt;
      }
    } catch { /* ignore */ }
    return entry;
  });
}
