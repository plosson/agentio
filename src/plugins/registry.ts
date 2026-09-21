import type { Command } from 'commander';
import confluence from './confluence';
import discourse from './discourse';
import dropbox from './dropbox';
import falco from './falco';
import gcal from './google/gcal';
import gchat from './google/gchat';
import gdocs from './google/gdocs';
import gdrive from './google/gdrive';
import github from './github';
import gmail from './google/gmail';
import gsheets from './google/gsheets';
import gslides from './google/gslides';
import gscript from './google/gscript';
import gtasks from './google/gtasks';
import jira from './jira';
import revolut from './revolut';
import rss from './rss';
import slack from './slack';
import sql from './sql';
import telegram from './telegram';
import type { RegisteredServicePlugin } from './types';

/** Complete ordered catalog of in-tree service plugins. */
export const SERVICE_PLUGINS = [
  confluence,
  discourse,
  dropbox,
  falco,
  gcal,
  gchat,
  gdocs,
  gdrive,
  github,
  gmail,
  gsheets,
  gslides,
  gscript,
  gtasks,
  jira,
  revolut,
  rss,
  slack,
  sql,
  telegram,
] as const satisfies readonly RegisteredServicePlugin[];

/**
 * The canonical service order for every Agentio command tree.
 *
 * Registration remains explicit so bundled builds include every service and
 * command ordering cannot depend on filesystem traversal.
 */
export const SERVICE_REGISTRY = SERVICE_PLUGINS;

validateRegistry(SERVICE_REGISTRY);

export function registerServiceCommands(program: Command): void {
  for (const service of SERVICE_REGISTRY) {
    service.registerCommands(program);
  }
}

export function findServicePlugin(id: string): RegisteredServicePlugin | undefined {
  return SERVICE_PLUGINS.find((plugin) => plugin.id === id);
}

function validateRegistry(services: readonly RegisteredServicePlugin[]): void {
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
