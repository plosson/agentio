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
import kite from './kite';
import notes from './notes';
import pagerio from './pagerio';
import pocketalert from './pocketalert';
import revolut from './revolut';
import rss from './rss';
import slack from './slack';
import spotify from './spotify';
import sql from './sql';
import whatsapp from './whatsapp';
import { isLegacyServicePlugin, type RegisteredServicePlugin, type SessionPlugin } from './types';
import { PluginRegistry } from './plugin-registry';
import { registerDeclarativePlugin } from './declarative';

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
  kite,
  notes,
  pagerio,
  pocketalert,
  revolut,
  rss,
  slack,
  spotify,
  sql,
  whatsapp,
] as const satisfies readonly RegisteredServicePlugin[];

/**
 * The canonical service order for every Agentio command tree.
 *
 * Registration remains explicit so bundled builds include every service and
 * command ordering cannot depend on filesystem traversal.
 */
export const SERVICE_REGISTRY = SERVICE_PLUGINS;

export const DEFAULT_PLUGIN_REGISTRY = new PluginRegistry(SERVICE_REGISTRY);
let activePluginRegistry = DEFAULT_PLUGIN_REGISTRY;

export function activatePluginRegistry(registry: PluginRegistry): void {
  activePluginRegistry = registry;
}

export function getPluginRegistry(): PluginRegistry {
  return activePluginRegistry;
}

export function registerServiceCommands(program: Command, registry: PluginRegistry = DEFAULT_PLUGIN_REGISTRY): void {
  for (const service of registry.plugins) {
    if (isLegacyServicePlugin(service)) service.registerCommands(program);
    else registerDeclarativePlugin(program, service);
  }
}

export function findServicePlugin(id: string): RegisteredServicePlugin | undefined {
  return activePluginRegistry.find(id);
}

/** The session capability of a registered plugin, when it has one: its profiles live in the daemon. */
export function findSessionPlugin(id: string): SessionPlugin | undefined {
  const plugin = activePluginRegistry.find(id);
  return plugin && isLegacyServicePlugin(plugin) ? plugin.session : undefined;
}
