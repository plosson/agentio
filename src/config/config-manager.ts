import { homedir } from 'os';
import { join } from 'path';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import type { Config, ServiceName } from '../types/config';

const CONFIG_DIR = join(homedir(), '.config', 'agentio');
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

  try {
    const content = await readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(content) as Config;
  } catch {
    // Config file corrupted, back it up and return default
    const backupPath = `${CONFIG_FILE}.backup`;
    const content = await readFile(CONFIG_FILE, 'utf-8').catch(() => '');
    if (content) {
      await writeFile(backupPath, content).catch(() => {});
    }
    await saveConfig(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }
}

export async function saveConfig(config: Config): Promise<void> {
  await ensureConfigDir();
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export async function getProfile(
  service: ServiceName,
  profileName?: string
): Promise<string | null> {
  const config = await loadConfig();
  const name = profileName || config.defaults[service];

  if (!name) {
    return null;
  }

  const serviceProfiles = config.profiles[service] || [];
  if (!serviceProfiles.includes(name)) {
    return null;
  }

  return name;
}

export async function setProfile(
  service: ServiceName,
  profileName: string
): Promise<void> {
  const config = await loadConfig();

  if (!config.profiles[service]) {
    config.profiles[service] = [];
  }

  if (!config.profiles[service]!.includes(profileName)) {
    config.profiles[service]!.push(profileName);
  }

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
  if (!serviceProfiles || !serviceProfiles.includes(profileName)) {
    return false;
  }

  config.profiles[service] = serviceProfiles.filter((p) => p !== profileName);

  // Clear default if it was the removed profile
  if (config.defaults[service] === profileName) {
    config.defaults[service] = config.profiles[service]![0];
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
  const services: ServiceName[] = service ? [service] : ['gmail', 'gchat', 'jira', 'telegram'];

  return services.map((svc) => ({
    service: svc,
    profiles: config.profiles[svc] || [],
    default: config.defaults[svc],
  }));
}

export { CONFIG_DIR, CONFIG_FILE };
