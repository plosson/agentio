import * as fs from 'fs';
import * as path from 'path';
import type { AgentioJson, AgentioPluginEntry } from '../../types/claude-plugin';

const AGENTIO_JSON_FILE = 'agentio.json';

/**
 * Get the path to agentio.json in the given directory.
 */
function getAgentioJsonPath(dir: string): string {
  return path.join(dir, AGENTIO_JSON_FILE);
}

/**
 * Load agentio.json from the given directory.
 * Returns empty structure if file doesn't exist.
 */
export function loadAgentioJson(dir: string): AgentioJson {
  const filePath = getAgentioJsonPath(dir);

  if (!fs.existsSync(filePath)) {
    return { plugins: {} };
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(content) as AgentioJson;

  // Ensure plugins object exists
  if (!data.plugins) {
    data.plugins = {};
  }

  return data;
}

/**
 * Save agentio.json to the given directory.
 */
export function saveAgentioJson(dir: string, data: AgentioJson): void {
  const filePath = getAgentioJsonPath(dir);
  const content = JSON.stringify(data, null, 2) + '\n';
  fs.writeFileSync(filePath, content);
}

/**
 * Check if agentio.json exists in the given directory.
 */
export function agentioJsonExists(dir: string): boolean {
  return fs.existsSync(getAgentioJsonPath(dir));
}

/**
 * Add or update a plugin entry in agentio.json.
 */
export function addPlugin(
  dir: string,
  name: string,
  entry: AgentioPluginEntry
): void {
  const data = loadAgentioJson(dir);
  data.plugins[name] = entry;
  saveAgentioJson(dir, data);
}

/**
 * Remove a plugin entry from agentio.json.
 * Returns true if plugin was found and removed.
 */
export function removePlugin(dir: string, name: string): boolean {
  const data = loadAgentioJson(dir);

  if (!data.plugins[name]) {
    return false;
  }

  delete data.plugins[name];
  saveAgentioJson(dir, data);
  return true;
}

/**
 * Get a plugin entry from agentio.json.
 */
export function getPlugin(
  dir: string,
  name: string
): AgentioPluginEntry | undefined {
  const data = loadAgentioJson(dir);
  return data.plugins[name];
}

/**
 * List all plugins in agentio.json.
 */
export function listPlugins(
  dir: string
): Array<{ name: string; entry: AgentioPluginEntry }> {
  const data = loadAgentioJson(dir);
  return Object.entries(data.plugins).map(([name, entry]) => ({
    name,
    entry,
  }));
}
