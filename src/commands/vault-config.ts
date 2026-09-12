import { Command } from 'commander';
import { randomBytes } from 'crypto';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { loadConfig } from '../config/config-manager';
import { getAllCredentials } from '../auth/token-store';
import { CURRENT_VAULT_VERSION, updateVault, vaultExists, type VaultContents } from '../vault/vault';
import { pruneDanglingScopes } from '../auth/api-keys';
import { bootstrapVault } from './vault-init';
import { CliError, handleError } from '../utils/errors';
import { confirm } from '../utils/stdin';
import { isInteractive, interactiveCheckbox, interactiveSelect } from '../utils/interactive';
import { encryptVault, decryptVault } from '../vault/crypto';
import { addExamples } from '../utils/command-tree';
import type { Config, ServiceName, ProfileValue } from '../types/config';
import type { StoredCredentials } from '../types/tokens';

interface ProfileSelection {
  service: ServiceName;
  profile: string;
}

/** The export blob has the vault's own shape, minus anything not selected. */
type ExportedData = VaultContents;

function generateKey(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Generate encrypted config data for CI/CD environments.
 * Returns the key and encrypted config that can be used as environment variables.
 */
export async function generateExportData(): Promise<{ key: string; config: string }> {
  const encryptionKey = generateKey();

  const configData = await loadConfig();
  const credentials = await getAllCredentials();

  const exportData: ExportedData = {
    version: 1,
    config: configData,
    credentials,
  };

  const encrypted = await encryptVault(JSON.stringify(exportData), encryptionKey);

  return {
    key: encryptionKey,
    config: encrypted,
  };
}

export function registerVaultConfigCommands(vault: Command): void {
  const exportCmd = vault
    .command('export')
    .description('Export configuration and credentials (as environment variables by default, or to a file)')
    .option('--key <key>', 'Encryption key (64 hex characters). If not provided, a random key will be generated')
    .option('--file <path>', 'Write encrypted config to file instead of outputting AGENTIO_CONFIG')
    .option('--all', 'Export all profiles without prompting for selection')
    .action(async (options) => {
      try {
        // Validate key if provided
        let encryptionKey: string;
        if (options.key) {
          if (!/^[0-9a-fA-F]{64}$/.test(options.key)) {
            throw new CliError(
              'INVALID_PARAMS',
              'Invalid encryption key format',
              'Key must be exactly 64 hexadecimal characters'
            );
          }
          encryptionKey = options.key;
        } else {
          encryptionKey = generateKey();
        }

        // Load config and credentials
        const configData = await loadConfig();
        const credentials = await getAllCredentials();

        // Build list of all available profiles
        const allProfiles: ProfileSelection[] = [];
        for (const [service, profiles] of Object.entries(configData.profiles)) {
          if (profiles) {
            for (const entry of profiles) {
              const profileName = typeof entry === 'string' ? entry : entry.name;
              allProfiles.push({ service: service as ServiceName, profile: profileName });
            }
          }
        }

        if (allProfiles.length === 0) {
          throw new CliError(
            'NOT_FOUND',
            'No profiles configured',
            'Add profiles first with: agentio <service> profile add'
          );
        }

        // Determine which profiles to export
        let selectedProfiles: ProfileSelection[];

        if (options.all || !isInteractive()) {
          // Export all profiles
          selectedProfiles = allProfiles;
        } else {
          // Interactive: ask user to select profiles
          const exportAll = await interactiveSelect({
            message: 'What would you like to export?',
            choices: [
              { name: `All profiles (${allProfiles.length})`, value: 'all' },
              { name: 'Select specific profiles', value: 'select' },
            ],
            default: 'all',
          });

          if (exportAll === 'all') {
            selectedProfiles = allProfiles;
          } else {
            selectedProfiles = await interactiveCheckbox({
              message: 'Select profiles to export:',
              choices: allProfiles.map((p) => ({
                name: `${p.service}: ${p.profile}`,
                value: p,
                checked: false,
              })),
              required: true,
            });
          }
        }

        // Filter config and credentials based on selection
        const filteredConfig: Config = { profiles: {} };
        const filteredCredentials: StoredCredentials = {};

        for (const { service, profile } of selectedProfiles) {
          // Add to filtered config
          if (!filteredConfig.profiles[service]) {
            (filteredConfig.profiles as Record<string, string[]>)[service] = [];
          }
          (filteredConfig.profiles as Record<string, string[]>)[service].push(profile);

          // Add credentials if they exist
          if (credentials[service]?.[profile]) {
            if (!filteredCredentials[service]) {
              filteredCredentials[service] = {};
            }
            filteredCredentials[service][profile] = credentials[service][profile];
          }
        }

        const exportData: ExportedData = {
          version: 1,
          config: filteredConfig,
          credentials: filteredCredentials,
        };

        // Encrypt the data
        const encrypted = await encryptVault(JSON.stringify(exportData), encryptionKey);

        const profileCount = selectedProfiles.length;
        const profileText = profileCount === 1 ? 'profile' : 'profiles';

        if (options.file) {
          // Write to file, output just the key
          const filePath = options.file.startsWith('/') ? options.file : join(process.cwd(), options.file);
          await writeFile(filePath, encrypted, { mode: 0o600 });
          console.error(`Exported ${profileCount} ${profileText} to ${filePath}`);
          console.log(`AGENTIO_KEY=${encryptionKey}`);
        } else {
          // Output as environment variables
          console.error(`Exported ${profileCount} ${profileText}`);
          console.log(`AGENTIO_KEY=${encryptionKey}`);
          console.log(`AGENTIO_CONFIG=${encrypted}`);
        }
      } catch (error) {
        handleError(error);
      }
    });

  addExamples(
    exportCmd,
    `Examples:

  # interactive picker, prints AGENTIO_KEY=… and AGENTIO_CONFIG=… to stdout
  agentio vault export

  # export every profile non-interactively (good in scripts / CI)
  agentio vault export --all

  # write the encrypted blob to a file; only AGENTIO_KEY goes to stdout
  agentio vault export --all --file ./agentio.enc

  # bring your own encryption key (64 hex chars)
  agentio vault export --all --key 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`,
  );

  const importCmd = vault
    .command('import')
    .description('Import configuration and credentials from an encrypted file or environment variables')
    .argument('[file]', 'Path to the encrypted configuration file (optional if AGENTIO_CONFIG env var is set)')
    .option('--key <key>', 'Encryption key (64 hex characters). Falls back to AGENTIO_KEY env var')
    .option('--merge', 'Merge with existing configuration instead of replacing')
    .option('--passphrase <value>', 'Passphrase for the vault created when none exists yet (visible in shell history and process list)')
    .option('--passphrase-stdin', 'Read that passphrase from stdin')
    .action(async (file, options) => {
      try {
        // Get key from option or environment variable
        const key = options.key || process.env.AGENTIO_KEY;
        if (!key) {
          throw new CliError(
            'INVALID_PARAMS',
            'No encryption key provided',
            'Provide --key option or set AGENTIO_KEY environment variable'
          );
        }

        // Validate key
        if (!/^[0-9a-fA-F]{64}$/.test(key)) {
          throw new CliError(
            'INVALID_PARAMS',
            'Invalid encryption key format',
            'Key must be exactly 64 hexadecimal characters'
          );
        }

        let encrypted: string;

        if (file) {
          // Read from file
          const filePath = file.startsWith('/') ? file : join(process.cwd(), file);
          if (!existsSync(filePath)) {
            throw new CliError(
              'NOT_FOUND',
              `File not found: ${filePath}`,
              'Provide a valid path to the exported configuration file'
            );
          }
          encrypted = await readFile(filePath, 'utf-8');
        } else if (process.env.AGENTIO_CONFIG) {
          encrypted = process.env.AGENTIO_CONFIG;
        } else {
          throw new CliError(
            'INVALID_PARAMS',
            'No configuration source provided',
            'Provide a file path or set AGENTIO_CONFIG environment variable'
          );
        }

        // Decrypt
        let exportData: ExportedData;
        try {
          const decrypted = await decryptVault(encrypted.trim(), key);
          exportData = JSON.parse(decrypted);
        } catch {
          throw new CliError(
            'AUTH_FAILED',
            'Failed to decrypt configuration',
            'Check that you are using the correct encryption key'
          );
        }

        // Validate version
        if (exportData.version !== 1) {
          throw new CliError(
            'INVALID_PARAMS',
            `Unsupported export version: ${exportData.version}`,
            'This version of agentio may not support this export format'
          );
        }

        if (!(await vaultExists())) {
          // Fresh machine or a container's first boot: there is nothing to
          // merge into or replace, so the export becomes the vault.
          await bootstrapVault(options, {
            version: CURRENT_VAULT_VERSION,
            config: exportData.config,
            credentials: exportData.credentials,
          });
          console.log('Configuration imported successfully');
        } else if (options.merge) {
          // Merge with existing config: add what is missing, never overwrite.
          await updateVault(({ config: currentConfig, credentials: currentCredentials }) => {
            for (const [service, profiles] of Object.entries(exportData.config.profiles)) {
              if (!profiles) continue;
              const currentProfiles = ((currentConfig.profiles as Record<string, ProfileValue[]>)[service] ??= []);
              for (const entry of profiles) {
                const profileName = typeof entry === 'string' ? entry : entry.name;
                if (!currentProfiles.some((p) => (typeof p === 'string' ? p : p.name) === profileName)) {
                  currentProfiles.push(entry);
                }
              }
            }
            for (const [service, profiles] of Object.entries(exportData.credentials)) {
              const current = (currentCredentials[service] ??= {});
              for (const [profile, creds] of Object.entries(profiles)) {
                current[profile] ??= creds;
              }
            }
          });
          console.log('Configuration merged successfully');
        } else {
          // Replace profiles from the export, but PRESERVE any other
          // top-level fields. The export blob only contains `{profiles}` by
          // construction; everything else in the existing config is
          // per-machine state that the import has no business destroying.
          await updateVault((current) => {
            current.config.profiles = exportData.config.profiles;
            pruneDanglingScopes(current.config);
            current.credentials = exportData.credentials;
          });
          console.log('Configuration imported successfully');
        }
      } catch (error) {
        handleError(error);
      }
    });

  addExamples(
    importCmd,
    `Examples:

  # import from a file (key passed inline)
  agentio vault import ./agentio.enc --key 0123…cdef

  # import from AGENTIO_CONFIG env var, key from AGENTIO_KEY env var
  AGENTIO_KEY=… AGENTIO_CONFIG=… agentio vault import

  # merge into existing config (only adds missing profiles/credentials)
  agentio vault import ./agentio.enc --key 0123…cdef --merge

When no vault exists yet, import creates one at the default path. The passphrase
for it resolves like 'vault init': --passphrase-stdin, --passphrase, then
AGENTIO_PASSPHRASE; off a TTY one of those is required.`,
  );

  const clearCmd = vault
    .command('clear')
    .description('Clear all configuration and credentials')
    .option('--force', 'Skip confirmation prompt')
    .action(async (options) => {
      try {
        if (!options.force) {
          const confirmed = await confirm(
            'This will delete all profiles, credentials, and API keys. Are you sure?'
          );
          if (!confirmed) {
            console.error('Aborted');
            return;
          }
        }

        // Empty profiles, credentials, and keys in one write
        await updateVault((current) => {
          current.config = { profiles: {} };
          current.credentials = {};
        });

        console.log('Configuration cleared');
      } catch (error) {
        handleError(error);
      }
    });

  addExamples(
    clearCmd,
    `Examples:

  # interactive: deletes all profiles and credentials after confirmation
  agentio vault clear

  # non-interactive (CI / scripted reset)
  agentio vault clear --force`,
  );
}
