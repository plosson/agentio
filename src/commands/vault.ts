import { Command } from 'commander';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { password } from '@inquirer/prompts';
import { CliError, handleError } from '../utils/errors';
import { addExamples } from '../utils/command-tree';
import { readPointer, writePointer } from '../vault/pointer';
import { decryptVault } from '../vault/crypto';
import { setPassphrase, clearPassphraseCache } from '../vault/passphrase';
import { clearVaultCache, loadVault, type VaultContents } from '../vault/vault';
import { normalizeVaultPath } from '../vault/path';
import { resolvePassphrase, type PassphraseOptions } from '../vault/passphrase-input';
import { registerVaultInitCommands } from './vault-init';
import { registerVaultConfigCommands } from './vault-config';

function countProfiles(contents: VaultContents): number {
  return Object.values(contents.config?.profiles ?? {}).reduce(
    (total, entries) => total + (entries ?? []).length,
    0,
  );
}

export function registerVaultCommands(program: Command): void {
  const vault = program
    .command('vault')
    .description('Manage the agentio vault (config + credentials)');

  registerVaultInitCommands(vault);
  registerVaultConfigCommands(vault);

  addExamples(
    vault
      .command('status')
      .description('Show the active vault and what it holds')
      .action(async () => {
        try {
          const current = await readPointer();
          if (!current) {
            throw new CliError('VAULT_NOT_CONFIGURED', 'No vault configured', 'Run: agentio vault init');
          }
          console.log(`Path: ${current}`);
          console.log(`Exists: ${existsSync(current) ? 'yes' : 'no (file is missing)'}`);
          try {
            const contents = await loadVault();
            console.log(`Profiles: ${countProfiles(contents)}`);
          } catch {
            console.log('Profiles: unreadable (wrong or missing passphrase)');
          }
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # show the active vault path and profile count
  agentio vault status`,
  );

  addExamples(
    vault
      .command('set')
      .description('Point agentio at an existing vault file')
      .argument('<path>', 'Path to the vault file')
      .option('--passphrase <value>', 'Vault passphrase (visible in shell history and process list)')
      .option('--passphrase-stdin', 'Read the vault passphrase from stdin')
      .action(async (path: string, options: PassphraseOptions) => {
        try {
          const vaultPath = normalizeVaultPath(resolve(path));

          if (!existsSync(vaultPath)) {
            throw new CliError(
              'NOT_FOUND',
              `No vault file at ${vaultPath}`,
              'Run `agentio vault init` to create a new vault, or check the path',
            );
          }

          const passphrase = await resolvePassphrase(options, () =>
            password({ message: 'Vault passphrase:', mask: true })
          );
          const encoded = await readFile(vaultPath, 'utf-8');

          // Verify before touching the pointer, so a bad passphrase changes nothing.
          let contents: VaultContents;
          try {
            contents = JSON.parse(decryptVault(encoded.trim(), passphrase)) as VaultContents;
          } catch {
            throw new CliError(
              'AUTH_FAILED',
              `Could not decrypt ${vaultPath}`,
              'Wrong passphrase, or the file is not an agentio vault',
            );
          }

          const previous = await readPointer();

          await writePointer(vaultPath);
          clearVaultCache();
          clearPassphraseCache();

          try {
            await setPassphrase(passphrase);
          } catch (err) {
            console.error(`Warning: could not store passphrase: ${(err as Error).message}`);
            console.error('Set AGENTIO_PASSPHRASE in your environment for future commands.');
          }

          if (previous === vaultPath) {
            console.log(`Vault unchanged: ${vaultPath}`);
          } else {
            console.log(`Vault set to ${vaultPath}`);
            if (previous) console.log(`Previous: ${previous} (left on disk)`);
          }
          console.log(`${countProfiles(contents)} profile(s) available`);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # switch to another vault, prompting for the passphrase
  agentio vault set ~/Dropbox/agentio/work.vault

  # non-interactive, passphrase piped in (keeps it out of history and ps)
  printf %s "$VAULT_PW" | agentio vault set /path/to/work.vault --passphrase-stdin

  # non-interactive via the environment
  AGENTIO_PASSPHRASE="$VAULT_PW" agentio vault set /path/to/work.vault

  # non-interactive as a flag (visible in shell history and process list)
  agentio vault set /path/to/work.vault --passphrase "$VAULT_PW"

Only the pointer and the stored passphrase change - neither vault file is
moved, written to, or deleted. Run 'agentio doctor' to see the active vault.`,
  );
}
