import { Command } from 'commander';
import { createClientGetter } from '../../utils/client-factory';
import { CliError, handleError } from '../../utils/errors';
import { addExamples } from '../../utils/command-tree';
import { addJsonOption } from '../../utils/output';
import { createProfileCommands } from '../../utils/profile-commands';
import { enforceWriteAccess } from '../../utils/read-only';
import { addProfileWithSetup, addSetupOptions } from '../profile-host';
import type { SetupContext, SetupResult } from '../../plugin-sdk';
import { checkAnswer } from '../setup-inputs';
import { POCKETALERT_API_KEY_INPUT } from './setup-needs';
import type { ProfileAddOptions } from '../types';
import { parseLevel, PocketAlertClient } from './client';
import { printSentMessage } from './output';
import type { PocketAlertCredentials } from './types';

const getPocketAlertClient = createClientGetter<PocketAlertCredentials, PocketAlertClient>({
  service: 'pocketalert',
  createClient: (credentials) => new PocketAlertClient(credentials),
});

/** A non-empty option value, or undefined when the option was not given. */
function optionalText(value: string | undefined, option: string): string | undefined {
  if (value === undefined) return undefined;
  if (!value.trim()) throw new CliError('INVALID_PARAMS', `${option} cannot be empty`);
  return value.trim();
}

export interface PocketAlertProfileAddOptions extends ProfileAddOptions {
  apiKey?: string;
}

export async function pocketAlertProfileAdd(
  options: PocketAlertProfileAddOptions,
  context: SetupContext,
): Promise<SetupResult<PocketAlertCredentials>> {
  const apiKey = options.apiKey !== undefined ? checkAnswer(POCKETALERT_API_KEY_INPUT, options.apiKey) : await context.ask(POCKETALERT_API_KEY_INPUT);

  const applications = await new PocketAlertClient({ apiKey }).applications();
  const info = `Connected to Pocket Alert, ${applications.length} application${applications.length === 1 ? '' : 's'}`;
  return { credentials: { apiKey }, suggestedProfileName: 'default', info };
}

export function registerPocketAlertCommands(program: Command): void {
  const pocketalert = program.command('pocketalert').description('Send push notifications to your devices with Pocket Alert');

  addExamples(
    addJsonOption(
      pocketalert
        .command('send')
        .description('Send a push notification')
        .requiredOption('-t, --title <title>', 'Notification title')
        .requiredOption('-m, --message <text>', 'Notification body')
        .option('-a, --application <tid>', 'Application id (default: the account\'s default application)')
        .option('-d, --device <tid>', 'Device id (default: every device)')
        .option('--level <level>', 'Priority, -2 to 2 or a level name (default: the application\'s)')
        .option('--profile <name>', 'Profile name (optional if only one profile exists)'),
    ).action(async (options) => {
      try {
        const title = optionalText(options.title, '--title')!;
        const message = optionalText(options.message, '--message')!;
        const application_id = optionalText(options.application, '--application');
        const device_id = optionalText(options.device, '--device');
        const level = options.level !== undefined ? parseLevel(options.level) : undefined;
        const { client, profile } = await getPocketAlertClient(options.profile);
        await enforceWriteAccess('pocketalert', profile, 'send a message');
        printSentMessage(await client.send({ title, message, application_id, device_id, level }), options.json);
      } catch (error) {
        handleError(error);
      }
    }),
    `Examples:

  agentio pocketalert send --title "Build done" --message "agentio 3.7.0 is published"

  # one device, high priority
  agentio pocketalert send -t "Server down" -m "api.example.com does not answer" -d <device-tid> --level 2 --json`,
  );

  const profile = createProfileCommands<PocketAlertCredentials>(pocketalert, {
    service: 'pocketalert',
    displayName: 'Pocket Alert',
  });

  addExamples(
    addSetupOptions(
      profile
        .command('add')
        .description('Add a Pocket Alert account with its API key')
        .option('--api-key <key>', 'API key, from Settings in the Pocket Alert app (asked for when absent)')
        .option('--profile <name>', 'Profile name (default: default)')
        .option('--read-only', 'Create as read-only profile (blocks write operations)')
    )
      .action(async (options: PocketAlertProfileAddOptions) => {
        try {
          await addProfileWithSetup('pocketalert', (o, context) => pocketAlertProfileAdd(o as PocketAlertProfileAddOptions, context), options);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # asks for the API key, so it stays out of shell history
  agentio pocketalert profile add`,
  );
}
