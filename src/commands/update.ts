import { Command } from 'commander';
import { createInterface } from 'readline';
import { CliError, handleError } from '../utils/errors';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
// Import package.json - bun will bundle this at compile time
import pkg from '../../package.json';

const GITHUB_REPO = 'plosson/agentio';

interface GitHubRelease {
  tag_name: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
  }>;
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function getCurrentVersion(): string {
  return pkg.version;
}

function getPlatform(): string {
  const platform = os.platform();
  const arch = os.arch();

  if (platform === 'darwin') {
    return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  } else if (platform === 'linux') {
    return arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
  } else if (platform === 'win32') {
    return 'windows-x64';
  }

  throw new CliError('API_ERROR', `Unsupported platform: ${platform}-${arch}`);
}

function getAssetName(platform: string): string {
  if (platform === 'windows-x64') {
    return `agentio-${platform}.exe`;
  }
  return `agentio-${platform}`;
}

function isCompiledBinary(): boolean {
  // In compiled bun binaries, argv[0] is just "bun" (no path)
  // In dev mode, argv[0] is a full path like "/Users/.../bun"
  return process.argv[0] === 'bun' && !process.execPath.endsWith('/bun');
}

function getExecutablePath(): string {
  if (!isCompiledBinary()) {
    throw new CliError(
      'API_ERROR',
      'Update command only works with compiled binaries',
      'In development, use git pull and bun install instead'
    );
  }
  return process.execPath;
}

async function fetchLatestRelease(): Promise<GitHubRelease> {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
  const response = await fetch(url, {
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'agentio-updater',
    },
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new CliError('NOT_FOUND', 'No releases found');
    }
    throw new CliError('API_ERROR', `Failed to fetch release info: ${response.statusText}`);
  }

  return response.json();
}

function compareVersions(current: string, latest: string): number {
  const parseVersion = (v: string) => v.replace(/^v/, '').split('.').map(Number);
  const currentParts = parseVersion(current);
  const latestParts = parseVersion(latest);

  for (let i = 0; i < 3; i++) {
    const c = currentParts[i] || 0;
    const l = latestParts[i] || 0;
    if (l > c) return 1;
    if (l < c) return -1;
  }
  return 0;
}

async function downloadBinary(url: string, dest: string): Promise<void> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'agentio-updater',
    },
  });

  if (!response.ok) {
    throw new CliError('API_ERROR', `Download failed: ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  fs.writeFileSync(dest, Buffer.from(buffer));
}

function moveFile(src: string, dest: string): void {
  try {
    // Try atomic rename first (fastest, works on same filesystem)
    fs.renameSync(src, dest);
  } catch (err: unknown) {
    // If rename fails (cross-device), fall back to copy+delete
    if (err && typeof err === 'object' && 'code' in err && err.code === 'EXDEV') {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
    } else {
      throw err;
    }
  }
}

async function updateBinary(downloadUrl: string, targetPath: string): Promise<void> {
  const platform = os.platform();
  const isWindows = platform === 'win32';

  // Download to same directory as target to ensure same filesystem
  const targetDir = path.dirname(targetPath);
  const ext = isWindows ? '.exe' : '';
  const tmpFile = path.join(targetDir, `.agentio-update-${Date.now()}${ext}`);

  console.error('Downloading update...');
  await downloadBinary(downloadUrl, tmpFile);

  // Check file was downloaded
  const stats = fs.statSync(tmpFile);
  if (stats.size === 0) {
    fs.unlinkSync(tmpFile);
    throw new CliError('API_ERROR', 'Downloaded file is empty');
  }

  // Get original permissions
  let originalMode = 0o755;
  try {
    originalMode = fs.statSync(targetPath).mode;
  } catch {
    // Use default if can't read original
  }

  console.error('Installing update...');

  if (isWindows) {
    // Windows: cannot delete/overwrite running executable, but CAN rename it
    const backupPath = targetPath + '.old';
    try {
      // Try to remove old backup (may fail if locked from previous update)
      try {
        if (fs.existsSync(backupPath)) {
          fs.unlinkSync(backupPath);
        }
      } catch {
        // If we can't delete old backup, try renaming it instead
        const oldBackup = targetPath + '.old2';
        try {
          if (fs.existsSync(oldBackup)) fs.unlinkSync(oldBackup);
          fs.renameSync(backupPath, oldBackup);
        } catch {
          // Give up on cleanup, proceed anyway
        }
      }

      // Move current executable to backup
      fs.renameSync(targetPath, backupPath);

      // Move new executable into place
      moveFile(tmpFile, targetPath);

      // Try to clean up backup (will likely fail since we're still running)
      try {
        fs.unlinkSync(backupPath);
      } catch {
        // Expected - Windows locks running executables
      }
    } catch (error) {
      // Restore backup if something went wrong
      try {
        if (fs.existsSync(backupPath) && !fs.existsSync(targetPath)) {
          fs.renameSync(backupPath, targetPath);
        }
        if (fs.existsSync(tmpFile)) {
          fs.unlinkSync(tmpFile);
        }
      } catch {
        // Best effort cleanup
      }
      throw error;
    }
  } else {
    // Unix: atomic rename works even while binary is running
    // The running process keeps the old inode open
    fs.chmodSync(tmpFile, originalMode);
    moveFile(tmpFile, targetPath);
  }
}

export function registerUpdateCommand(program: Command): void {
  program
    .command('update')
    .description('Update agentio to the latest version')
    .option('--check', 'Only check for updates, don\'t install')
    .option('--force', 'Force update even if already on latest version')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (options) => {
      try {
        const currentVersion = getCurrentVersion();
        const platform = getPlatform();
        const assetName = getAssetName(platform);

        console.error(`Current version: ${currentVersion}`);
        console.error(`Platform: ${platform}`);
        console.error('');
        console.error('Checking for updates...');

        const release = await fetchLatestRelease();
        const latestVersion = release.tag_name.replace(/^v/, '');

        const comparison = compareVersions(currentVersion, latestVersion);

        if (comparison === 0 && !options.force) {
          console.log(`Already on the latest version (${currentVersion})`);
          return;
        }

        if (comparison < 0) {
          console.log(`Current version (${currentVersion}) is newer than latest release (${latestVersion})`);
          if (!options.force) {
            return;
          }
        }

        console.log(`New version available: ${latestVersion}`);

        if (options.check) {
          return;
        }

        // Find the asset for this platform
        const asset = release.assets.find(a => a.name === assetName);
        if (!asset) {
          throw new CliError(
            'NOT_FOUND',
            `No binary found for ${platform}`,
            `Available assets: ${release.assets.map(a => a.name).join(', ')}`
          );
        }

        // Confirm update
        if (!options.yes) {
          const answer = await prompt(`Update from ${currentVersion} to ${latestVersion}? [y/N] `);
          if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
            console.error('Update cancelled');
            return;
          }
        }

        try {
          const execPath = getExecutablePath();
          await updateBinary(asset.browser_download_url, execPath);
          console.log(`Successfully updated to version ${latestVersion}`);
        } catch (error) {
          console.error('');
          console.error('Automatic update failed. You can update manually:');
          console.error('');
          if (os.platform() === 'win32') {
            console.error('  iwr -useb https://agentio.work/install.ps1 | iex');
          } else {
            console.error('  curl -LsSf https://agentio.work/install | sh');
          }
          console.error('');
          throw error;
        }
      } catch (error) {
        handleError(error);
      }
    });
}
