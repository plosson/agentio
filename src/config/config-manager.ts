import { homedir } from 'os';
import { join } from 'path';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import type { Config, ServiceName, OAuthClientConfig } from '../types/config';

const CONFIG_DIR = join(homedir(), '.config', 'allcli');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG: Config = {
  profiles: {},
  defaults: {},
};

export async function ensureConfigDir(): Promise<void> {
  if (!existsSync(CONFIG_DIR)) {
    await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

export async function loadConfig(): Promise<Config> {
  await ensureConfigDir();

  if (!existsSync(CONFIG_FILE)) {
    await saveConfig(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }

  const content = await readFile(CONFIG_FILE, 'utf-8');
  return JSON.parse(content) as Config;
}

export async function saveConfig(config: Config): Promise<void> {
  await ensureConfigDir();
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export async function getProfile(
  service: ServiceName,
  profileName?: string
): Promise<{ name: string; config: OAuthClientConfig } | null> {
  const config = await loadConfig();
  const name = profileName || config.defaults[service];

  if (!name) {
    return null;
  }

  const serviceProfiles = config.profiles[service];
  if (!serviceProfiles || !serviceProfiles[name]) {
    return null;
  }

  return { name, config: serviceProfiles[name] };
}

export async function setProfile(
  service: ServiceName,
  profileName: string,
  oauthConfig: OAuthClientConfig
): Promise<void> {
  const config = await loadConfig();

  if (!config.profiles[service]) {
    config.profiles[service] = {};
  }

  config.profiles[service]![profileName] = oauthConfig;

  // Set as default if it's the first profile for this service
  if (!config.defaults[service]) {
    config.defaults[service] = profileName;
  }

  await saveConfig(config);
}

export async function removeProfile(
  service: ServiceName,
  profileName: string
): Promise<boolean> {
  const config = await loadConfig();

  const serviceProfiles = config.profiles[service];
  if (!serviceProfiles || !serviceProfiles[profileName]) {
    return false;
  }

  delete serviceProfiles[profileName];

  // Clear default if it was the removed profile
  if (config.defaults[service] === profileName) {
    const remaining = Object.keys(serviceProfiles);
    config.defaults[service] = remaining[0];
  }

  await saveConfig(config);
  return true;
}

export async function listProfiles(service?: ServiceName): Promise<{
  service: ServiceName;
  profiles: string[];
  default?: string;
}[]> {
  const config = await loadConfig();
  const services: ServiceName[] = service ? [service] : ['gmail', 'gchat', 'jira'];

  return services.map((svc) => ({
    service: svc,
    profiles: Object.keys(config.profiles[svc] || {}),
    default: config.defaults[svc],
  }));
}

export { CONFIG_DIR, CONFIG_FILE };
