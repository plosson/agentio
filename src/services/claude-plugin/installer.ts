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
    agents: [],
  };

  const componentTypes: ComponentType[] = ['skills', 'commands', 'hooks', 'agents'];

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
  const installAll = !options.skills && !options.commands && !options.hooks && !options.agents;

  return {
    skills: installAll || options.skills ? discovered.skills : [],
    commands: installAll || options.commands ? discovered.commands : [],
    hooks: installAll || options.hooks ? discovered.hooks : [],
    agents: installAll || options.agents ? discovered.agents : [],
  };
}

/**
 * Get the component types array for agentio.json based on what was installed.
 */
function getInstalledComponentTypes(
  options: PluginInstallOptions
): ComponentType[] | undefined {
  const installAll = !options.skills && !options.commands && !options.hooks && !options.agents;
  if (installAll) return undefined; // Default: all

  const types: ComponentType[] = [];
  if (options.skills) types.push('skills');
  if (options.commands) types.push('commands');
  if (options.hooks) types.push('hooks');
  if (options.agents) types.push('agents');
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
  const verbose = options.verbose ?? false;

  if (verbose) {
    console.error(`\n[verbose] Parsed source:`);
    console.error(`  Owner: ${parsed.owner}`);
    console.error(`  Repo: ${parsed.repo}`);
    console.error(`  Branch: ${parsed.branch ?? '(default)'}`);
    console.error(`  Path: ${parsed.path ?? '(root)'}`);
    console.error(`  Clone URL: ${buildGitCloneUrl(parsed)}`);
  }

  // Clone repo to temp directory
  if (verbose) {
    console.error(`\n[verbose] Cloning repository...`);
  }
  const repoDir = cloneRepo(parsed);
  if (verbose) {
    console.error(`[verbose] Cloned to: ${repoDir}`);
  }

  try {
    // Read manifest from cloned repo
    const manifest = readPluginManifest(repoDir, parsed);

    if (verbose) {
      console.error(`\n[verbose] Plugin manifest:`);
      console.error(`  Name: ${manifest.name}`);
      console.error(`  Version: ${manifest.version}`);
      if (manifest.description) {
        console.error(`  Description: ${manifest.description}`);
      }
    }

    // Discover available components
    const discovered = discoverComponents(repoDir, parsed);

    if (verbose) {
      const totalDiscovered = discovered.skills.length + discovered.commands.length + discovered.hooks.length + discovered.agents.length;
      console.error(`\n[verbose] Discovered ${totalDiscovered} component(s):`);
      if (discovered.skills.length > 0) {
        console.error(`  Skills (${discovered.skills.length}): ${discovered.skills.join(', ')}`);
      }
      if (discovered.commands.length > 0) {
        console.error(`  Commands (${discovered.commands.length}): ${discovered.commands.join(', ')}`);
      }
      if (discovered.hooks.length > 0) {
        console.error(`  Hooks (${discovered.hooks.length}): ${discovered.hooks.join(', ')}`);
      }
      if (discovered.agents.length > 0) {
        console.error(`  Agents (${discovered.agents.length}): ${discovered.agents.join(', ')}`);
      }
    }

    // Determine what to install
    const toInstall = determineComponentsToInstall(options, discovered);

    if (verbose) {
      const totalToInstall = toInstall.skills.length + toInstall.commands.length + toInstall.hooks.length + toInstall.agents.length;
      console.error(`\n[verbose] Installing ${totalToInstall} component(s):`);
      if (toInstall.skills.length > 0) {
        console.error(`  Skills: ${toInstall.skills.join(', ')}`);
      }
      if (toInstall.commands.length > 0) {
        console.error(`  Commands: ${toInstall.commands.join(', ')}`);
      }
      if (toInstall.hooks.length > 0) {
        console.error(`  Hooks: ${toInstall.hooks.join(', ')}`);
      }
      if (toInstall.agents.length > 0) {
        console.error(`  Agents: ${toInstall.agents.join(', ')}`);
      }
    }

    const targetDir = options.targetDir || process.cwd();
    const installed: InstalledComponent[] = [];

    if (verbose) {
      console.error(`\n[verbose] Target directory: ${targetDir}`);
    }

    // Install skills
    for (const skillName of toInstall.skills) {
      const destPath = path.join(targetDir, '.claude', 'skills', skillName);

      if (fs.existsSync(destPath)) {
        if (!options.force) {
          console.error(`  Skipping existing skill: ${skillName}`);
          if (verbose) {
            console.error(`    [verbose] Path: ${destPath}`);
          }
          continue;
        }
        if (verbose) {
          console.error(`  [verbose] Removing existing: ${destPath}`);
        }
        fs.rmSync(destPath, { recursive: true });
      }

      copyComponent(repoDir, parsed, 'skills', skillName, targetDir);
      installed.push({ name: skillName, type: 'skills', path: `.claude/skills/${skillName}` });
      console.error(`  Installed skill: ${skillName}`);
      if (verbose) {
        console.error(`    [verbose] Path: ${destPath}`);
      }
    }

    // Install commands
    for (const cmdName of toInstall.commands) {
      const destPath = path.join(targetDir, '.claude', 'commands', cmdName);

      if (fs.existsSync(destPath)) {
        if (!options.force) {
          console.error(`  Skipping existing command: ${cmdName}`);
          if (verbose) {
            console.error(`    [verbose] Path: ${destPath}`);
          }
          continue;
        }
        if (verbose) {
          console.error(`  [verbose] Removing existing: ${destPath}`);
        }
        fs.rmSync(destPath, { recursive: true });
      }

      copyComponent(repoDir, parsed, 'commands', cmdName, targetDir);
      installed.push({ name: cmdName, type: 'commands', path: `.claude/commands/${cmdName}` });
      console.error(`  Installed command: ${cmdName}`);
      if (verbose) {
        console.error(`    [verbose] Path: ${destPath}`);
      }
    }

    // Install hooks
    for (const hookName of toInstall.hooks) {
      const destPath = path.join(targetDir, '.claude', 'hooks', hookName);

      if (fs.existsSync(destPath)) {
        if (!options.force) {
          console.error(`  Skipping existing hook: ${hookName}`);
          if (verbose) {
            console.error(`    [verbose] Path: ${destPath}`);
          }
          continue;
        }
        if (verbose) {
          console.error(`  [verbose] Removing existing: ${destPath}`);
        }
        fs.rmSync(destPath, { recursive: true });
      }

      copyComponent(repoDir, parsed, 'hooks', hookName, targetDir);
      installed.push({ name: hookName, type: 'hooks', path: `.claude/hooks/${hookName}` });
      console.error(`  Installed hook: ${hookName}`);
      if (verbose) {
        console.error(`    [verbose] Path: ${destPath}`);
      }
    }

    // Install agents
    for (const agentName of toInstall.agents) {
      const destPath = path.join(targetDir, '.claude', 'agents', agentName);

      if (fs.existsSync(destPath)) {
        if (!options.force) {
          console.error(`  Skipping existing agent: ${agentName}`);
          if (verbose) {
            console.error(`    [verbose] Path: ${destPath}`);
          }
          continue;
        }
        if (verbose) {
          console.error(`  [verbose] Removing existing: ${destPath}`);
        }
        fs.rmSync(destPath, { recursive: true });
      }

      copyComponent(repoDir, parsed, 'agents', agentName, targetDir);
      installed.push({ name: agentName, type: 'agents', path: `.claude/agents/${agentName}` });
      console.error(`  Installed agent: ${agentName}`);
      if (verbose) {
        console.error(`    [verbose] Path: ${destPath}`);
      }
    }

    // Update agentio.json
    if (verbose) {
      console.error(`\n[verbose] Updating agentio.json`);
    }
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
    if (verbose) {
      console.error(`\n[verbose] Cleaning up temp directory: ${repoDir}`);
    }
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
    const compPath = path.join(targetDir, comp.path);
    if (fs.existsSync(compPath)) {
      fs.rmSync(compPath, { recursive: true });
    }
  }
}
