import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Command } from 'commander';
import type { AgentioPlugin, CommandInput } from '../../src/plugin-sdk';
import { loadVault } from '../../src/vault/vault';
import { addProfileFromPlugin } from '../../src/plugins/profile-host';
import { executeDeclarativeCommand, registerDeclarativePlugin } from '../../src/plugins/declarative';
import { loadExternalPlugins } from '../../src/plugins/external-loader';
import { PluginRegistry } from '../../src/plugins/plugin-registry';
import { registerProfileCommands } from '../../src/commands/profile';
import { withTempVault } from '../helpers/vault';

interface Credentials {
  token: string;
}

function testPlugin(run: (input: CommandInput) => Promise<unknown> = async () => ({ ok: true })): AgentioPlugin<Credentials> {
  return {
    apiVersion: 1,
    id: 'acme-tasks',
    displayName: 'Acme Tasks',
    description: 'Manage Acme tasks',
    profile: {
      async setup() {
        return { credentials: { token: 'secret' }, suggestedProfileName: 'work' };
      },
      async validate() {
        return { valid: true };
      },
    },
    commands: [{
      path: 'tasks get',
      description: 'Get a task',
      arguments: [{ name: 'id', description: 'Task id', required: true }],
      options: [{ flags: '--upper', description: 'Uppercase output' }],
      access: 'read',
      examples: ['agentio acme-tasks tasks get 42'],
      run,
    }],
  };
}

withTempVault('agentio-declarative-plugin-', () => ({
  config: { profiles: { 'acme-tasks': [{ name: 'locked', readOnly: true }] } },
  credentials: { 'acme-tasks': { locked: { token: 'stored' } } },
}));

afterEach(() => {
  delete process.env.AGENTIO_SAFE_MODE;
});

describe('declarative plugins', () => {
  test('renders nested commands and host-owned common options', () => {
    const program = new Command();
    registerDeclarativePlugin(program, testPlugin());

    const root = program.commands.find((command) => command.name() === 'acme-tasks')!;
    const tasks = root.commands.find((command) => command.name() === 'tasks')!;
    const get = tasks.commands.find((command) => command.name() === 'get')!;
    expect(get.description()).toBe('Get a task');
    expect(get.options.map((option) => option.long)).toContain('--profile');
    expect(get.options.map((option) => option.long)).toContain('--json');
    expect(root.commands.find((command) => command.name() === 'profile')?.commands.map((command) => command.name())).toContain('add');
  });

  test('projects profile-capable external plugins into the global profile command', () => {
    const registry = new PluginRegistry([testPlugin()]);
    const program = new Command();
    registerProfileCommands(program, registry);
    const profile = program.commands.find((command) => command.name() === 'profile')!;
    const add = profile.commands.find((command) => command.name() === 'add')!;
    expect(add.registeredArguments[0].description).toContain('acme-tasks');
  });

  test('passes parsed command input to the handler', async () => {
    let received: CommandInput | undefined;
    const plugin = testPlugin(async (input) => {
      received = input;
      return { id: input.args.id };
    });
    const program = new Command().exitOverride();
    registerDeclarativePlugin(program, { ...plugin, profile: undefined });
    await program.parseAsync(['node', 'test', 'acme-tasks', 'tasks', 'get', '42', '--upper']);

    expect(received?.args).toEqual({ id: '42' });
    expect(received?.options).toMatchObject({ upper: true });
  });

  test('persists setup results in the host, not in plugin code', async () => {
    await addProfileFromPlugin(testPlugin(), { profile: 'new', readOnly: true });
    const vault = await loadVault();
    expect(vault.config.profiles['acme-tasks']).toContainEqual({ name: 'new', readOnly: true });
    expect(vault.credentials['acme-tasks']?.new).toEqual({ token: 'secret' });
  });

  test('enforces declared write access before invoking plugin code', async () => {
    let invoked = false;
    const plugin = testPlugin(async () => {
      invoked = true;
    });
    const write = { ...plugin.commands[0], access: 'write' as const };

    await expect(executeDeclarativeCommand(plugin, write, { args: {}, options: {} }, { profile: 'locked' }))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(invoked).toBe(false);
  });

  test('loads only declarative exports from explicitly supplied paths', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentio-external-plugin-'));
    const valid = join(directory, 'valid.ts');
    const unsafe = join(directory, 'unsafe.ts');
    await writeFile(valid, `export default { apiVersion: 1, id: 'acme-demo', displayName: 'Demo', description: 'Demo plugin', commands: [] };`);
    await writeFile(unsafe, `export default { apiVersion: 1, id: 'unsafe', displayName: 'Unsafe', description: 'Unsafe plugin', registerCommands() {} };`);
    try {
      const loaded = await loadExternalPlugins(valid);
      expect(loaded.map((plugin) => plugin.id)).toEqual(['acme-demo']);
      expect(new PluginRegistry(loaded).find('acme-demo')).toBeDefined();
      await expect(loadExternalPlugins(unsafe)).rejects.toThrow(/declarative Agentio plugin contract/);
      process.env.AGENTIO_SAFE_MODE = '1';
      expect(await loadExternalPlugins(valid)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('declarative plugins: profile add', () => {
  const vault = withTempVault('agentio-declarative-add-', () => ({ config: { profiles: {} } as never }));

  async function cliWithPlugin(source: string, args: string[]) {
    const directory = await mkdtemp(join(tmpdir(), 'agentio-external-plugin-'));
    const path = join(directory, 'plugin.ts');
    await writeFile(path, source);
    try {
      const proc = Bun.spawn(['bun', 'run', 'src/index.ts', ...args], {
        stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...vault.env(), AGENTIO_PLUGIN_PATHS: path },
      });
      const timer = setTimeout(() => proc.kill(), 30_000);
      const exit = await proc.exited;
      clearTimeout(timer);
      return { exit, stdout: await new Response(proc.stdout).text(), stderr: await new Response(proc.stderr).text() };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  const plugin = `export default {
    apiVersion: 1, id: 'acme-add', displayName: 'Acme', description: 'Acme',
    profile: { async setup() { return { credentials: { token: 't' }, suggestedProfileName: 'x' }; }, async validate() { return { valid: true }; } },
    commands: [],
  };`;

  test('runs the plugin setup in the terminal and the host saves it under the suggested name', async () => {
    const res = await cliWithPlugin(plugin, ['acme-add', 'profile', 'add', '--read-only']);
    expect(res.exit).toBe(0);
    expect(res.stdout).toContain('Profile "x" configured!');
    const saved = await loadVault();
    expect(saved.config.profiles['acme-add']).toEqual([{ name: 'x', readOnly: true }]);
    expect(saved.credentials['acme-add']?.x).toEqual({ token: 't' });
  }, 30_000);

  test('the program-facing setup options are gone: --describe and --json are unknown, nothing is saved', async () => {
    for (const flag of ['--describe', '--json']) {
      const res = await cliWithPlugin(plugin, ['acme-add', 'profile', 'add', flag]);
      expect(res.exit).not.toBe(0);
      expect(res.stderr).toContain(`unknown option '${flag}'`);
    }
    expect((await loadVault()).config.profiles['acme-add'] ?? []).toEqual([]);
  }, 30_000);
});
