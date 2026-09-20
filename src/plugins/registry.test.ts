import { describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { ALL_SERVICES } from '../types/config';
import { findCredentialLifecycle } from './credential-lifecycles';
import { jiraCredentialLifecycle } from './jira/lifecycle';
import { googleCamelCredentialLifecycle, googleSnakeCredentialLifecycle } from './google/shared';
import {
  findServicePlugin,
  registerServiceCommands,
  SERVICE_PLUGINS,
  SERVICE_REGISTRY,
} from './registry';

const SERVICE_ORDER = [
  'confluence',
  'discourse',
  'dropbox',
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
    const ids = SERVICE_REGISTRY.map((service) => service.id);

    expect(ids).toEqual(SERVICE_ORDER);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...ALL_SERVICES, 'rss'].sort());
  });

  test('contains convention-compliant migrated plugins', () => {
    expect(SERVICE_PLUGINS.map((plugin) => plugin.id)).toEqual([
      'gcal',
      'gchat',
      'gdocs',
      'gdrive',
      'gmail',
      'gsheets',
      'gslides',
      'gscript',
      'gtasks',
      'jira',
      'rss',
      'slack',
    ]);
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

  test('exposes profile hooks only for authenticated plugins', () => {
    expect(findServicePlugin('rss')?.profile).toBeUndefined();
    expect(findServicePlugin('slack')?.profile?.createClient).toBeFunction();
    expect(findServicePlugin('gmail')?.profile?.reauthenticate).toBeFunction();
    expect(findServicePlugin('gslides')?.profile?.reauthenticate).toBeFunction();
    expect(findServicePlugin('jira')?.credentialLifecycle?.secretFields).toEqual(['refreshToken']);
    expect(findServicePlugin('jira')?.profile?.reauthenticate).toBeFunction();
    expect(findServicePlugin('missing')).toBeUndefined();
  });

  test('exposes plugin lifecycle hooks to credential management without loading commands', () => {
    expect(findCredentialLifecycle('gmail')).toBe(googleSnakeCredentialLifecycle);
    expect(findCredentialLifecycle('gdocs')).toBe(googleCamelCredentialLifecycle);
    expect(findCredentialLifecycle('jira')).toBe(jiraCredentialLifecycle);
    expect(findCredentialLifecycle('slack')).toBeUndefined();
  });
});
