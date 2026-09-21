import { describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { ALL_SERVICES } from '../../src/types/config';
import { findCredentialLifecycle } from '../../src/plugins/credential-lifecycles';
import { jiraCredentialLifecycle } from '../../src/plugins/jira/lifecycle';
import { googleCamelCredentialLifecycle, googleSnakeCredentialLifecycle } from '../../src/plugins/google/shared';
import {
  findServicePlugin,
  registerServiceCommands,
  SERVICE_PLUGINS,
  SERVICE_REGISTRY,
} from '../../src/plugins/registry';
import { isLegacyServicePlugin, type RegisteredServicePlugin } from '../../src/plugins/types';
import { PluginRegistry } from '../../src/plugins/plugin-registry';

const SERVICE_ORDER = [
  'confluence',
  'discourse',
  'dropbox',
  'falco',
  'gcal',
  'gchat',
  'gdocs',
  'gdrive',
  'github',
  'gmail',
  'gsheets',
  'gslides',
  'gscript',
  'gtasks',
  'jira',
  'revolut',
  'rss',
  'slack',
  'sql',
  'telegram',
];

describe('service plugin registry', () => {
  test('validates external catalogs at runtime', () => {
    const valid = {
      apiVersion: 1 as const,
      id: 'acme-linear',
      displayName: 'Linear',
      description: 'Work with Linear issues',
      registerCommands: () => {},
    };
    expect(new PluginRegistry([valid]).find('acme-linear')).toBe(valid);
    expect(() => new PluginRegistry([{ ...valid, id: 'Bad Id' }])).toThrow(/Invalid service id/);
    expect(() => new PluginRegistry([valid, valid])).toThrow(/Duplicate service id/);
    expect(() => new PluginRegistry([{ ...valid, apiVersion: 2 as 1 }])).toThrow(/Unsupported plugin API version/);
  });
  test('is the complete, ordered service catalog', () => {
    const ids: string[] = SERVICE_REGISTRY.map((service) => service.id);

    expect(ids).toEqual(SERVICE_ORDER);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...ALL_SERVICES, 'rss'].sort());
  });

  test('contains convention-compliant migrated plugins', () => {
    const ids: string[] = SERVICE_PLUGINS.map((plugin) => plugin.id);
    expect(ids).toEqual(SERVICE_ORDER);
    for (const plugin of SERVICE_PLUGINS) {
      expect(plugin.apiVersion).toBe(1);
      expect(plugin.displayName.length).toBeGreaterThan(0);
      expect(plugin.description.length).toBeGreaterThan(0);
    }
  });

  test('registers every service command exactly once in catalog order', () => {
    const program = new Command();
    registerServiceCommands(program);

    expect(program.commands.map((command) => command.name())).toEqual(SERVICE_ORDER);
  });

  test('every profile-backed plugin registers its own `profile add` command', () => {
    const program = new Command();
    registerServiceCommands(program);

    // The host's global `profile add <service>` dispatches to the plugin hook,
    // but each service must also surface `agentio <service> profile add`.
    // The catalog is a const tuple, so widen to the host's own erased view
    // before reaching for optional hooks.
    const plugins: readonly RegisteredServicePlugin[] = SERVICE_REGISTRY;
    const missing = plugins.filter(isLegacyServicePlugin).filter((plugin) => plugin.profile?.setup).filter((plugin) => {
      const service = program.commands.find((command) => command.name() === plugin.id);
      const profile = service?.commands.find((command) => command.name() === 'profile');
      return !profile?.commands.some((command) => command.name() === 'add');
    });

    expect(missing.map((plugin) => plugin.id)).toEqual([]);
  });

  test('exposes profile hooks only for authenticated plugins', () => {
    const slack = findServicePlugin('slack');
    const jira = findServicePlugin('jira');
    const falco = findServicePlugin('falco');
    expect(findServicePlugin('rss')?.profile).toBeUndefined();
    expect(slack && isLegacyServicePlugin(slack) && slack.profile?.createClient).toBeFunction();
    for (const id of ['gmail', 'gslides', 'jira', 'confluence', 'dropbox', 'github', 'revolut', 'falco']) {
      const plugin = findServicePlugin(id);
      expect(plugin?.profile?.reauthenticate).toBeFunction();
    }
    expect(jira && isLegacyServicePlugin(jira) ? jira.credentialLifecycle?.secretFields : undefined).toEqual(['refreshToken']);
    expect(falco && isLegacyServicePlugin(falco) ? falco.credentialLifecycle?.secretFields : undefined).toEqual(['refreshToken']);
    expect(findServicePlugin('missing')).toBeUndefined();
  });

  test('exposes plugin lifecycle hooks to credential management without loading commands', () => {
    const lifecycle = (id: string) => {
      const plugin = findServicePlugin(id);
      return plugin && isLegacyServicePlugin(plugin) ? plugin.credentialLifecycle : undefined;
    };
    expect(findCredentialLifecycle('gmail')).toBe(googleSnakeCredentialLifecycle);
    expect(findCredentialLifecycle('gdocs')).toBe(googleCamelCredentialLifecycle);
    expect(findCredentialLifecycle('jira')).toBe(jiraCredentialLifecycle);
    expect(findCredentialLifecycle('confluence')).toBe(lifecycle('confluence'));
    expect(findCredentialLifecycle('dropbox')).toBe(lifecycle('dropbox'));
    expect(findCredentialLifecycle('revolut')).toBe(lifecycle('revolut'));
    expect(findCredentialLifecycle('falco')).toBe(lifecycle('falco'));
    expect(findCredentialLifecycle('slack')).toBeUndefined();
  });
});
