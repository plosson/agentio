import { isDeclarativePlugin, type RegisteredServicePlugin } from './types';

const PLUGIN_ID = /^[a-z][a-z0-9-]*$/;

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
      if (byId.has(plugin.id)) throw new Error(`Duplicate service id: ${plugin.id}`);
      if (!plugin.displayName.trim()) throw new Error(`Plugin ${plugin.id} has no display name`);
      if (!plugin.description.trim()) throw new Error(`Plugin ${plugin.id} has no description`);
      const legacy = 'registerCommands' in plugin && typeof plugin.registerCommands === 'function';
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
        const paths = new Set<string>();
        for (const command of plugin.commands) {
          if (!command.path.trim()) throw new Error(`Plugin ${plugin.id} has an empty command path`);
          if (paths.has(command.path)) throw new Error(`Plugin ${plugin.id} has duplicate command path: ${command.path}`);
          if (!command.description.trim()) throw new Error(`Plugin ${plugin.id} command ${command.path} has no description`);
          if (command.examples.length === 0) throw new Error(`Plugin ${plugin.id} command ${command.path} has no examples`);
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
