/**
 * The command this CLI run is executing, for the usage store. Set once by the
 * preAction hook. The daemon never sets one: its vault reads serve remote
 * agents, and the /v1 route records those itself.
 */

let command: string | null = null;
const used = new Set<string>();

export function setUsageCommand(path: string[]): void {
  if (path[0] === 'daemon') return;
  command = path.join(' ');
}

export function usageCommand(): string | null {
  return command;
}

/** True the first time this run uses a profile: one event per profile per run. */
export function firstUse(service: string, profile: string): boolean {
  const ref = `${service}/${profile}`;
  if (used.has(ref)) return false;
  used.add(ref);
  return true;
}

export function resetUsageContext(): void {
  command = null;
  used.clear();
}
