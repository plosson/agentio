import type { Command } from 'commander';
import { handleError } from '../../utils/errors';
import { addGoogleProfiles } from './group';
import { GOOGLE_SUITE } from './suite';

/** Comma-separated services, as typed: spaces and empty parts dropped. */
export function parseServiceList(value: string): string[] {
  return value.split(',').map((part) => part.trim()).filter(Boolean);
}

/**
 * `agentio google profile add`: several Google services, one consent. Hidden,
 * so agents keep using one service per command.
 */
export function registerGoogleCommands(program: Command): void {
  const google = program
    .command('google', { hidden: true })
    .description('Set up several Google services with one consent');

  google
    .command('profile')
    .description('Manage profiles across Google services')
    .command('add')
    .description('Add one profile per Google service, from a single consent')
    .option('--services <list>', `Comma-separated services (${GOOGLE_SUITE.map((e) => e.service).join(',')})`, parseServiceList)
    .option('--profile <name>', 'Profile name for every service (default: the account email)')
    .option('--read-only', 'Create read-only profiles; Drive gets read-only access')
    .option('--force', 'Replace existing profiles with the same name without asking')
    .action(async (options: { services?: string[]; profile?: string; readOnly?: boolean; force?: boolean }) => {
      try {
        await addGoogleProfiles(options);
      } catch (error) {
        handleError(error);
      }
    });
}
