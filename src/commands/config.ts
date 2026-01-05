import { Command } from 'commander';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { loadConfig, saveConfig } from '../config/config-manager';
import { getAllCredentials, setAllCredentials } from '../auth/token-store';
import { CliError, handleError } from '../utils/errors';
import type { Config } from '../types/config';
import type { StoredCredentials } from '../types/tokens';

const ALGORITHM = 'aes-256-gcm';
const DEFAULT_EXPORT_FILE = 'agentio.config';

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

function encrypt(data: string, key: Buffer): { iv: string; tag: string; data: string } {
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(data, 'utf-8'),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: encrypted.toString('hex'),
  };
}

function decrypt(encrypted: { iv: string; tag: string; data: string }, key: Buffer): string {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(encrypted.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'hex'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypted.data, 'hex')),
    decipher.final(),
  ]);

  return decrypted.toString('utf-8');
}

export function registerConfigCommands(program: Command): void {
  const config = program
    .command('config')
    .description('Configuration management');

  config
    .command('export')
    .description('Export configuration and credentials to an encrypted file')
    .option('--key <key>', 'Encryption key (64 hex characters). If not provided, a random key will be generated')
    .option('--output <file>', 'Output file path', DEFAULT_EXPORT_FILE)
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

        const exportData: ExportedData = {
          version: 1,
          config: configData,
          credentials,
        };

        // Encrypt the data
        const key = deriveKeyFromPassword(encryptionKey);
        const encrypted = encrypt(JSON.stringify(exportData), key);

        // Write to file
        const outputPath = join(process.cwd(), options.output);
        await writeFile(outputPath, JSON.stringify(encrypted, null, 2), { mode: 0o600 });

        console.log(`Configuration exported to: ${outputPath}`);
        console.log(`Encryption key: ${encryptionKey}`);
        console.log('');
        console.log('Keep this key safe! You will need it to import the configuration.');
      } catch (error) {
        handleError(error);
      }
    });

  config
    .command('import')
    .description('Import configuration and credentials from an encrypted file')
    .argument('<file>', 'Path to the encrypted configuration file')
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

        // Check file exists
        const filePath = file.startsWith('/') ? file : join(process.cwd(), file);
        if (!existsSync(filePath)) {
          throw new CliError(
            'NOT_FOUND',
            `File not found: ${filePath}`,
            'Provide a valid path to the exported configuration file'
          );
        }

        // Read and parse the encrypted file
        const encryptedContent = await readFile(filePath, 'utf-8');
        let encrypted: { iv: string; tag: string; data: string };
        try {
          encrypted = JSON.parse(encryptedContent);
        } catch {
          throw new CliError(
            'INVALID_PARAMS',
            'Invalid file format',
            'The file does not appear to be a valid agentio export file'
          );
        }

        // Decrypt
        const derivedKey = deriveKeyFromPassword(key);
        let exportData: ExportedData;
        try {
          const decrypted = decrypt(encrypted, derivedKey);
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

          // Merge defaults (only if not set)
          for (const [service, defaultProfile] of Object.entries(exportData.config.defaults)) {
            if (defaultProfile && !(currentConfig.defaults as Record<string, string | undefined>)[service]) {
              (currentConfig.defaults as Record<string, string>)[service] = defaultProfile;
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
}
