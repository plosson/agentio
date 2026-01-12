import * as fs from 'fs';
import * as path from 'path';
import type { AgentioJson } from '../../types/claude-plugin';

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
    return { marketplaces: [], plugins: [] };
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(content) as AgentioJson;

  // Ensure arrays exist
  if (!data.marketplaces) {
    data.marketplaces = [];
  }
  if (!data.plugins) {
    data.plugins = [];
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
 * Add a marketplace URL if not already present.
 */
export function addMarketplace(dir: string, url: string): void {
  const data = loadAgentioJson(dir);
  if (!data.marketplaces.includes(url)) {
    data.marketplaces.push(url);
    saveAgentioJson(dir, data);
  }
}

/**
 * Add a plugin name if not already present.
 */
export function addPlugin(dir: string, name: string): void {
  const data = loadAgentioJson(dir);
  if (!data.plugins.includes(name)) {
    data.plugins.push(name);
    saveAgentioJson(dir, data);
  }
}

/**
 * Remove a marketplace URL.
 * Returns true if found and removed.
 */
export function removeMarketplace(dir: string, url: string): boolean {
  const data = loadAgentioJson(dir);
  const index = data.marketplaces.indexOf(url);
  if (index === -1) {
    return false;
  }
  data.marketplaces.splice(index, 1);
  saveAgentioJson(dir, data);
  return true;
}

/**
 * Remove a plugin name.
 * Returns true if found and removed.
 */
export function removePlugin(dir: string, name: string): boolean {
  const data = loadAgentioJson(dir);
  const index = data.plugins.indexOf(name);
  if (index === -1) {
    return false;
  }
  data.plugins.splice(index, 1);
  saveAgentioJson(dir, data);
  return true;
}
