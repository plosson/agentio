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
    const missing = SERVICE_PLUGINS.filter((plugin) => plugin.profile?.add).filter((plugin) => {
      const service = program.commands.find((command) => command.name() === plugin.id);
      const profile = service?.commands.find((command) => command.name() === 'profile');
      return !profile?.commands.some((command) => command.name() === 'add');
    });

    expect(missing.map((plugin) => plugin.id)).toEqual([]);
  });

  test('exposes profile hooks only for authenticated plugins', () => {
    expect(findServicePlugin('rss')?.profile).toBeUndefined();
    expect(findServicePlugin('slack')?.profile?.createClient).toBeFunction();
    expect(findServicePlugin('gmail')?.profile?.reauthenticate).toBeFunction();
    expect(findServicePlugin('gslides')?.profile?.reauthenticate).toBeFunction();
    expect(findServicePlugin('jira')?.credentialLifecycle?.secretFields).toEqual(['refreshToken']);
    expect(findServicePlugin('jira')?.profile?.reauthenticate).toBeFunction();
    expect(findServicePlugin('confluence')?.profile?.reauthenticate).toBeFunction();
    expect(findServicePlugin('dropbox')?.profile?.reauthenticate).toBeFunction();
    expect(findServicePlugin('github')?.profile?.reauthenticate).toBeFunction();
    expect(findServicePlugin('revolut')?.profile?.reauthenticate).toBeFunction();
    expect(findServicePlugin('falco')?.profile?.reauthenticate).toBeFunction();
    expect(findServicePlugin('falco')?.credentialLifecycle?.secretFields).toEqual(['refreshToken']);
    expect(findServicePlugin('missing')).toBeUndefined();
  });

  test('exposes plugin lifecycle hooks to credential management without loading commands', () => {
    expect(findCredentialLifecycle('gmail')).toBe(googleSnakeCredentialLifecycle);
    expect(findCredentialLifecycle('gdocs')).toBe(googleCamelCredentialLifecycle);
    expect(findCredentialLifecycle('jira')).toBe(jiraCredentialLifecycle);
    expect(findCredentialLifecycle('confluence')).toBe(findServicePlugin('confluence')?.credentialLifecycle);
    expect(findCredentialLifecycle('dropbox')).toBe(findServicePlugin('dropbox')?.credentialLifecycle);
    expect(findCredentialLifecycle('revolut')).toBe(findServicePlugin('revolut')?.credentialLifecycle);
    expect(findCredentialLifecycle('falco')).toBe(findServicePlugin('falco')?.credentialLifecycle);
    expect(findCredentialLifecycle('slack')).toBeUndefined();
  });
});
