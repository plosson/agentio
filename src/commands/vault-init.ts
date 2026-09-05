import { Command } from 'commander';
import { mkdir, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join } from 'path';
import { password, input, confirm } from '@inquirer/prompts';
import { CliError, handleError } from '../utils/errors';
import { writePointer, readPointer, deletePointer } from '../vault/pointer';
import {
  vaultExists,
  loadVault,
  saveVault,
  resetVault,
  CURRENT_VAULT_VERSION,
} from '../vault/vault';
import { setPassphrase, clearPassphraseCache } from '../vault/passphrase';
import { detectLegacy, readLegacy, archiveLegacy, legacyPaths } from '../vault/migrate';
import { loadConfig } from '../config/config-manager';
import { addExamples } from '../utils/command-tree';
import { validateVaultPath, normalizeVaultPath } from '../vault/path';
import {
  MIN_PASSPHRASE_LEN,
  resolvePassphrase,
  validatePassphrase,
  type PassphraseOptions,
} from '../vault/passphrase-input';

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

function defaultVaultPath(): string {
  return join(process.env.HOME || homedir(), '.config', 'agentio', 'vault.enc');
}

interface VaultInputs {
  vaultPath: string;
  passphrase: string;
}

/** Prompt for a new passphrase twice, so a typo can't lock the user out. */
async function promptNewPassphrase(): Promise<string> {
  const passphrase = await password({
    message: `Create a passphrase (min ${MIN_PASSPHRASE_LEN} chars):`,
    mask: true,
    validate: (v) =>
      v.length >= MIN_PASSPHRASE_LEN || `Passphrase must be at least ${MIN_PASSPHRASE_LEN} characters`,
  });
  const confirmPw = await password({ message: 'Confirm passphrase:', mask: true });
  if (passphrase !== confirmPw) {
    throw new CliError('INVALID_PARAMS', 'Passphrases do not match');
  }
  return passphrase;
}

async function resolveInputs(options: PassphraseOptions & { path?: string }): Promise<VaultInputs> {
  const vaultPath =
    options.path ??
    (process.stdin.isTTY
      ? await input({
          message: 'Vault file location:',
          default: defaultVaultPath(),
          validate: (v) => isAbsolute(v) || 'Path must be absolute',
        })
      : defaultVaultPath());

  const passphrase = await resolvePassphrase(options, promptNewPassphrase);

  validateVaultPath(vaultPath);
  validatePassphrase(passphrase);
  return { vaultPath, passphrase };
}

/** Create the parent directory and return the normalized vault path. */
async function prepareVaultPath(inputs: VaultInputs): Promise<string> {
  const vaultPath = normalizeVaultPath(inputs.vaultPath);
  if (vaultPath !== inputs.vaultPath) {
    console.log(`Path is a directory; using ${vaultPath}`);
  }
  const dir = dirname(vaultPath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  return vaultPath;
}

async function storePassphrase(passphrase: string): Promise<void> {
  try {
    await setPassphrase(passphrase);
  } catch (err) {
    console.error(`Warning: could not store passphrase: ${(err as Error).message}`);
    console.error('Set AGENTIO_PASSPHRASE in your environment for future commands.');
  }
}

async function doCreate(inputs: VaultInputs): Promise<void> {
  const vaultPath = await prepareVaultPath(inputs);

  await writePointer(vaultPath);
  process.env.AGENTIO_PASSPHRASE = inputs.passphrase;

  try {
    await saveVault({
      version: CURRENT_VAULT_VERSION,
      config: { profiles: {} },
      credentials: {},
    });
  } catch (err) {
    // Roll back the pointer so the next init run starts clean.
    await deletePointer().catch(() => {});
    throw err;
  }

  await storePassphrase(inputs.passphrase);
  console.log(`Vault created at ${vaultPath}`);
  await maybeNudgeFirstService();
}

async function doMigrate(inputs: VaultInputs): Promise<void> {
  const vaultPath = await prepareVaultPath(inputs);

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
    // Roll back pointer. Legacy files were never touched, so init can be
    // re-run (and detection will still find them).
    await deletePointer().catch(() => {});
    throw err;
  }

  await archiveLegacy();
  await storePassphrase(inputs.passphrase);

  const { configPath, tokensPath } = legacyPaths();
  console.log(`Vault created at ${vaultPath}`);
  console.log(
    `Legacy files preserved at ${configPath}.bak${existsSync(tokensPath + '.bak') ? ` and ${tokensPath}.bak` : ''}`
  );
  console.log('Delete them once you have confirmed the vault works.');
  if (!result.tokensRecovered) {
    console.error('Warning: legacy credentials could not be recovered. Re-authenticate each service.');
  }
  await maybeNudgeFirstService();
}

export function registerVaultInitCommands(vault: Command): void {
  addExamples(
    vault
      .command('init')
      .description('Create a new vault')
      .option('--path <path>', 'Where to create the vault file')
      .option('--passphrase <value>', 'Vault passphrase (visible in shell history and process list)')
      .option('--passphrase-stdin', 'Read the vault passphrase from stdin')
      .option('--no-migrate', 'Ignore any legacy config instead of importing it')
      .action(async (options) => {
        try {
          if (await vaultExists()) {
            const current = await readPointer();
            throw new CliError(
              'CONFIG_ERROR',
              `A vault is already configured at ${current}`,
              'Use `agentio vault set` to switch, `vault passphrase` to change it, or `vault reset` to wipe it',
            );
          }

          const inputs = await resolveInputs(options);
          const legacy = await detectLegacy();

          if (legacy.hasConfig && options.migrate !== false) {
            console.error('Found legacy config — importing it into the new vault.');
            await doMigrate(inputs);
          } else {
            await doCreate(inputs);
          }
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # interactive first-time setup
  agentio vault init

  # non-interactive, passphrase piped in
  printf %s "$VAULT_PW" | agentio vault init --path ~/.config/agentio/vault.enc --passphrase-stdin

  # create a fresh vault, ignoring any legacy config on this machine
  agentio vault init --no-migrate

To use a vault that already exists, run 'agentio vault set <path>' instead.`,
  );

  addExamples(
    vault
      .command('passphrase')
      .description('Change the passphrase of the current vault')
      .option('--passphrase <value>', 'New passphrase (visible in shell history and process list)')
      .option('--passphrase-stdin', 'Read the new passphrase from stdin')
      .action(async (options) => {
        try {
          // Decrypt with the current passphrase before switching to the new one.
          const current = await loadVault();

          const next = await resolvePassphrase(options, promptNewPassphrase);
          validatePassphrase(next);

          process.env.AGENTIO_PASSPHRASE = next;
          clearPassphraseCache();
          await saveVault(current);
          await storePassphrase(next);
          console.log('Passphrase changed');
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # change the passphrase, prompting for the new one
  agentio vault passphrase

  # non-interactive
  printf %s "$NEW_PW" | agentio vault passphrase --passphrase-stdin`,
  );

  addExamples(
    vault
      .command('reset')
      .description('Delete the vault file, pointer, and stored passphrase')
      .option('--force', 'Skip the confirmation prompt')
      .action(async (options) => {
        try {
          if (!options.force) {
            if (!process.stdin.isTTY) {
              throw new CliError(
                'INVALID_PARAMS',
                'Refusing to reset without confirmation and no terminal is available to prompt',
                'Re-run with --force if you are sure',
              );
            }
            const ok = await confirm({
              message: 'This will delete the vault, pointer, and stored passphrase. Continue?',
              default: false,
            });
            if (!ok) {
              console.error('Aborted');
              return;
            }
          }

          // Also clean legacy .bak files.
          const cfgDir = join(process.env.HOME || homedir(), '.config', 'agentio');
          for (const name of ['config.json.bak', 'tokens.enc.bak']) {
            const p = join(cfgDir, name);
            if (existsSync(p)) await unlink(p).catch(() => {});
          }

          await resetVault();
          console.log('Vault reset. Run `agentio vault init` to start fresh.');
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # wipe the vault (asks for confirmation)
  agentio vault reset

  # wipe non-interactively (CI / scripted reset)
  agentio vault reset --force

This deletes the vault file itself. To simply stop using a vault without
destroying it, point agentio elsewhere with 'agentio vault set <path>'.`,
  );
}
