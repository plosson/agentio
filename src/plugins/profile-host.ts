import type { Command } from 'commander';
import { chooseProfileName, saveProfile } from '../config/profile-store';
import type { ProfileAddOptions } from './types';
import { createJsonSetupContext, createSetupContext } from './host-context';
import type { RegisteredServicePlugin } from './types';
import { readInputs } from './setup-inputs';
import { findServicePlugin } from './registry';
import type { SetupContext, SetupNeeds, SetupResult } from '../plugin-sdk';
import { addJsonOption, isJsonMode, printJson } from '../utils/output';
import { createLineReader } from '../utils/line-reader';
import { CliError } from '../utils/errors';

/** `profile add` options of the program-facing modes. */
export interface SetupCommandOptions extends ProfileAddOptions {
  describe?: boolean;
  input?: string;
}

/** Add `--describe`, `--input` and `--json` to a service's `profile add` command. */
export function addSetupOptions(cmd: Command): Command {
  cmd.option('--describe', 'With --json: print what setup needs, then exit');
  cmd.option('--input <source>', 'With --json: read the setup values as one JSON object from stdin (-)');
  return addJsonOption(cmd, 'Print setup as JSON events (needs, code, open, ask, added); answer questions on stdin');
}

/**
 * The name a new profile gets: `--profile` when given, else `derived`, made
 * unique the same way for every service. For a plugin that stores its
 * profiles itself, such as through the daemon's pairing.
 */
export function newProfileName(service: string, options: ProfileAddOptions, derived: string): Promise<string> {
  return chooseProfileName(service, { explicit: options.profile, derived, readOnly: options.readOnly });
}

async function persistSetupResult<TCredentials extends object>(
  service: string,
  result: SetupResult<TCredentials>,
  options: ProfileAddOptions,
): Promise<string> {
  const profileName = await newProfileName(service, options, result.suggestedProfileName);
  await saveProfile(service, profileName, result.credentials, { readOnly: options.readOnly });
  console.log(`Profile "${profileName}" configured!`);
  if (result.info) console.log(result.info);
  if (options.readOnly) console.log('Access: read-only');
  return profileName;
}

function cannotRunAsJson(service: string): CliError {
  return new CliError('INVALID_PARAMS', `${service} cannot be set up with --json yet`, `Run: agentio ${service} profile add`);
}

/**
 * Run a plugin's setup in the mode its options ask for: `--describe` prints its needs; `--json` runs it
 * for a program (events on stdout, values and answers on stdin); otherwise it runs in the terminal.
 */
async function runProfileSetup<TCredentials extends object>(
  service: string,
  setup: (options: ProfileAddOptions, context: SetupContext) => Promise<SetupResult<TCredentials>>,
  options: SetupCommandOptions,
  needs?: SetupNeeds,
): Promise<void> {
  if (options.describe) {
    if (!isJsonMode()) throw new CliError('INVALID_PARAMS', '--describe needs --json');
    if (!needs) throw cannotRunAsJson(service);
    printJson({ event: 'needs', service, inputs: needs.inputs, auth: needs.auth });
    return;
  }
  if (!isJsonMode()) {
    await persistSetupResult(service, await setup(options, createSetupContext()), options);
    return;
  }
  if (!needs) throw cannotRunAsJson(service);
  if (options.input !== undefined && options.input !== '-') throw new CliError('INVALID_PARAMS', '--input takes - (stdin)');
  const lines = createLineReader(process.stdin);
  try {
    const given = options.input === '-' ? readInputs(await lines.next(), needs) : {};
    const result = await setup(options, createJsonSetupContext(given, lines));
    const profile = await persistSetupResult(service, result, options);
    printJson({ event: 'added', service, profile, readOnly: Boolean(options.readOnly) });
  } finally {
    // Stop reading stdin, so the process exits once the profile is saved.
    lines.close();
    process.stdin.pause();
  }
}

/**
 * Run `<service> profile add` in the mode its options ask for, with the needs the plugin declares:
 * the hub page, AgentIO Companion and this command read the same declaration.
 */
export function addProfileWithSetup<TCredentials extends object>(
  service: string,
  setup: (options: ProfileAddOptions, context: SetupContext) => Promise<SetupResult<TCredentials>>,
  options: SetupCommandOptions,
): Promise<void> {
  // Read when the command runs, not when this module loads: the registry imports every plugin, and
  // every plugin's commands import this module.
  return runProfileSetup(service, setup, options, findServicePlugin(service)?.profile?.needs);
}

/** Run plugin-owned authentication, then let the host name and persist it. */
export async function addProfileFromPlugin(
  plugin: RegisteredServicePlugin,
  options: SetupCommandOptions,
): Promise<void> {
  if (!plugin.profile) throw new Error(`No profile setup registered for ${plugin.id}`);
  const profile = plugin.profile;
  // The spread gives declarative plugins the open-ended options their setup takes.
  await runProfileSetup(plugin.id, (o, context) => profile.setup({ ...o }, context), options, profile.needs);
}

/**
 * Replace an existing profile's credentials, locally or on the hub, for a
 * plugin whose credentials are edited by its own commands, such as `secrets
 * set`. Plugins cannot reach `saveProfile` directly; it keeps the profile's
 * read-only flag because no options are passed.
 */
export function saveProfileCredentials(service: string, profile: string, credentials: object): Promise<void> {
  return saveProfile(service, profile, credentials);
}
