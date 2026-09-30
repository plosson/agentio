import { Command } from 'commander';
import { launchBrowser } from '../../auth/oauth-server';
import { CliError, handleError } from '../../utils/errors';
import { addExamples } from '../../utils/command-tree';
import { addJsonOption, printJson } from '../../utils/output';
import { createProfileCommands } from '../../utils/profile-commands';
import { addProfileWithSetup } from '../profile-host';
import { prompt } from '../../utils/stdin';
import type { SetupResult } from '../../plugin-sdk';
import type { ProfileAddOptions } from '../types';
import { KiteClient, normaliseBaseUrl } from './client';
import { deviceLabel, kiteDeviceLogin } from './device-auth';
import type { KiteCredentials } from './types';

export interface KiteProfileAddOptions extends ProfileAddOptions {
  url?: string;
  /** `--no-browser` sets this to false. */
  browser?: boolean;
  json?: boolean;
}

/** What setup reaches outside the process through; tests replace all of it. */
export interface KiteSetupDeps {
  openBrowser?: (url: string) => boolean;
  prompt?: (question: string) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Browser sign-in against `baseUrl`, then who the token belongs to. Nothing is stored here. */
async function signIn(baseUrl: string, options: KiteProfileAddOptions, deps: KiteSetupDeps): Promise<KiteCredentials> {
  const openBrowser = deps.openBrowser ?? launchBrowser;
  const { token, expiresAt } = await kiteDeviceLogin({
    baseUrl,
    label: deviceLabel(),
    sleep: deps.sleep,
    now: deps.now,
    onCode: ({ userCode, verificationUrl, expiresInSeconds }) => {
      if (options.json) {
        printJson({ event: 'code', userCode, verificationUrl, expiresIn: expiresInSeconds });
      } else {
        console.error(`\nTo sign in to Kite, open:\n  ${verificationUrl}\nand check that it shows the code ${userCode}.\n`);
      }
      if (options.browser !== false) openBrowser(verificationUrl);
      console.error('Waiting for approval…');
    },
  });
  const me = await new KiteClient({ baseUrl, token }).me();
  return { baseUrl, token, email: me.email, expiresAt };
}

export async function kiteProfileAdd(
  options: KiteProfileAddOptions,
  deps: KiteSetupDeps = {},
): Promise<SetupResult<KiteCredentials>> {
  const input = options.url ?? (await (deps.prompt ?? prompt)('? Kite URL (for example https://kite.example.com): '));
  const baseUrl = normaliseBaseUrl(input);
  const credentials = await signIn(baseUrl, options, deps);
  return {
    credentials,
    suggestedProfileName: credentials.email,
    info: `Signed in to ${new URL(baseUrl).host} as ${credentials.email}`,
  };
}

/** A new sign-in against the stored URL; the profile keeps its name. */
export async function reauthenticateKite(
  credentials: KiteCredentials | null,
  profileName: string,
  deps: KiteSetupDeps = {},
): Promise<KiteCredentials> {
  if (!credentials?.baseUrl) {
    throw new CliError('CONFIG_ERROR', `Kite profile "${profileName}" has no URL`,
      `Run: agentio kite profile add --profile ${profileName} --url <url>`);
  }
  console.error(`\nRe-authenticating kite / ${profileName}...`);
  const replacement = await signIn(credentials.baseUrl, {}, deps);
  console.error(`  Done (${replacement.email})`);
  return replacement;
}

export function registerKiteCommands(program: Command): void {
  const kite = program.command('kite').description('Publish and share documents on Kite');

  const profile = createProfileCommands<KiteCredentials>(kite, {
    service: 'kite',
    displayName: 'Kite',
    getExtraInfo: (credentials) => (credentials?.baseUrl ? ` - ${credentials.baseUrl}` : ''),
  });

  addExamples(
    addJsonOption(
      profile
        .command('add')
        .description('Sign in to a Kite server in the browser and store the profile')
        .option('--url <url>', 'Kite server URL (asked for when absent)')
        .option('--profile <name>', 'Profile name (defaults to the account email)')
        .option('--read-only', 'Create as read-only profile (blocks write operations)')
        .option('--no-browser', 'Print the sign-in link without opening a browser'),
    ).action(async (options: KiteProfileAddOptions) => {
      try {
        await addProfileWithSetup('kite', (o) => kiteProfileAdd(o as KiteProfileAddOptions), options);
      } catch (error) {
        handleError(error);
      }
    }),
    `Examples:

  # sign in to a Kite server; the browser opens on the approval page
  agentio kite profile add --url https://kite.example.com

  # over SSH: print the link and code instead of opening a browser
  agentio kite profile add --url https://kite.example.com --no-browser

  # a second, read-only account under a chosen name
  agentio kite profile add --url https://kite.example.com --profile team --read-only`,
  );
}
