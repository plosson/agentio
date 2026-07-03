import { Command } from 'commander';
import { mkdir, copyFile, unlink, readFile as fsReadFile } from 'fs/promises';
import { existsSync, statSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join } from 'path';
import { password, input, confirm, select } from '@inquirer/prompts';
import { CliError, handleError } from '../utils/errors';
import { writePointer, readPointer, deletePointer } from '../vault/pointer';
import {
  vaultExists,
  loadVault,
  saveVault,
  resetVault,
  CURRENT_VAULT_VERSION,
} from '../vault/vault';
import { decryptVault } from '../vault/crypto';
import { setPassphrase, clearPassphraseCache } from '../vault/passphrase';
import { detectLegacy, readLegacy, archiveLegacy, legacyPaths } from '../vault/migrate';
import { loadConfig } from '../config/config-manager';
import { addExamples } from '../utils/command-tree';

const DEFAULT_VAULT_FILENAME = 'agentio.vault';

async function maybeNudgeFirstService(): Promise<void> {
  const cfg = await loadConfig();
  const hasAny = Object.values(cfg.profiles).some((arr) => (arr ?? []).length > 0);
  if (hasAny) return;
  console.log('');
  console.log('Next: configure a service. Examples:');
  console.log('  agentio gmail profile add');
  console.log('  agentio slack profile add');
  console.log('Run `agentio --help` to see all available services.');
}

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

function validateVaultPath(path: string): void {
  if (!isAbsolute(path)) {
    throw new CliError(
      'INVALID_PARAMS',
      'Vault path must be absolute',
      'Use a path like /Users/you/agentio.vault'
    );
  }
}

function validatePassphrase(passphrase: string): void {
  if (passphrase.length < MIN_PASSPHRASE_LEN) {
    throw new CliError(
      'INVALID_PARAMS',
      `passphrase must be at least ${MIN_PASSPHRASE_LEN} characters`
    );
  }
}

function validateInputs(v: NonInteractiveInputs): void {
  validateVaultPath(v.vaultPath);
  validatePassphrase(v.passphrase);
}

/**
 * If the user passes a directory (or a path ending in /), append the default
 * filename so the vault lands inside that directory instead of trying to
 * rename over it.
 */
function normalizeVaultPath(path: string): string {
  const trailingSlash = path.endsWith('/');
  let resolved = trailingSlash ? path.slice(0, -1) : path;
  if (existsSync(resolved)) {
    try {
      if (statSync(resolved).isDirectory()) {
        return join(resolved, DEFAULT_VAULT_FILENAME);
      }
    } catch {
      // stat failed — fall through, let downstream I/O surface the error
    }
  } else if (trailingSlash) {
    return join(resolved, DEFAULT_VAULT_FILENAME);
  }
  return resolved;
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
  const vaultPath = normalizeVaultPath(inputs.vaultPath);
  if (vaultPath !== inputs.vaultPath) {
    console.log(`Path is a directory; using ${vaultPath}`);
  }

  const dir = dirname(vaultPath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }

  await writePointer(vaultPath);
  process.env.AGENTIO_PASSPHRASE = inputs.passphrase;

  try {
    await saveVault({
      version: CURRENT_VAULT_VERSION,
      config: { profiles: {} },
      credentials: {},
    });
  } catch (err) {
    // Roll back the pointer so the next setup run starts clean.
    await deletePointer().catch(() => {});
    throw err;
  }

  try {
    await setPassphrase(inputs.passphrase);
  } catch (err) {
    console.error(
      `Warning: could not store passphrase:${(err as Error).message}`
    );
    console.error('Set AGENTIO_PASSPHRASE in your environment for future commands.');
  }

  console.log(`Vault created at ${vaultPath}`);
  await maybeNudgeFirstService();
}

async function doMigrationSetup(inputs: NonInteractiveInputs): Promise<void> {
  validateInputs(inputs);
  const vaultPath = normalizeVaultPath(inputs.vaultPath);
  if (vaultPath !== inputs.vaultPath) {
    console.log(`Path is a directory; using ${vaultPath}`);
  }

  const dir = dirname(vaultPath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }

  // Read legacy files but DO NOT rename them yet — we only archive after the
  // new vault is safely on disk, so a failure here leaves the originals intact.
  const result = await readLegacy();

  await writePointer(vaultPath);
  process.env.AGENTIO_PASSPHRASE = inputs.passphrase;

  try {
    await saveVault({
      version: CURRENT_VAULT_VERSION,
      config: result.config,
      credentials: result.credentials,
    });
  } catch (err) {
    // Roll back pointer. Legacy files were never touched, so setup can be
    // re-run (and detection will still find them).
    await deletePointer().catch(() => {});
    throw err;
  }

  // Vault is safely written — now archive the legacy files.
  await archiveLegacy();

  try {
    await setPassphrase(inputs.passphrase);
  } catch (err) {
    console.error(`Warning: could not store passphrase:${(err as Error).message}`);
    console.error('Set AGENTIO_PASSPHRASE in your environment for future commands.');
  }

  const { configPath, tokensPath } = legacyPaths();
  console.log(`Vault created at ${vaultPath}`);
  console.log(`Legacy files preserved at ${configPath}.bak${existsSync(tokensPath + '.bak') ? ` and ${tokensPath}.bak` : ''}`);
  console.log('Delete them once you have confirmed the vault works.');
  if (!result.tokensRecovered) {
    console.error('Warning: legacy credentials could not be recovered. Re-authenticate each service.');
  }
  await maybeNudgeFirstService();
}

async function doAdoptExisting(inputs: NonInteractiveInputs): Promise<void> {
  validateVaultPath(inputs.vaultPath);
  const vaultPath = normalizeVaultPath(inputs.vaultPath);
  if (!existsSync(vaultPath)) {
    throw new CliError('NOT_FOUND', `No vault file at ${vaultPath}`);
  }

  const encoded = await fsReadFile(vaultPath, 'utf-8');
  try {
    decryptVault(encoded.trim(), inputs.passphrase);
  } catch {
    throw new CliError('AUTH_FAILED', 'Wrong passphrase for the vault file');
  }

  await writePointer(vaultPath);
  try {
    await setPassphrase(inputs.passphrase);
  } catch (err) {
    console.error(`Warning: could not store passphrase:${(err as Error).message}`);
  }
  console.log(`Adopted vault at ${vaultPath}`);
  await maybeNudgeFirstService();
}

async function doChangePassphrase(newPassphrase: string): Promise<void> {
  if (newPassphrase.length < MIN_PASSPHRASE_LEN) {
    throw new CliError('INVALID_PARAMS', `Passphrase must be at least ${MIN_PASSPHRASE_LEN} characters`);
  }
  // Decrypt with current passphrase (from file/env)
  const current = await loadVault();
  // Re-encrypt with new passphrase
  process.env.AGENTIO_PASSPHRASE = newPassphrase;
  clearPassphraseCache();
  await saveVault(current);
  try {
    await setPassphrase(newPassphrase);
  } catch (err) {
    console.error(`Warning: could not store passphrase: ${(err as Error).message}`);
  }
  console.log('Passphrase changed');
}

async function doMoveVault(newPath: string): Promise<void> {
  validateVaultPath(newPath);
  const resolved = normalizeVaultPath(newPath);
  const current = await readPointer();
  if (!current) throw new CliError('VAULT_NOT_CONFIGURED', 'No vault to move');
  if (resolved === current) {
    console.log('Vault is already at that path');
    return;
  }

  const dir = dirname(resolved);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }

  // Copy → repoint → verify → on failure, roll back pointer and delete new file.
  await copyFile(current, resolved);
  const oldPointer = current;
  await writePointer(resolved);
  try {
    await loadVault();
  } catch (err) {
    await writePointer(oldPointer);
    if (existsSync(resolved)) await unlink(resolved).catch(() => {});
    throw err;
  }

  if (existsSync(oldPointer)) await unlink(oldPointer).catch(() => {});
  console.log(`Vault moved to ${resolved}`);
}

async function doReset(force: boolean): Promise<void> {
  if (!force) {
    const ok = await confirm({
      message: 'This will delete the vault, pointer, and stored passphrase. Continue?',
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
  const setupCmd = program
    .command('setup')
    .description('Initialize or manage the agentio vault')
    .option('--reset', 'Wipe vault, pointer, and stored passphrase')
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

  addExamples(
    setupCmd,
    `Examples:

  # first-time setup (interactive: prompts for vault path + passphrase)
  agentio setup

  # re-run on an already-configured vault to change passphrase or move it
  agentio setup

  # wipe the vault, pointer, and stored passphrase (asks for confirmation)
  agentio setup --reset

  # wipe non-interactively (CI / scripted reset)
  agentio setup --reset --force`,
  );
}
