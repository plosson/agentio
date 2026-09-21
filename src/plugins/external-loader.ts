import { readdir } from 'fs/promises';
import { delimiter, extname, resolve } from 'path';
import { pathToFileURL } from 'url';
import type { AgentioPlugin } from '../plugin-sdk';
import { isDeclarativePlugin } from './types';

function pluginExport(module: Record<string, unknown>, source: string): AgentioPlugin<any> {
  const candidate = module.default ?? module.plugin;
  if (!candidate) throw new Error(`External plugin ${source} has no default or named "plugin" export`);
  if (!isDeclarativePlugin(candidate)) {
    throw new Error(`External plugin ${source} must use the declarative Agentio plugin contract`);
  }
  return candidate;
}

async function loadFile(path: string): Promise<AgentioPlugin<any>> {
  const module = await import(pathToFileURL(resolve(path)).href) as Record<string, unknown>;
  return pluginExport(module, path);
}

async function pluginFiles(path: string): Promise<string[]> {
  const absolute = resolve(path);
  const extension = extname(absolute);
  if (extension === '.js' || extension === '.mjs' || extension === '.ts') return [absolute];
  const entries = await readdir(absolute, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(?:m?js|ts)$/.test(entry.name))
    .map((entry) => resolve(absolute, entry.name))
    .sort();
}

/**
 * Load explicitly trusted plugin files/directories. Nothing is scanned unless
 * AGENTIO_PLUGIN_PATHS is set. Paths use the platform PATH delimiter.
 */
export async function loadExternalPlugins(raw = process.env.AGENTIO_PLUGIN_PATHS): Promise<AgentioPlugin<any>[]> {
  if (!raw?.trim() || process.env.AGENTIO_SAFE_MODE === '1') return [];
  const paths = raw.split(delimiter).map((path) => path.trim()).filter(Boolean);
  const files = (await Promise.all(paths.map(pluginFiles))).flat();
  const plugins: AgentioPlugin<any>[] = [];
  for (const file of files) plugins.push(await loadFile(file));
  return plugins;
}
