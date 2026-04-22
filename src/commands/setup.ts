import { Command } from 'commander';
import { mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join } from 'path';
import { password, input, confirm } from '@inquirer/prompts';
import { CliError, handleError } from '../utils/errors';
import { writePointer } from '../vault/pointer';
import { saveVault, CURRENT_VAULT_VERSION } from '../vault/vault';
import { setPassphrase } from '../vault/passphrase';
import { detectLegacy, migrateLegacy } from '../vault/migrate';

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

  console.log(`Vault created at ${inputs.vaultPath}`);
  if (!result.tokensRecovered) {
    console.error('Warning: legacy credentials could not be recovered. Re-authenticate each service.');
  }
}

export function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .description('Initialize or manage the agentio vault')
    .action(async () => {
      try {
        const legacy = await detectLegacy();
        const nonInteractive = readNonInteractiveInputs();

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
