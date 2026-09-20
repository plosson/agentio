import type { Command } from 'commander';
import { registerConfluenceCommands } from '../commands/confluence';
import { registerDiscourseCommands } from '../commands/discourse';
import { registerDropboxCommands } from '../commands/dropbox';
import { registerGitHubCommands } from '../commands/github';
import { registerRevolutCommands } from '../commands/revolut';
import { registerSqlCommands } from '../commands/sql';
import { registerTelegramCommands } from '../commands/telegram';
import gcal from './google/gcal';
import gchat from './google/gchat';
import gdocs from './google/gdocs';
import gdrive from './google/gdrive';
import gmail from './google/gmail';
import gsheets from './google/gsheets';
import gslides from './google/gslides';
import gscript from './google/gscript';
import gtasks from './google/gtasks';
import jira from './jira';
import rss from './rss';
import slack from './slack';
import type { ServicePlugin, ServiceRegistration } from './types';

function legacy(
  id: string,
  registerCommands: (program: Command) => void,
): ServiceRegistration {
  return { id, registerCommands };
}

/** Plugins whose implementation has moved into `src/plugins/<id>/`. */
export const SERVICE_PLUGINS = [
  gcal,
  gchat,
  gdocs,
  gdrive,
  gmail,
  gsheets,
  gslides,
  gscript,
  gtasks,
  jira,
  rss,
  slack,
] as const satisfies readonly ServicePlugin[];

/**
 * The canonical service order for every Agentio command tree.
 *
 * Unmigrated services use lightweight adapters. Migrating one means replacing
 * its adapter in place with its plugin object, preserving visible ordering.
 */
export const SERVICE_REGISTRY = [
  legacy('confluence', registerConfluenceCommands),
  legacy('discourse', registerDiscourseCommands),
  legacy('dropbox', registerDropboxCommands),
  gcal,
  gchat,
  gdocs,
  gdrive,
  legacy('github', registerGitHubCommands),
  gmail,
  gsheets,
  gslides,
  gscript,
  gtasks,
  jira,
  legacy('revolut', registerRevolutCommands),
  rss,
  slack,
  legacy('sql', registerSqlCommands),
  legacy('telegram', registerTelegramCommands),
] as const satisfies readonly ServiceRegistration[];

validateRegistry(SERVICE_REGISTRY);

export function registerServiceCommands(program: Command): void {
  for (const service of SERVICE_REGISTRY) {
    service.registerCommands(program);
  }
}

export function findServicePlugin(id: string): ServicePlugin | undefined {
  return SERVICE_PLUGINS.find((plugin) => plugin.id === id);
}

function validateRegistry(services: readonly ServiceRegistration[]): void {
  const ids = new Set<string>();

  for (const service of services) {
    if (!/^[a-z][a-z0-9-]*$/.test(service.id)) {
      throw new Error(`Invalid service id: ${service.id}`);
    }
    if (ids.has(service.id)) {
      throw new Error(`Duplicate service id: ${service.id}`);
    }
    ids.add(service.id);
  }

  for (const plugin of SERVICE_PLUGINS) {
    if (!ids.has(plugin.id)) {
      throw new Error(`Plugin is missing from service registry: ${plugin.id}`);
    }
  }
}
