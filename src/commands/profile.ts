import { Command } from 'commander';
import type { ServiceName } from '../types/config';
import { ALL_SERVICES } from '../types/config';
import { listProfiles, removeProfile, resolveProfile } from '../config/config-manager';
import { handleError, CliError, multipleProfilesError } from '../utils/errors';
import { removeProfileForService } from '../utils/profile-commands';
import { reauthProfile } from './reauth';
import { gmailProfileAdd } from './gmail';
import { gdocsProfileAdd } from './gdocs';
import { gdriveProfileAdd } from './gdrive';
import { gcalProfileAdd } from './gcal';
import { gtasksProfileAdd } from './gtasks';
import { gchatProfileAdd } from './gchat';
import { gsheetsProfileAdd } from './gsheets';
import { gslidesProfileAdd } from './gslides';
import { gscriptProfileAdd } from './gscript';
import { githubProfileAdd } from './github';
import { jiraProfileAdd } from './jira';
import { confluenceProfileAdd } from './confluence';
import { slackProfileAdd } from './slack';
import { telegramProfileAdd } from './telegram';
import { discourseProfileAdd } from './discourse';
import { sqlProfileAdd } from './sql';
import { whatsappProfileAdd } from './whatsapp';

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

const ADD_HANDLERS: Record<ServiceName, (opts: AddOpts) => Promise<void>> = {
  gmail: gmailProfileAdd,
  gdocs: gdocsProfileAdd,
  gdrive: gdriveProfileAdd,
  gcal: gcalProfileAdd,
  gtasks: gtasksProfileAdd,
  gchat: gchatProfileAdd,
  gsheets: gsheetsProfileAdd,
  gslides: gslidesProfileAdd,
  gscript: gscriptProfileAdd,
  github: githubProfileAdd,
  jira: jiraProfileAdd,
  confluence: confluenceProfileAdd,
  slack: slackProfileAdd,
  telegram: telegramProfileAdd,
  whatsapp: whatsappProfileAdd,
  discourse: discourseProfileAdd,
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
        const result = await listProfiles(service as ServiceName | undefined);
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

  profile
    .command('add')
    .argument('<service>', `Service name (${KNOWN_SERVICES.join(', ')})`)
    .description('Add a profile for a service')
    .option('--profile <name>', 'Profile name')
    .option('--read-only', 'Create as read-only profile (blocks write operations)')
    .action(async (service: string, opts: { profile?: string; readOnly?: boolean }) => {
      try {
        assertKnownService(service);
        await ADD_HANDLERS[service](opts);
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
        if (service === 'whatsapp') {
          // WhatsApp auth state is in the daemon DB; only remove the profile entry
          const removed = await removeProfile('whatsapp', name);
          if (removed) {
            console.log(`Removed profile "${name}"`);
            console.log('Note: if the daemon is running, it will stop reconnecting this profile within ~30 seconds.');
          } else {
            console.error(`Profile "${name}" not found`);
          }
        } else {
          await removeProfileForService(service as ServiceName, name);
        }
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
