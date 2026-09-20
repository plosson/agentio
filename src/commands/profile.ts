import { Command } from 'commander';
import type { ServiceName } from '../types/config';
import { ALL_SERVICES } from '../types/config';
import { listProfileRefs, resolveProfile, type ProfileRef } from '../config/config-manager';
import { handleError, CliError, multipleProfilesError } from '../utils/errors';
import { removeProfileForService, renameProfileForService } from '../utils/profile-commands';
import { reauthProfile } from './reauth';
import { githubProfileAdd } from './github';
import { confluenceProfileAdd } from './confluence';
import { telegramProfileAdd } from './telegram';
import { discourseProfileAdd } from './discourse';
import { dropboxProfileAdd } from './dropbox';
import { revolutProfileAdd } from './revolut';
import { sqlProfileAdd } from './sql';
import { findServicePlugin } from '../plugins/registry';

export type ProfileSummary = ProfileRef;

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

const KNOWN_SERVICES = ALL_SERVICES;

function assertKnownService(service: string): asserts service is ServiceName {
  if (!KNOWN_SERVICES.includes(service as ServiceName)) {
    throw new CliError(
      'INVALID_PARAMS',
      `Unknown service: "${service}"`,
      `Known services: ${KNOWN_SERVICES.join(', ')}`,
    );
  }
}

type AddOpts = { profile?: string; readOnly?: boolean };

const ADD_HANDLERS: Partial<Record<ServiceName, (opts: AddOpts) => Promise<void>>> = {
  github: githubProfileAdd,
  confluence: confluenceProfileAdd,
  telegram: telegramProfileAdd,
  revolut: revolutProfileAdd,
  discourse: discourseProfileAdd,
  dropbox: dropboxProfileAdd,
  sql: sqlProfileAdd,
};

export function registerProfileCommands(program: Command): void {
  const profile = program
    .command('profile')
    .description('Manage profiles across services');

  profile
    .command('list')
    .argument('[service]', 'Limit to one service (e.g. gmail, slack)')
    .description('List configured profiles')
    .action(async (service?: string) => {
      try {
        if (service) assertKnownService(service);
        const refs = await listProfileRefs();
        console.log(formatProfileList(service ? refs.filter((r) => r.service === service) : refs));
      } catch (e) {
        handleError(e);
      }
    });

  profile
    .command('add')
    .argument('<service>', `Service name (${KNOWN_SERVICES.join(', ')})`)
    .description('Add a profile for a service')
    .option('--profile <name>', 'Profile name')
    .option('--read-only', 'Create as read-only profile (blocks write operations)')
    .action(async (service: string, opts: { profile?: string; readOnly?: boolean }) => {
      try {
        assertKnownService(service);
        const add = findServicePlugin(service)?.profile?.add ?? ADD_HANDLERS[service];
        if (!add) throw new Error(`No profile setup registered for ${service}`);
        await add(opts);
      } catch (e) {
        handleError(e);
      }
    });

  profile
    .command('rename')
    .argument('<service>', `Service name (${KNOWN_SERVICES.join(', ')})`)
    .argument('<name>', 'Current profile name')
    .argument('<new-name>', 'New profile name')
    .description('Rename a profile, keeping its credentials and key access')
    .action(async (service: string, name: string, newName: string) => {
      try {
        assertKnownService(service);
        await renameProfileForService(service as ServiceName, name, newName);
      } catch (e) {
        handleError(e);
      }
    });

  profile
    .command('remove')
    .argument('<service>', `Service name (${KNOWN_SERVICES.join(', ')})`)
    .argument('<name>', 'Profile name to remove')
    .description('Remove a profile')
    .action(async (service: string, name: string) => {
      try {
        assertKnownService(service);
        await removeProfileForService(service as ServiceName, name);
      } catch (e) {
        handleError(e);
      }
    });

  profile
    .command('reauth')
    .argument('<service>', `Service name (${KNOWN_SERVICES.join(', ')})`)
    .argument('[name]', 'Profile name (auto-resolves if exactly one exists)')
    .description('Re-authenticate an expired or invalid profile')
    .action(async (service: string, name: string | undefined) => {
      try {
        assertKnownService(service);
        const resolved = await resolveProfile(service, name);
        if (resolved.profile === null) {
          if (resolved.error === 'none') {
            throw new CliError(
              'PROFILE_NOT_FOUND',
              name ? `Profile "${name}" not found for ${service}` : `No profiles configured for ${service}`,
              `Add one with: agentio profile add ${service}`
            );
          } else {
            throw multipleProfilesError(service, resolved.names);
          }
        }
        await reauthProfile(service, resolved.profile);
      } catch (e) {
        handleError(e);
      }
    });
}
