import { Command } from 'commander';
import type { InputSpec, SetupContext, SetupResult } from '../../plugin-sdk';
import { createClientGetter } from '../../utils/client-factory';
import { addExamples } from '../../utils/command-tree';
import { handleError } from '../../utils/errors';
import { addJsonOption, writeJson } from '../../utils/output';
import { createProfileCommands } from '../../utils/profile-commands';
import { enforceWriteAccess } from '../../utils/read-only';
import { addProfileWithSetup } from '../profile-host';
import { checkAnswer } from '../setup-inputs';
import type { ProfileAddOptions } from '../types';
import { signInWithBrowser } from './auth';
import { parseSessionToken, PicsiClient } from './client';
import { checkDestination, readImage, saveImage } from './files';
import { swapSettings, type SwapOptions } from './settings';
import type { PicsiCredentials } from './types';

const TOKEN_INPUT: InputSpec = { label: 'Picsi session token', kind: 'secret', help: 'Your existing Picsi web or extension session, not a Discord token' };
const PROFILE_OPTION = ['--profile <name>', 'Profile name (optional if only one profile exists)'] as const;

export interface PicsiProfileAddOptions extends ProfileAddOptions {
  token?: string | true;
  browser?: boolean;
}

export async function picsiProfileAdd(options: PicsiProfileAddOptions, context: SetupContext, signIn = signInWithBrowser): Promise<SetupResult<PicsiCredentials>> {
  const token = parseSessionToken(options.token === undefined
    ? options.browser === false ? await context.ask(TOKEN_INPUT) : await signIn(context)
    : options.token === true ? await context.ask(TOKEN_INPUT) : checkAnswer(TOKEN_INPUT, options.token));
  context.log('Checking your Picsi account…');
  const account = await new PicsiClient({ token }, { fetch: context.fetch }).account();
  return {
    credentials: { token, name: account.name, ...(account.email ? { email: account.email } : {}) },
    suggestedProfileName: 'default',
    info: `${account.name} (${account.plan}), ${account.creditsRemaining}/${account.creditsTotal} credits`,
  };
}

const getClient = createClientGetter<PicsiCredentials, PicsiClient>({ service: 'picsi', createClient: (credentials) => new PicsiClient(credentials) });

export function registerPicsiCommands(program: Command): void {
  const picsi = program.command('picsi').description('Swap a face in a local image with your Picsi account, using the web service behind the official Chrome extension');

  addExamples(
    addJsonOption(picsi.command('account').description('Show the signed-in account, membership and remaining credits').option(...PROFILE_OPTION))
      .action(async (options: { profile?: string; json?: boolean }) => {
        try {
          const { client } = await getClient(options.profile);
          const account = await client.account();
          if (options.json) { writeJson(account, 2); return; }
          console.log(`${account.name}${account.email ? ` <${account.email}>` : ''}`);
          console.log(`  Plan: ${account.plan}`);
          console.log(`  Credits: ${account.creditsRemaining}/${account.creditsTotal}`);
        } catch (error) { handleError(error); }
      }),
    `Examples:

  agentio picsi account
  agentio picsi account --json`,
  );

  addExamples(
    addJsonOption(picsi.command('swap').description('Swap one source face into one target image and save the result; uses your Picsi credits')
      .requiredOption('--source <file>', 'Local source face photo (JPG, PNG or WebP; up to 30 MB)')
      .requiredOption('--target <file>', 'Local target image (JPG, PNG or WebP; up to 30 MB)')
      .requiredOption('-o, --output <file>', 'Save to this new file; existing files are never overwritten')
      .option('--at <x,y>', 'Target face position as percentages, measured from the top left (paid accounts select the nearest face; free accounts select the largest)', '50,50')
      .option('--no-dax', 'Turn off the Dax model')
      .option('--no-optimize', 'Turn off automatic optimization')
      .option('--fix-hairline', 'Correct hairline mismatches')
      .option('--fix-eyes', 'Correct eye shape and colour')
      .option('--fix-ears', 'Preserve the target ears')
      .option('--retain-mouth', 'Keep the target mouth')
      .option('--fix-occlusion', 'Correct objects covering the face')
      .option('--fix-jawline', 'Correct minor chin and jawline mismatches')
      .option('--shapify <1-1000>', 'Enable face-shape matching at this intensity')
      .option(...PROFILE_OPTION))
      .action(async (options: SwapOptions & { source: string; target: string; output: string; profile?: string; json?: boolean }) => {
        try {
          const settings = swapSettings(options);
          const destination = await checkDestination(options.output);
          const { client, profile } = await getClient(options.profile);
          await enforceWriteAccess('picsi', profile, 'submit face swaps');
          const source = await readImage(options.source);
          const target = await readImage(options.target);
          const result = await client.swap(source, target, settings, (line) => process.stderr.write(`${line}\n`));
          try { await saveImage(result.output, destination); }
          catch (error) {
            if (result.output.startsWith('https://')) process.stderr.write(`The swap completed. Recover the image without another swap: ${result.output}\n`);
            throw error;
          }
          const view = { saved: destination, ...(result.creditsRemaining !== undefined ? { creditsRemaining: result.creditsRemaining, creditsTotal: result.creditsTotal } : {}) };
          if (options.json) { writeJson(view, 2); return; }
          console.log(destination);
          if (result.creditsRemaining !== undefined) process.stderr.write(`Credits remaining: ${result.creditsRemaining}\n`);
        } catch (error) { handleError(error); }
      }),
    `Examples:

  agentio picsi swap --source face.jpg --target photo.jpg -o swapped.png

  # choose the face at 25% across and 50% down on a paid plan
  agentio picsi swap --source face.jpg --target group.jpg --at 25,50 -o swapped.png

  agentio picsi swap --source face.jpg --target photo.jpg --retain-mouth --shapify 600 -o swapped.png --json`,
  );

  const profile = createProfileCommands<PicsiCredentials>(picsi, { service: 'picsi', displayName: 'Picsi.Ai' });
  addExamples(
    profile.command('add').description('Connect your Picsi account in the browser, or import an existing Picsi session')
      .option('--token [value]', 'Use a Picsi session token instead of browser sign-in (omit the value for a hidden prompt)')
      .option('--no-browser', 'Paste an existing Picsi session token without opening a browser')
      .option('--profile <name>', 'Profile name (default: default)')
      .option('--read-only', 'Allow account lookup, blocking swaps')
      .action(async (options: PicsiProfileAddOptions) => {
        try { await addProfileWithSetup('picsi', (o, context) => picsiProfileAdd(o as PicsiProfileAddOptions, context), options); }
        catch (error) { handleError(error); }
      }),
    `Examples:

  agentio picsi profile add
  agentio picsi profile add --token
  agentio picsi profile add --no-browser --profile personal`,
  );
}
