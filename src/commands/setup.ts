import { Command } from 'commander';
import { mkdir, copyFile, unlink, readFile as fsReadFile } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join } from 'path';
import { password, input, confirm, select } from '@inquirer/prompts';
import { CliError, handleError } from '../utils/errors';
import { writePointer, readPointer } from '../vault/pointer';
import {
  vaultExists,
  loadVault,
  saveVault,
  resetVault,
  CURRENT_VAULT_VERSION,
} from '../vault/vault';
import { decryptVault } from '../vault/crypto';
import { setPassphrase, clearPassphraseCache } from '../vault/passphrase';
import { detectLegacy, migrateLegacy, legacyPaths } from '../vault/migrate';

const MIN_PASSPHRASE_LEN = 8;

interface NonInteractiveInputs {
  vaultPath: string;
  passphrase: string;
}

function readNonInteractiveInputs(): NonInteractiveInputs | null {
  if (process.env.AGENTIO_SETUP_NONINTERACTIVE !== '1') return null;
  return {
    vaultPath: process.env.AGENTIO_SETUP_VAULT_PATH ?? '',
    passphrase: process.env.AGENTIO_SETUP_PASSPHRASE ?? '',
  };
}

function validateInputs(v: NonInteractiveInputs): void {
  if (!isAbsolute(v.vaultPath)) {
    throw new CliError(
      'INVALID_PARAMS',
      'Vault path must be absolute',
      'Use a path like /Users/you/agentio.vault'
    );
  }
  if (v.passphrase.length < MIN_PASSPHRASE_LEN) {
    throw new CliError(
      'INVALID_PARAMS',
      `passphrase must be at least ${MIN_PASSPHRASE_LEN} characters`
    );
  }
}

async function promptFirstTime(): Promise<NonInteractiveInputs> {
  const defaultPath = join(process.env.HOME || homedir(), '.config', 'agentio', 'vault.enc');
  const vaultPath = await input({
    message: 'Vault file location:',
    default: defaultPath,
    validate: (v) => isAbsolute(v) || 'Path must be absolute',
  });
  const passphrase = await password({
    message: 'Create a passphrase (min 8 chars):',
    mask: true,
    validate: (v) =>
      v.length >= MIN_PASSPHRASE_LEN ||
      `Passphrase must be at least ${MIN_PASSPHRASE_LEN} characters`,
  });
  const confirmPw = await password({
    message: 'Confirm passphrase:',
    mask: true,
  });
  if (passphrase !== confirmPw) {
    throw new CliError('INVALID_PARAMS', 'Passphrases do not match');
  }
  return { vaultPath, passphrase };
}

async function doFirstTimeSetup(inputs: NonInteractiveInputs): Promise<void> {
  validateInputs(inputs);

  const dir = dirname(inputs.vaultPath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }

  await writePointer(inputs.vaultPath);
  process.env.AGENTIO_PASSPHRASE = inputs.passphrase;

  await saveVault({
    version: CURRENT_VAULT_VERSION,
    config: { profiles: {} },
    credentials: {},
  });

  try {
    await setPassphrase(inputs.passphrase);
  } catch (err) {
    console.error(
      `Warning: could not store passphrase in OS keychain: ${(err as Error).message}`
    );
    console.error('Set AGENTIO_PASSPHRASE in your environment for future commands.');
  }

  console.log(`Vault created at ${inputs.vaultPath}`);
}

async function doMigrationSetup(inputs: NonInteractiveInputs): Promise<void> {
  validateInputs(inputs);
  const dir = dirname(inputs.vaultPath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }

  const result = await migrateLegacy();

  await writePointer(inputs.vaultPath);
  process.env.AGENTIO_PASSPHRASE = inputs.passphrase;

  await saveVault({
    version: CURRENT_VAULT_VERSION,
    config: result.config,
    credentials: result.credentials,
  });

  try {
    await setPassphrase(inputs.passphrase);
  } catch (err) {
    console.error(`Warning: could not store passphrase in OS keychain: ${(err as Error).message}`);
    console.error('Set AGENTIO_PASSPHRASE in your environment for future commands.');
  }

  const { configPath, tokensPath } = legacyPaths();
  console.log(`Vault created at ${inputs.vaultPath}`);
  console.log(`Legacy files preserved at ${configPath}.bak${existsSync(tokensPath + '.bak') ? ` and ${tokensPath}.bak` : ''}`);
  console.log('Delete them once you have confirmed the vault works.');
  if (!result.tokensRecovered) {
    console.error('Warning: legacy credentials could not be recovered. Re-authenticate each service.');
  }
}

async function doAdoptExisting(inputs: NonInteractiveInputs): Promise<void> {
  if (!isAbsolute(inputs.vaultPath)) {
    throw new CliError('INVALID_PARAMS', 'Vault path must be absolute');
  }
  if (!existsSync(inputs.vaultPath)) {
    throw new CliError('NOT_FOUND', `No vault file at ${inputs.vaultPath}`);
  }

  const encoded = await fsReadFile(inputs.vaultPath, 'utf-8');
  try {
    decryptVault(encoded.trim(), inputs.passphrase);
  } catch {
    throw new CliError('AUTH_FAILED', 'Wrong passphrase for the vault file');
  }

  await writePointer(inputs.vaultPath);
  try {
    await setPassphrase(inputs.passphrase);
  } catch (err) {
    console.error(`Warning: could not store passphrase in OS keychain: ${(err as Error).message}`);
  }
  console.log(`Adopted vault at ${inputs.vaultPath}`);
}

async function doChangePassphrase(newPassphrase: string): Promise<void> {
  if (newPassphrase.length < MIN_PASSPHRASE_LEN) {
    throw new CliError('INVALID_PARAMS', `Passphrase must be at least ${MIN_PASSPHRASE_LEN} characters`);
  }
  // Decrypt with current passphrase (from keychain/env)
  const current = await loadVault();
  // Re-encrypt with new passphrase
  process.env.AGENTIO_PASSPHRASE = newPassphrase;
  clearPassphraseCache();
  await saveVault(current);
  try {
    await setPassphrase(newPassphrase);
  } catch (err) {
    console.error(`Warning: could not update keychain: ${(err as Error).message}`);
  }
  console.log('Passphrase changed');
}

async function doMoveVault(newPath: string): Promise<void> {
  if (!isAbsolute(newPath)) {
    throw new CliError('INVALID_PARAMS', 'New path must be absolute');
  }
  const current = await readPointer();
  if (!current) throw new CliError('VAULT_NOT_CONFIGURED', 'No vault to move');
  if (newPath === current) {
    console.log('Vault is already at that path');
    return;
  }

  const dir = dirname(newPath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }

  // Copy → repoint → verify → on failure, roll back pointer and delete new file.
  await copyFile(current, newPath);
  const oldPointer = current;
  await writePointer(newPath);
  try {
    await loadVault();
  } catch (err) {
    await writePointer(oldPointer);
    if (existsSync(newPath)) await unlink(newPath).catch(() => {});
    throw err;
  }

  if (existsSync(oldPointer)) await unlink(oldPointer).catch(() => {});
  console.log(`Vault moved to ${newPath}`);
}

async function doReset(force: boolean): Promise<void> {
  if (!force) {
    const ok = await confirm({
      message: 'This will delete the vault, pointer, and keychain entry. Continue?',
      default: false,
    });
    if (!ok) {
      console.error('Aborted');
      return;
    }
  }
  // Also clean legacy .bak files
  const cfgDir = join(process.env.HOME || homedir(), '.config', 'agentio');
  for (const name of ['config.json.bak', 'tokens.enc.bak']) {
    const p = join(cfgDir, name);
    if (existsSync(p)) {
      await unlink(p).catch(() => {});
    }
  }
  await resetVault();
  console.log('Vault reset. Run agentio setup to start fresh.');
}

export function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .description('Initialize or manage the agentio vault')
    .option('--reset', 'Wipe vault, pointer, and keychain entry')
    .option('--force', 'Skip confirmation prompts (for --reset)')
    .action(async (options) => {
      try {
        if (options.reset) {
          await doReset(options.force === true);
          return;
        }

        const nonInteractive = readNonInteractiveInputs();
        const existing = await vaultExists();

        if (existing) {
          // Existing-vault menu
          let choice: 'change-passphrase' | 'move-vault' | 'cancel';
          if (nonInteractive) {
            const menu = process.env.AGENTIO_SETUP_MENU;
            if (menu !== 'change-passphrase' && menu !== 'move-vault' && menu !== 'cancel') {
              throw new CliError('INVALID_PARAMS', 'AGENTIO_SETUP_MENU must be change-passphrase|move-vault|cancel');
            }
            choice = menu;
          } else {
            choice = await select<'change-passphrase' | 'move-vault' | 'cancel'>({
              message: 'Vault is already configured. What would you like to do?',
              choices: [
                { name: 'Change passphrase', value: 'change-passphrase' },
                { name: 'Move vault to a new location', value: 'move-vault' },
                { name: 'Cancel', value: 'cancel' },
              ],
            });
          }

          if (choice === 'cancel') return;
          if (choice === 'change-passphrase') {
            const newPw = nonInteractive
              ? nonInteractive.passphrase
              : await password({
                  message: 'New passphrase:',
                  mask: true,
                  validate: (v) => v.length >= MIN_PASSPHRASE_LEN || `Minimum ${MIN_PASSPHRASE_LEN} chars`,
                });
            await doChangePassphrase(newPw);
            return;
          }
          if (choice === 'move-vault') {
            const newPath = nonInteractive
              ? nonInteractive.vaultPath
              : await input({
                  message: 'New vault path:',
                  validate: (v) => isAbsolute(v) || 'Must be absolute',
                });
            await doMoveVault(newPath);
            return;
          }
        }

        // No vault configured yet — could be adopt-existing, migration, or first-time
        const adoptMode = nonInteractive
          ? process.env.AGENTIO_SETUP_ADOPT === '1'
          : await confirm({
              message: 'Do you already have an existing vault file to adopt?',
              default: false,
            });

        if (adoptMode) {
          const inputs = nonInteractive ?? {
            vaultPath: await input({
              message: 'Path to existing vault file:',
              validate: (v) => isAbsolute(v) || 'Must be absolute',
            }),
            passphrase: await password({ message: 'Vault passphrase:', mask: true }),
          };
          await doAdoptExisting(inputs);
          return;
        }

        const legacy = await detectLegacy();
        if (legacy.hasConfig) {
          let migrate: boolean;
          if (nonInteractive) {
            migrate = process.env.AGENTIO_SETUP_MIGRATE === 'yes';
          } else {
            migrate = await confirm({
              message: 'Found legacy config. Import into new vault?',
              default: true,
            });
          }
          if (migrate) {
            const inputs = nonInteractive ?? (await promptFirstTime());
            await doMigrationSetup(inputs);
            return;
          }
        }

        const inputs = nonInteractive ?? (await promptFirstTime());
        await doFirstTimeSetup(inputs);
      } catch (error) {
        handleError(error);
      }
    });
}
