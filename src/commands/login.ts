import { Command } from 'commander';
import { CliError, exitCodeForError, handleError } from '../utils/errors';
import { addExamples } from '../utils/command-tree';
import { addJsonOption, printJson } from '../utils/output';
import { launchBrowser } from '../auth/oauth-server';
import { deviceLogin, LoginNotApproved } from '../auth/device-login';
import { clearRemoteToken, saveRemoteToken, tokenFilePath, tokenSource } from '../auth/remote';
import { describeScope } from '../auth/api-keys';

export function registerLoginCommands(program: Command): void {
  addExamples(
    addJsonOption(
      program
        .command('login')
        .description('Get a key from a vault hub by approving a code in its admin UI')
        .argument('<hub-url>', 'The hub, e.g. https://vault.example.com')
        .option('--name <name>', 'How this machine introduces itself (default: hostname)')
        .option('--no-browser', 'Print the approval URL instead of opening it'),
      'Print one JSON event per line (code, then approved, denied, expired or error); never opens a browser',
    ).action(async (hubUrl: string, opts: { name?: string; browser: boolean; json?: boolean }) => {
      try {
        if (tokenSource() === 'env') {
          throw new CliError('CONFIG_ERROR', 'AGENTIO_TOKEN is set, so a stored login would be ignored', 'Unset AGENTIO_TOKEN first, or keep using it');
        }
        const result = await deviceLogin({
          url: hubUrl,
          name: opts.name,
          onCode: ({ userCode, verifyUrl, expiresIn }) => {
            // The program reading the events opens verifyUrl itself.
            if (opts.json) {
              printJson({ event: 'code', userCode, verifyUrl, expiresIn });
              return;
            }
            console.error(`Your code: ${userCode}`);
            console.error(`Approve it at ${verifyUrl} within ${Math.round(expiresIn / 60)} minutes.`);
            if (opts.browser && launchBrowser(verifyUrl)) console.error('Opened it in your browser.');
            console.error('Waiting for approval…');
          },
        });
        const path = await saveRemoteToken(result.token);
        if (opts.json) {
          const { id, name, allowedProfiles, readOnly, canManageProfiles } = result.key;
          printJson({ event: 'approved', url: result.url, key: { id, name, allowedProfiles, readOnly, canManageProfiles }, tokenPath: path });
          return;
        }
        console.log(`Signed in to ${result.url} as key "${result.key.name}" (${result.key.id}): ${describeScope(result.key)}`);
        console.log(`Token stored in ${path}. Every agentio command on this machine now uses the hub.`);
      } catch (error) {
        if (opts.json && error instanceof LoginNotApproved) {
          printJson({ event: error.outcome, message: error.message, suggestion: error.suggestion });
          process.exit(exitCodeForError(error.code));
        }
        handleError(error);
      }
    }),
    `Examples:

  # from a laptop: opens the approval page in the browser
  agentio login https://vault.example.com

  # from a VPS over SSH: approve from any device that can reach the hub
  agentio login https://vault.example.com --no-browser --name build-box

  # from a program: one JSON event per line on stdout
  agentio login https://vault.example.com --json`,
  );

  addExamples(
    program
      .command('logout')
      .description('Forget the stored hub token on this machine')
      .action(async () => {
        try {
          if (await clearRemoteToken()) {
            console.log(`Removed ${tokenFilePath()}. The key still exists on the hub; revoke it there if it should stop working.`);
          } else if (tokenSource() === 'env') {
            console.log('No stored login. This machine uses AGENTIO_TOKEN; unset it to leave remote mode.');
          } else {
            console.log('No stored login on this machine.');
          }
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  agentio logout`,
  );
}
