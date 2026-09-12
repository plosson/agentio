import { Command } from 'commander';
import { CliError, handleError } from '../utils/errors';
import { addExamples } from '../utils/command-tree';
import { launchBrowser } from '../auth/oauth-server';
import { deviceLogin } from '../auth/device-login';
import { clearRemoteToken, saveRemoteToken, tokenFilePath, tokenSource } from '../auth/remote';
import { describeScope } from '../auth/api-keys';

export function registerLoginCommands(program: Command): void {
  addExamples(
    program
      .command('login')
      .description('Get a key from a vault hub by approving a code in its admin UI')
      .argument('<hub-url>', 'The hub, e.g. https://vault.example.com')
      .option('--name <name>', 'How this machine introduces itself (default: hostname)')
      .option('--no-browser', 'Print the approval URL instead of opening it')
      .action(async (hubUrl: string, opts: { name?: string; browser: boolean }) => {
        try {
          if (tokenSource() === 'env') {
            throw new CliError('CONFIG_ERROR', 'AGENTIO_TOKEN is set, so a stored login would be ignored', 'Unset AGENTIO_TOKEN first, or keep using it');
          }
          const result = await deviceLogin({
            url: hubUrl,
            name: opts.name,
            onCode: ({ userCode, verifyUrl, expiresIn }) => {
              console.error(`Your code: ${userCode}`);
              console.error(`Approve it at ${verifyUrl} within ${Math.round(expiresIn / 60)} minutes.`);
              if (opts.browser && launchBrowser(verifyUrl)) console.error('Opened it in your browser.');
              console.error('Waiting for approval…');
            },
          });
          const path = await saveRemoteToken(result.token);
          console.log(`Signed in to ${result.url} as key "${result.key.name}" (${result.key.id}): ${describeScope(result.key)}`);
          console.log(`Token stored in ${path}. Every agentio command on this machine now uses the hub.`);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # from a laptop: opens the approval page in the browser
  agentio login https://vault.example.com

  # from a VPS over SSH: approve from any device that can reach the hub
  agentio login https://vault.example.com --no-browser --name build-box`,
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
