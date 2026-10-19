import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Command } from 'commander';
import { createProgram } from '../../src/cli';
import { registerGmailCommands } from '../../src/plugins/google/gmail/commands';
import { registerSpotifyCommands } from '../../src/plugins/spotify/commands';
import { DEFAULT_PLUGIN_REGISTRY } from '../../src/plugins/registry';
import * as clientFactory from '../../src/utils/client-factory';

/**
 * Commander gives an option to the parent command when both a parent and its
 * subcommand define it (unless positional options are enabled). A subcommand
 * that reads `options.profile` then sees undefined, and multi-profile users get
 * "Multiple <service> profiles exist" even though they passed --profile.
 */

class StopParse extends Error {}

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  while (spies.length) spies.pop()!.mockRestore();
});

/** Parse argv against the real program and capture the profile handed to requireProfile. */
async function captureProfile(argv: string[]): Promise<string | undefined> {
  let captured: string | undefined = 'NOT_CALLED';
  spies.push(
    spyOn(clientFactory, 'requireProfile').mockImplementation(async (_service, profileName) => {
      captured = profileName;
      throw new StopParse('stop');
    }),
  );
  spies.push(
    spyOn(process, 'exit').mockImplementation(((): never => {
      throw new StopParse('exit');
    }) as typeof process.exit),
  );
  spies.push(spyOn(console, 'error').mockImplementation(() => {}));
  spies.push(spyOn(console, 'log').mockImplementation(() => {}));

  // Only the plugin's commands, so the CLI's vault/gating preAction hook (and
  // whatever state other test files left behind) cannot stop the parse first.
  const program = new Command('agentio');
  registerGmailCommands(program);
  registerSpotifyCommands(program);
  program.exitOverride();
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    if (!(error instanceof StopParse)) throw error;
  }
  return captured;
}

describe('subcommands whose parent defines the same option', () => {
  test('gmail draft delete honours --profile after the subcommand', async () => {
    expect(await captureProfile(['gmail', 'draft', 'delete', 'r-1', '--profile', 'a@example.com']))
      .toBe('a@example.com');
  });

  test('gmail draft delete honours --profile before the subcommand', async () => {
    expect(await captureProfile(['gmail', 'draft', '--profile', 'a@example.com', 'delete', 'r-1']))
      .toBe('a@example.com');
  });

  test('gmail draft (create) still honours --profile', async () => {
    expect(await captureProfile(['gmail', 'draft', '--profile', 'a@example.com', '--to', 'x@example.com', '--subject', 's', '--body', 'b']))
      .toBe('a@example.com');
  });

  test('spotify player queue add honours --profile', async () => {
    expect(await captureProfile(['spotify', 'player', 'queue', 'add', 'spotify:track:4uLU6hMCjMI75M1A2tKUQC', '--profile', 'me']))
      .toBe('me');
  });

  test('no new parent/child option collisions beyond the known, handled ones', () => {
    const program = createProgram(DEFAULT_PLUGIN_REGISTRY);
    const collisions: string[] = [];
    const walk = (cmd: Command, path: string, inherited: Set<string>) => {
      for (const sub of cmd.commands) {
        const subPath = `${path} ${sub.name()}`.trim();
        const own = sub.options.map((o) => o.long ?? o.short ?? '');
        for (const flag of own) if (inherited.has(flag)) collisions.push(`${subPath} ${flag}`);
        walk(sub, subPath, new Set([...inherited, ...own]));
      }
    };
    walk(program, '', new Set(program.options.map((o) => o.long ?? o.short ?? '')));
    // Each entry here must read the option via cmd.optsWithGlobals() and have a parse test above.
    expect(collisions.sort()).toEqual([
      'gmail draft delete --profile',
      'spotify player queue add --profile',
    ]);
  });
});
