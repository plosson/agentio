import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
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
import { parseSource, buildGitCloneUrl } from './source-parser';
import { addPlugin } from './agentio-json';

/**
 * Clone a repository to a temporary directory.
 */
function cloneRepo(parsed: ParsedSource): string {
  const tempDir = fs.mkdtempSync(path.join(tmpdir(), 'agentio-plugin-'));
  const cloneUrl = buildGitCloneUrl(parsed);

  let cmd = `git clone --depth 1`;
  if (parsed.branch) {
    cmd += ` -b ${parsed.branch}`;
  }
  cmd += ` "${cloneUrl}" "${tempDir}"`;

  try {
    execSync(cmd, { stdio: 'pipe' });
  } catch {
    // Clean up temp dir on clone failure
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw new CliError(
      'API_ERROR',
      `Failed to clone repository: ${parsed.owner}/${parsed.repo}`,
      'Check the repository URL and your network connection'
    );
  }

  return tempDir;
}

/**
 * Clean up a temporary directory.
 */
function cleanupTempDir(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

/**
 * Read the plugin manifest from a cloned repository.
 */
function readPluginManifest(
  repoDir: string,
  parsed: ParsedSource
): PluginManifest {
  const basePath = parsed.path ? path.join(repoDir, parsed.path) : repoDir;
  const manifestPath = path.join(basePath, '.claude-plugin', 'plugin.json');

  if (!fs.existsSync(manifestPath)) {
    throw new CliError(
      'NOT_FOUND',
      'Plugin manifest not found',
      'Ensure .claude-plugin/plugin.json exists in the plugin root'
    );
  }

  try {
    const content = fs.readFileSync(manifestPath, 'utf-8');
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
 * Discover available components in a cloned repository.
 */
function discoverComponents(
  repoDir: string,
  parsed: ParsedSource
): DiscoveredComponents {
  const basePath = parsed.path ? path.join(repoDir, parsed.path) : repoDir;
  const result: DiscoveredComponents = {
    skills: [],
    commands: [],
    hooks: [],
  };

  const componentTypes: ComponentType[] = ['skills', 'commands', 'hooks'];

  for (const type of componentTypes) {
    const typePath = path.join(basePath, type);
    if (fs.existsSync(typePath)) {
      const entries = fs.readdirSync(typePath, { withFileTypes: true });
      result[type] = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    }
  }

  return result;
}

/**
 * Copy a component from the cloned repository to the target directory.
 */
function copyComponent(
  repoDir: string,
  parsed: ParsedSource,
  componentType: ComponentType,
  componentName: string,
  targetDir: string
): void {
  const basePath = parsed.path ? path.join(repoDir, parsed.path) : repoDir;
  const srcPath = path.join(basePath, componentType, componentName);
  const destPath = path.join(targetDir, '.claude', componentType, componentName);

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.cpSync(srcPath, destPath, { recursive: true });
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

  // Clone repo to temp directory
  const repoDir = cloneRepo(parsed);

  try {
    // Read manifest from cloned repo
    const manifest = readPluginManifest(repoDir, parsed);

    // Discover available components
    const discovered = discoverComponents(repoDir, parsed);

    // Determine what to install
    const toInstall = determineComponentsToInstall(options, discovered);

    const targetDir = options.targetDir || process.cwd();
    const installed: InstalledComponent[] = [];

    // Install skills
    for (const skillName of toInstall.skills) {
      const destPath = path.join(targetDir, '.claude', 'skills', skillName);

      if (fs.existsSync(destPath)) {
        if (!options.force) {
          console.error(`  Skipping existing skill: ${skillName}`);
          continue;
        }
        fs.rmSync(destPath, { recursive: true });
      }

      copyComponent(repoDir, parsed, 'skills', skillName, targetDir);
      installed.push({ name: skillName, type: 'skills', path: destPath });
      console.error(`  Installed skill: ${skillName}`);
    }

    // Install commands
    for (const cmdName of toInstall.commands) {
      const destPath = path.join(targetDir, '.claude', 'commands', cmdName);

      if (fs.existsSync(destPath)) {
        if (!options.force) {
          console.error(`  Skipping existing command: ${cmdName}`);
          continue;
        }
        fs.rmSync(destPath, { recursive: true });
      }

      copyComponent(repoDir, parsed, 'commands', cmdName, targetDir);
      installed.push({ name: cmdName, type: 'commands', path: destPath });
      console.error(`  Installed command: ${cmdName}`);
    }

    // Install hooks
    for (const hookName of toInstall.hooks) {
      const destPath = path.join(targetDir, '.claude', 'hooks', hookName);

      if (fs.existsSync(destPath)) {
        if (!options.force) {
          console.error(`  Skipping existing hook: ${hookName}`);
          continue;
        }
        fs.rmSync(destPath, { recursive: true });
      }

      copyComponent(repoDir, parsed, 'hooks', hookName, targetDir);
      installed.push({ name: hookName, type: 'hooks', path: destPath });
      console.error(`  Installed hook: ${hookName}`);
    }

    // Update agentio.json
    addPlugin(targetDir, manifest.name, {
      source: source,
      version: manifest.version,
      components: getInstalledComponentTypes(options),
      installedComponents: installed,
    });

    return {
      success: true,
      manifest,
      installed,
    };
  } finally {
    // Always cleanup temp directory
    cleanupTempDir(repoDir);
  }
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
