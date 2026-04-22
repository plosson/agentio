import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import plist from 'plist';
import { buildPlistDict, LABEL_PREFIX, plistFileName, plistLabel } from './plist-builder';
import type { FrontmatterConfig } from '../../types/schedule';

export const LAUNCH_AGENTS_DIR = join(homedir(), 'Library', 'LaunchAgents');

export interface InstalledSchedule {
  label: string;
  plistPath: string;
  id: string;
  folder: string;
}

function parseProgramArgs(args: string[]): { id: string; folder: string } | null {
  if (args.length !== 3) return null;
  const cmd = args[2];
  const match = cmd.match(/^agentio schedule run (\S+) --folder (.+) --from-launchd$/);
  if (!match) return null;
  return { id: match[1], folder: match[2] };
}

/** Pure: read plist files from a directory. Exposed as a parameter for testing. */
export function enumerateInstalledSchedules(dir: string = LAUNCH_AGENTS_DIR): InstalledSchedule[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir).filter(
    (f) => f.startsWith(LABEL_PREFIX + '.') && f.endsWith('.plist')
  );
  const result: InstalledSchedule[] = [];
  for (const file of entries) {
    const plistPath = join(dir, file);
    try {
      const raw = readFileSync(plistPath, 'utf-8');
      const parsed = plist.parse(raw) as Record<string, unknown>;
      const args = parsed.ProgramArguments as string[] | undefined;
      const label = parsed.Label as string | undefined;
      if (!args || !label) continue;
      const info = parseProgramArgs(args);
      if (!info) continue;
      result.push({ label, plistPath, id: info.id, folder: info.folder });
    } catch {
      continue;
    }
  }
  return result;
}

export function installPlist(
  folder: string,
  id: string,
  config: FrontmatterConfig
): void {
  if (!existsSync(LAUNCH_AGENTS_DIR)) {
    mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
  }
  const path = join(LAUNCH_AGENTS_DIR, plistFileName(folder, id));
  mkdirSync(join(folder, '.agentio', 'runs', id), { recursive: true });

  if (existsSync(path)) {
    try { execFileSync('/bin/launchctl', ['unload', path], { stdio: 'ignore' }); }
    catch { /* ignore */ }
  }

  const dict = buildPlistDict(folder, id, config);
  writeFileSync(path, plist.build(dict as unknown as plist.PlistObject));
  if (config.enabled) {
    try {
      execFileSync('/bin/launchctl', ['load', path], { stdio: 'ignore' });
    } catch (err) {
      try { unlinkSync(path); } catch { /* ignore */ }
      throw err;
    }
  }
}

export function uninstallPlist(folder: string, id: string): void {
  const path = join(LAUNCH_AGENTS_DIR, plistFileName(folder, id));
  try { execFileSync('/bin/launchctl', ['unload', path], { stdio: 'ignore' }); }
  catch { /* ignore */ }
  if (existsSync(path)) {
    try { unlinkSync(path); } catch { /* ignore */ }
  }
}

export function plistLabelFor(folder: string, id: string): string {
  return plistLabel(folder, id);
}
