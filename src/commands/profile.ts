import { Command } from 'commander';
import type { ServiceName } from '../types/config';
import { listProfiles } from '../config/config-manager';
import { handleError } from '../utils/errors';

export interface ProfileSummary {
  service: ServiceName;
  name: string;
  readOnly?: boolean;
}

export function formatProfileList(summaries: ProfileSummary[]): string {
  if (summaries.length === 0) {
    return 'No profiles configured.\nAdd one with: agentio profile add <service>';
  }
  const byService = new Map<ServiceName, ProfileSummary[]>();
  for (const s of summaries) {
    const arr = byService.get(s.service) ?? [];
    arr.push(s);
    byService.set(s.service, arr);
  }
  const lines: string[] = [];
  for (const [svc, profiles] of byService) {
    lines.push(`${svc}:`);
    for (const p of profiles) {
      const ro = p.readOnly ? ' [read-only]' : '';
      lines.push(`  ${p.name}${ro}`);
    }
  }
  return lines.join('\n');
}

export function registerProfileCommands(program: Command): void {
  const profile = program
    .command('profile')
    .description('Manage profiles across services');

  profile
    .command('list')
    .argument('[service]', 'Limit to one service (e.g. gmail, slack)')
    .description('List configured profiles')
    .action(async (service?: ServiceName) => {
      try {
        const result = await listProfiles(service);
        const summaries: ProfileSummary[] = [];
        for (const r of result) {
          for (const p of r.profiles) {
            summaries.push({ service: r.service, name: p.name, readOnly: p.readOnly });
          }
        }
        console.log(formatProfileList(summaries));
      } catch (e) {
        handleError(e);
      }
    });
}
