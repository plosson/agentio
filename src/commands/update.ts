import { Command } from 'commander';
import { CliError, handleError } from '../utils/errors';
import { prompt } from '../utils/stdin';
import { addExamples } from '../utils/command-tree';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
// Import package.json - bun will bundle this at compile time
import pkg from '../../package.json';

const GITHUB_REPO = 'plosson/agentio';
const USER_AGENT = 'agentio-updater';

interface GitHubRelease {
  tag_name: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
  }>;
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

interface LatestRelease {
  tag: string;
  // Populated only when the REST API answered; the redirect path knows the tag
  // but not the asset list.
  assets: GitHubRelease['assets'] | null;
}

function githubAuthHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// github.com/<repo>/releases/latest redirects to /releases/tag/<tag>. This is not
// the REST API, so it does not consume the 60 requests/hour that api.github.com
// allows an unauthenticated IP - a budget other tools on the same machine (or
// behind the same NAT) can exhaust on their own.
async function fetchLatestTagViaRedirect(): Promise<string | null> {
  try {
    const response = await fetch(`https://github.com/${GITHUB_REPO}/releases/latest`, {
      method: 'HEAD',
      redirect: 'manual',
      headers: { 'User-Agent': USER_AGENT },
    });

    const location = response.headers.get('location');
    const match = location?.match(/\/releases\/tag\/([^/?#]+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

async function fetchLatestRelease(): Promise<GitHubRelease> {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
  const response = await fetch(url, {
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': USER_AGENT,
      ...githubAuthHeaders(),
    },
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new CliError('NOT_FOUND', 'No releases found');
    }
    if (response.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(response.headers.get('x-ratelimit-reset') || 0);
      const minutes = reset ? Math.max(1, Math.ceil((reset * 1000 - Date.now()) / 60000)) : 0;
      throw new CliError(
        'RATE_LIMITED',
        `GitHub API rate limit exceeded${minutes ? ` (resets in ~${minutes} min)` : ''}`,
        'Set GITHUB_TOKEN (or GH_TOKEN) to raise the limit, or install manually with: curl -LsSf https://agentio.houlahop.com/install | sh'
      );
    }
    throw new CliError('API_ERROR', `Failed to fetch release info: ${response.statusText}`);
  }

  return response.json();
}

async function resolveLatestRelease(): Promise<LatestRelease> {
  const tag = await fetchLatestTagViaRedirect();
  if (tag) {
    return { tag, assets: null };
  }

  const release = await fetchLatestRelease();
  return { tag: release.tag_name, assets: release.assets };
}

async function resolveDownloadUrl(release: LatestRelease, assetName: string, platform: string): Promise<string> {
  if (release.assets) {
    const asset = release.assets.find(a => a.name === assetName);
    if (!asset) {
      throw new CliError(
        'NOT_FOUND',
        `No binary found for ${platform}`,
        `Available assets: ${release.assets.map(a => a.name).join(', ')}`
      );
    }
    return asset.browser_download_url;
  }

  const url = `https://github.com/${GITHUB_REPO}/releases/download/${release.tag}/${assetName}`;
  const response = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) {
    throw new CliError(
      'NOT_FOUND',
      `No binary found for ${platform} in release ${release.tag}`,
      `Expected asset: ${assetName}`
    );
  }
  return url;
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

function renderProgress(received: number, total: number, done = false): void {
  const mb = (b: number) => (b / 1024 / 1024).toFixed(1);
  const width = 30;
  let line: string;
  if (total > 0) {
    const pct = Math.min(100, Math.floor((received / total) * 100));
    const filled = Math.floor((pct / 100) * width);
    const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
    line = `  [${bar}] ${pct}% (${mb(received)}/${mb(total)} MB)`;
  } else {
    line = `  Downloaded ${mb(received)} MB`;
  }
  process.stderr.write(`\r\x1b[K${line}`);
  if (done) process.stderr.write('\n');
}

async function writeChunk(stream: fs.WriteStream, chunk: Uint8Array): Promise<void> {
  if (stream.write(chunk)) return;
  await new Promise<void>((resolve) => stream.once('drain', resolve));
}

async function downloadBinary(url: string, dest: string): Promise<void> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'agentio-updater',
    },
  });

  if (!response.ok || !response.body) {
    throw new CliError('API_ERROR', `Download failed: ${response.statusText}`);
  }

  const total = Number(response.headers.get('content-length') || 0);
  let received = 0;
  let lastRender = 0;
  const showProgress = process.stderr.isTTY;

  const file = fs.createWriteStream(dest);
  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await writeChunk(file, value);
      received += value.length;
      if (showProgress) {
        const now = Date.now();
        if (now - lastRender > 100) {
          renderProgress(received, total);
          lastRender = now;
        }
      }
    }
    if (showProgress) renderProgress(received, total, true);
  } finally {
    await new Promise<void>((resolve, reject) => {
      file.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  }
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
  const updateCmd = program
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

        const release = await resolveLatestRelease();
        const latestVersion = release.tag.replace(/^v/, '');

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
        const downloadUrl = await resolveDownloadUrl(release, assetName, platform);

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
          await updateBinary(downloadUrl, execPath);
          console.log(`Successfully updated to version ${latestVersion}`);
        } catch (error) {
          console.error('');
          console.error('Automatic update failed. You can update manually:');
          console.error('');
          if (os.platform() === 'win32') {
            console.error('  iwr -useb https://agentio.houlahop.com/install.ps1 | iex');
          } else {
            console.error('  curl -LsSf https://agentio.houlahop.com/install | sh');
          }
          console.error('');
          throw error;
        }
      } catch (error) {
        handleError(error);
      }
    });

  addExamples(
    updateCmd,
    `Examples:

  # check for a newer release and install it (asks for confirmation)
  agentio update

  # only check (no download)
  agentio update --check

  # non-interactive update (skip confirmation; useful in scripts)
  agentio update --yes

  # reinstall the same version (e.g. recover a corrupted binary)
  agentio update --force --yes`,
  );
}
