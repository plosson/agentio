import { isDeclarativePlugin, isLegacyServicePlugin, type RegisteredServicePlugin } from './types';

const PLUGIN_ID = /^[a-z][a-z0-9-]*$/;
const RESERVED_PLUGIN_IDS = new Set([
  'config', 'daemon', 'docs', 'doctor', 'key', 'login', 'logout', 'plugin',
  'profile', 'reauth', 'setup', 'skill', 'status', 'update', 'vault',
]);

/** A validated, ordered plugin catalog independent of how plugins were loaded. */
export class PluginRegistry {
  readonly plugins: readonly RegisteredServicePlugin[];
  private readonly byId: ReadonlyMap<string, RegisteredServicePlugin>;

  constructor(plugins: readonly RegisteredServicePlugin[]) {
    const byId = new Map<string, RegisteredServicePlugin>();

    for (const plugin of plugins) {
      if (!plugin || typeof plugin !== 'object') throw new Error('Invalid service plugin export');
      if (plugin.apiVersion !== 1) {
        throw new Error(`Unsupported plugin API version for ${plugin.id || '<unknown>'}: ${String(plugin.apiVersion)}`);
      }
      if (!PLUGIN_ID.test(plugin.id)) throw new Error(`Invalid service id: ${plugin.id}`);
      if (RESERVED_PLUGIN_IDS.has(plugin.id)) throw new Error(`Service id is reserved by Agentio: ${plugin.id}`);
      if (byId.has(plugin.id)) throw new Error(`Duplicate service id: ${plugin.id}`);
      if (!plugin.displayName.trim()) throw new Error(`Plugin ${plugin.id} has no display name`);
      if (!plugin.description.trim()) throw new Error(`Plugin ${plugin.id} has no description`);
      const legacy = isLegacyServicePlugin(plugin) && typeof plugin.registerCommands === 'function';
      const declarative = isDeclarativePlugin(plugin) && Array.isArray(plugin.commands);
      if (!legacy && !declarative) {
        throw new Error(`Plugin ${plugin.id} has no commands`);
      }
      const lifecycle = !isDeclarativePlugin(plugin)
        ? plugin.credentialLifecycle
        : plugin.profile?.refresh
          ? {
              ...plugin.profile.refresh,
              refresh: plugin.profile.refresh.run,
            }
          : undefined;
      if (lifecycle && lifecycle.secretFields.length === 0) {
        throw new Error(`Refreshable plugin ${plugin.id} must declare secret fields`);
      }
      if (isDeclarativePlugin(plugin)) {
        if (plugin.profile && (typeof plugin.profile.setup !== 'function' || typeof plugin.profile.validate !== 'function')) {
          throw new Error(`Plugin ${plugin.id} has an invalid profile contract`);
        }
        const paths = new Set<string>();
        for (const command of plugin.commands) {
          if (!command || typeof command !== 'object' || typeof command.path !== 'string' || !command.path.trim()) {
            throw new Error(`Plugin ${plugin.id} has an empty command path`);
          }
          const segments = command.path.trim().split(/\s+/);
          if (segments.some((segment) => !PLUGIN_ID.test(segment))) {
            throw new Error(`Plugin ${plugin.id} has an invalid command path: ${command.path}`);
          }
          if (segments[0] === 'profile') throw new Error(`Plugin ${plugin.id} command path "profile" is reserved`);
          if (paths.has(command.path)) throw new Error(`Plugin ${plugin.id} has duplicate command path: ${command.path}`);
          if (typeof command.description !== 'string' || !command.description.trim()) {
            throw new Error(`Plugin ${plugin.id} command ${command.path} has no description`);
          }
          if (!Array.isArray(command.examples) || command.examples.length === 0) {
            throw new Error(`Plugin ${plugin.id} command ${command.path} has no examples`);
          }
          if (typeof command.run !== 'function') throw new Error(`Plugin ${plugin.id} command ${command.path} has no handler`);
          for (const option of command.options ?? []) {
            if (typeof option.flags !== 'string' || !/(?:^|[, ]+)--[a-z][a-z0-9-]*/.test(option.flags)) {
              throw new Error(`Plugin ${plugin.id} command ${command.path} has invalid option flags: ${String(option.flags)}`);
            }
            if (/(?:^|[, ]+)--(?:profile|json)(?:[, =]|$)/.test(option.flags)) {
              throw new Error(`Plugin ${plugin.id} command ${command.path} redeclares host option: ${option.flags}`);
            }
          }
          const argumentNames = new Set<string>();
          let optionalSeen = false;
          for (const argument of command.arguments ?? []) {
            if (!PLUGIN_ID.test(argument.name) || argumentNames.has(argument.name)) {
              throw new Error(`Plugin ${plugin.id} command ${command.path} has an invalid or duplicate argument: ${argument.name}`);
            }
            if (!argument.required) optionalSeen = true;
            if (argument.required && optionalSeen) {
              throw new Error(`Plugin ${plugin.id} command ${command.path} has a required argument after an optional argument`);
            }
            argumentNames.add(argument.name);
          }
          paths.add(command.path);
        }
      }
      byId.set(plugin.id, plugin);
    }

    this.plugins = Object.freeze([...plugins]);
    this.byId = byId;
  }

  find(id: string): RegisteredServicePlugin | undefined {
    return this.byId.get(id);
  }

  profilePlugins(): readonly RegisteredServicePlugin[] {
    return this.plugins.filter((plugin) => plugin.profile !== undefined);
  }
}
