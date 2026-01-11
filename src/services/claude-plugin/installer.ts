import * as fs from 'fs';
import * as path from 'path';
import { CliError } from '../../utils/errors';
import type {
  ParsedSource,
  PluginManifest,
  DiscoveredComponents,
  PluginInstallOptions,
  InstalledComponent,
  InstallResult,
  ComponentType,
} from '../../types/claude-plugin';
import { parseSource, getDefaultBranch, getContentsUrl } from './source-parser';
import { addPlugin } from './agentio-json';

interface GitHubContent {
  name: string;
  path: string;
  type: 'file' | 'dir';
  download_url: string | null;
}

/**
 * Fetch contents from GitHub API.
 */
async function fetchGitHubContents(url: string): Promise<GitHubContent[]> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'agentio-plugin-manager',
    },
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new CliError('NOT_FOUND', `Path not found: ${url}`);
    }
    if (response.status === 403) {
      throw new CliError(
        'RATE_LIMITED',
        'GitHub API rate limit exceeded',
        'Try again later or authenticate with a GitHub token'
      );
    }
    throw new CliError('API_ERROR', `GitHub API error: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Fetch file content from a download URL.
 */
async function fetchFileContent(downloadUrl: string): Promise<string> {
  const response = await fetch(downloadUrl, {
    headers: {
      'User-Agent': 'agentio-plugin-manager',
    },
  });

  if (!response.ok) {
    throw new CliError(
      'API_ERROR',
      `Failed to download file: ${response.statusText}`
    );
  }

  return response.text();
}

/**
 * Download a folder recursively from GitHub.
 */
async function downloadFolder(
  parsed: ParsedSource,
  repoPath: string,
  targetDir: string
): Promise<void> {
  const url = getContentsUrl({ ...parsed, path: repoPath });
  const contents = await fetchGitHubContents(url);

  fs.mkdirSync(targetDir, { recursive: true });

  for (const item of contents) {
    const targetPath = path.join(targetDir, item.name);

    if (item.type === 'file' && item.download_url) {
      const content = await fetchFileContent(item.download_url);
      fs.writeFileSync(targetPath, content);
    } else if (item.type === 'dir') {
      await downloadFolder(parsed, item.path, targetPath);
    }
  }
}

/**
 * Fetch the plugin manifest from .claude-plugin/plugin.json.
 */
export async function fetchPluginManifest(
  parsed: ParsedSource
): Promise<PluginManifest> {
  const manifestPath = parsed.path
    ? `${parsed.path}/.claude-plugin/plugin.json`
    : '.claude-plugin/plugin.json';

  const url = getContentsUrl({ ...parsed, path: manifestPath });

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'agentio-plugin-manager',
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new CliError(
          'NOT_FOUND',
          'Plugin manifest not found',
          'Ensure .claude-plugin/plugin.json exists in the plugin root'
        );
      }
      throw new CliError(
        'API_ERROR',
        `GitHub API error: ${response.statusText}`
      );
    }

    const data = (await response.json()) as GitHubContent;
    if (!data.download_url) {
      throw new CliError('API_ERROR', 'Could not get manifest download URL');
    }

    const content = await fetchFileContent(data.download_url);
    const manifest = JSON.parse(content) as PluginManifest;

    if (!manifest.name || !manifest.version) {
      throw new CliError(
        'INVALID_PARAMS',
        'Invalid plugin manifest: missing name or version'
      );
    }

    return manifest;
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (error instanceof SyntaxError) {
      throw new CliError('INVALID_PARAMS', 'Invalid plugin manifest JSON');
    }
    throw error;
  }
}

/**
 * Discover available components in a plugin.
 */
export async function discoverComponents(
  parsed: ParsedSource
): Promise<DiscoveredComponents> {
  const result: DiscoveredComponents = {
    skills: [],
    commands: [],
    hooks: [],
  };

  const componentTypes: ComponentType[] = ['skills', 'commands', 'hooks'];

  for (const type of componentTypes) {
    try {
      const componentPath = parsed.path ? `${parsed.path}/${type}` : type;
      const url = getContentsUrl({ ...parsed, path: componentPath });
      const contents = await fetchGitHubContents(url);
      result[type] = contents
        .filter((item) => item.type === 'dir')
        .map((item) => item.name);
    } catch {
      // Component type doesn't exist, which is fine
    }
  }

  return result;
}

/**
 * Determine which components to install based on options.
 */
function determineComponentsToInstall(
  options: PluginInstallOptions,
  discovered: DiscoveredComponents
): DiscoveredComponents {
  // If no specific flags, install all
  const installAll = !options.skills && !options.commands && !options.hooks;

  return {
    skills: installAll || options.skills ? discovered.skills : [],
    commands: installAll || options.commands ? discovered.commands : [],
    hooks: installAll || options.hooks ? discovered.hooks : [],
  };
}

/**
 * Get the component types array for agentio.json based on what was installed.
 */
function getInstalledComponentTypes(
  options: PluginInstallOptions
): ComponentType[] | undefined {
  const installAll = !options.skills && !options.commands && !options.hooks;
  if (installAll) return undefined; // Default: all

  const types: ComponentType[] = [];
  if (options.skills) types.push('skills');
  if (options.commands) types.push('commands');
  if (options.hooks) types.push('hooks');
  return types;
}

/**
 * Install a plugin from a source.
 */
export async function installPlugin(
  source: string,
  options: PluginInstallOptions
): Promise<InstallResult> {
  const parsed = parseSource(source);

  // Get default branch if not specified
  if (!parsed.branch) {
    parsed.branch = await getDefaultBranch(parsed.owner, parsed.repo);
  }

  // Fetch manifest
  const manifest = await fetchPluginManifest(parsed);

  // Discover available components
  const discovered = await discoverComponents(parsed);

  // Determine what to install
  const toInstall = determineComponentsToInstall(options, discovered);

  const targetDir = options.targetDir || process.cwd();
  const installed: InstalledComponent[] = [];

  // Install skills
  for (const skillName of toInstall.skills) {
    const sourcePath = parsed.path
      ? `${parsed.path}/skills/${skillName}`
      : `skills/${skillName}`;
    const destPath = path.join(targetDir, '.claude', 'skills', skillName);

    if (fs.existsSync(destPath)) {
      if (!options.force) {
        console.error(`  Skipping existing skill: ${skillName}`);
        continue;
      }
      fs.rmSync(destPath, { recursive: true });
    }

    await downloadFolder(parsed, sourcePath, destPath);
    installed.push({ name: skillName, type: 'skills', path: destPath });
    console.error(`  Installed skill: ${skillName}`);
  }

  // Install commands
  for (const cmdName of toInstall.commands) {
    const sourcePath = parsed.path
      ? `${parsed.path}/commands/${cmdName}`
      : `commands/${cmdName}`;
    const destPath = path.join(targetDir, '.claude', 'commands', cmdName);

    if (fs.existsSync(destPath)) {
      if (!options.force) {
        console.error(`  Skipping existing command: ${cmdName}`);
        continue;
      }
      fs.rmSync(destPath, { recursive: true });
    }

    await downloadFolder(parsed, sourcePath, destPath);
    installed.push({ name: cmdName, type: 'commands', path: destPath });
    console.error(`  Installed command: ${cmdName}`);
  }

  // Install hooks
  for (const hookName of toInstall.hooks) {
    const sourcePath = parsed.path
      ? `${parsed.path}/hooks/${hookName}`
      : `hooks/${hookName}`;
    const destPath = path.join(targetDir, '.claude', 'hooks', hookName);

    if (fs.existsSync(destPath)) {
      if (!options.force) {
        console.error(`  Skipping existing hook: ${hookName}`);
        continue;
      }
      fs.rmSync(destPath, { recursive: true });
    }

    await downloadFolder(parsed, sourcePath, destPath);
    installed.push({ name: hookName, type: 'hooks', path: destPath });
    console.error(`  Installed hook: ${hookName}`);
  }

  // Update agentio.json
  addPlugin(targetDir, manifest.name, {
    source: source,
    version: manifest.version,
    components: getInstalledComponentTypes(options),
  });

  return {
    success: true,
    manifest,
    installed,
  };
}

/**
 * Remove installed components for a plugin.
 */
export function removePluginFiles(
  targetDir: string,
  components: InstalledComponent[]
): void {
  for (const comp of components) {
    const compPath = path.join(
      targetDir,
      '.claude',
      comp.type,
      comp.name
    );
    if (fs.existsSync(compPath)) {
      fs.rmSync(compPath, { recursive: true });
    }
  }
}
