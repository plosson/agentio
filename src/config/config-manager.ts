import { homedir } from 'os';
import { join } from 'path';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import type { Config, ServiceName } from '../types/config';

const CONFIG_DIR = join(homedir(), '.config', 'agentio');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

const ALL_SERVICES: ServiceName[] = ['gdocs', 'gmail', 'gchat', 'github', 'jira', 'slack', 'telegram', 'discourse', 'sql'];

const DEFAULT_CONFIG: Config = {
  profiles: {},
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
  profileName: string
): Promise<string | null> {
  const config = await loadConfig();

  const serviceProfiles = config.profiles[service] || [];
  if (!serviceProfiles.includes(profileName)) {
    return null;
  }

  return profileName;
}

/**
 * Resolve profile name for a service.
 * - If profileName is provided, validates it exists
 * - If not provided and exactly 1 profile exists, returns that profile
 * - Returns null if no profiles exist or if multiple profiles exist without explicit selection
 */
export async function resolveProfile(
  service: ServiceName,
  profileName?: string
): Promise<{ profile: string | null; error?: 'none' | 'multiple' }> {
  const config = await loadConfig();
  const serviceProfiles = config.profiles[service] || [];

  if (profileName) {
    // Explicit profile requested - validate it exists
    if (!serviceProfiles.includes(profileName)) {
      return { profile: null };
    }
    return { profile: profileName };
  }

  // No profile specified - check if we can auto-select
  if (serviceProfiles.length === 0) {
    return { profile: null, error: 'none' };
  }

  if (serviceProfiles.length === 1) {
    return { profile: serviceProfiles[0] };
  }

  // Multiple profiles exist - user must specify
  return { profile: null, error: 'multiple' };
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

  await saveConfig(config);
  return true;
}

export async function listProfiles(service?: ServiceName): Promise<{
  service: ServiceName;
  profiles: string[];
}[]> {
  const config = await loadConfig();
  const services = service ? [service] : ALL_SERVICES;

  return services.map((svc) => ({
    service: svc,
    profiles: config.profiles[svc] || [],
  }));
}

export async function getEnv(key: string): Promise<string | undefined> {
  const config = await loadConfig();
  return config.env?.[key];
}

export async function setEnv(key: string, value: string): Promise<void> {
  const config = await loadConfig();
  if (!config.env) {
    config.env = {};
  }
  config.env[key] = value;
  await saveConfig(config);
}

export async function unsetEnv(key: string): Promise<boolean> {
  const config = await loadConfig();
  if (!config.env || !(key in config.env)) {
    return false;
  }
  delete config.env[key];
  await saveConfig(config);
  return true;
}

export async function listEnv(): Promise<Record<string, string>> {
  const config = await loadConfig();
  return config.env || {};
}

export { CONFIG_DIR, CONFIG_FILE };
