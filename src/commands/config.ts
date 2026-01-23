import { Command } from 'commander';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { loadConfig, saveConfig, setEnv, unsetEnv, listEnv } from '../config/config-manager';
import { getAllCredentials, setAllCredentials } from '../auth/token-store';
import { CliError, handleError } from '../utils/errors';
import { confirm } from '../utils/stdin';
import { isInteractive, interactiveCheckbox, interactiveSelect } from '../utils/interactive';
import type { Config, ServiceName } from '../types/config';
import type { StoredCredentials } from '../types/tokens';

interface ProfileSelection {
  service: ServiceName;
  profile: string;
}

const ALGORITHM = 'aes-256-gcm';

interface ExportedData {
  version: number;
  config: Config;
  credentials: StoredCredentials;
}

function deriveKeyFromPassword(password: string): Buffer {
  return scryptSync(password, 'agentio-export-salt', 32);
}

function generateKey(): string {
  return randomBytes(32).toString('hex');
}

// Compact format: base64(iv + ciphertext + tag)
function encrypt(data: string, key: Buffer): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(data, 'utf-8'),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, ciphertext, tag]);
  return combined.toString('base64');
}

function decrypt(data: string, key: Buffer): string {
  const combined = Buffer.from(data, 'base64');

  const iv = combined.subarray(0, 16);
  const tag = combined.subarray(combined.length - 16);
  const ciphertext = combined.subarray(16, combined.length - 16);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString('utf-8');
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

  const key = deriveKeyFromPassword(encryptionKey);
  const encrypted = encrypt(JSON.stringify(exportData), key);

  return {
    key: encryptionKey,
    config: encrypted,
  };
}

export function registerConfigCommands(program: Command): void {
  const config = program
    .command('config')
    .description('Configuration management');

  config
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
            for (const profile of profiles) {
              allProfiles.push({ service: service as ServiceName, profile });
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

        // Include env vars if they exist
        if (configData.env) {
          filteredConfig.env = configData.env;
        }

        const exportData: ExportedData = {
          version: 1,
          config: filteredConfig,
          credentials: filteredCredentials,
        };

        // Encrypt the data
        const key = deriveKeyFromPassword(encryptionKey);
        const encrypted = encrypt(JSON.stringify(exportData), key);

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

  config
    .command('import')
    .description('Import configuration and credentials from an encrypted file or environment variables')
    .argument('[file]', 'Path to the encrypted configuration file (optional if AGENTIO_CONFIG env var is set)')
    .option('--key <key>', 'Encryption key (64 hex characters). Falls back to AGENTIO_KEY env var')
    .option('--merge', 'Merge with existing configuration instead of replacing')
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
        const derivedKey = deriveKeyFromPassword(key);
        let exportData: ExportedData;
        try {
          const decrypted = decrypt(encrypted.trim(), derivedKey);
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

        if (options.merge) {
          // Merge with existing config
          const currentConfig = await loadConfig();
          const currentCredentials = await getAllCredentials();

          // Merge profiles
          for (const [service, profiles] of Object.entries(exportData.config.profiles)) {
            if (profiles) {
              if (!currentConfig.profiles[service as keyof typeof currentConfig.profiles]) {
                (currentConfig.profiles as Record<string, string[]>)[service] = [];
              }
              for (const profile of profiles) {
                if (!(currentConfig.profiles as Record<string, string[]>)[service].includes(profile)) {
                  (currentConfig.profiles as Record<string, string[]>)[service].push(profile);
                }
              }
            }
          }

          // Merge credentials
          for (const [service, profiles] of Object.entries(exportData.credentials)) {
            if (!currentCredentials[service]) {
              currentCredentials[service] = {};
            }
            for (const [profile, creds] of Object.entries(profiles)) {
              // Only add if not already exists
              if (!currentCredentials[service][profile]) {
                currentCredentials[service][profile] = creds;
              }
            }
          }

          await saveConfig(currentConfig);
          await setAllCredentials(currentCredentials);
          console.log('Configuration merged successfully');
        } else {
          // Replace existing config
          await saveConfig(exportData.config);
          await setAllCredentials(exportData.credentials);
          console.log('Configuration imported successfully');
        }
      } catch (error) {
        handleError(error);
      }
    });

  // Environment variable management
  const env = config
    .command('env')
    .description('Manage environment variables')
    .action(async () => {
      try {
        const vars = await listEnv();
        const entries = Object.entries(vars).sort(([a], [b]) => a.localeCompare(b));
        if (entries.length === 0) {
          console.log('No environment variables configured');
          return;
        }
        for (const [key, value] of entries) {
          console.log(`${key}=${value}`);
        }
      } catch (error) {
        handleError(error);
      }
    });

  env
    .command('set')
    .description('Set an environment variable')
    .argument('<key>', 'Variable name')
    .argument('<value>', 'Variable value')
    .action(async (key, value) => {
      try {
        await setEnv(key, value);
        console.log(`Set ${key}`);
      } catch (error) {
        handleError(error);
      }
    });

  env
    .command('unset')
    .description('Remove an environment variable')
    .argument('<key>', 'Variable name')
    .action(async (key) => {
      try {
        const removed = await unsetEnv(key);
        if (removed) {
          console.log(`Removed ${key}`);
        } else {
          throw new CliError('NOT_FOUND', `Variable not found: ${key}`);
        }
      } catch (error) {
        handleError(error);
      }
    });

  config
    .command('clear')
    .description('Clear all configuration and credentials')
    .option('--force', 'Skip confirmation prompt')
    .action(async (options) => {
      try {
        if (!options.force) {
          const confirmed = await confirm(
            'This will delete all profiles and credentials. Are you sure?'
          );
          if (!confirmed) {
            console.error('Aborted');
            return;
          }
        }

        // Reset config to default (empty profiles)
        await saveConfig({ profiles: {} });

        // Clear all credentials
        await setAllCredentials({});

        console.log('Configuration cleared');
      } catch (error) {
        handleError(error);
      }
    });
}
