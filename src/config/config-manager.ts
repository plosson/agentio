import { homedir } from 'os';
import { join } from 'path';
import { mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { loadVault, saveVault, CURRENT_VAULT_VERSION } from '../vault/vault';
import type { Config, ServiceName, ProfileEntry, ProfileValue } from '../types/config';

const CONFIG_DIR = join(process.env.HOME || homedir(), '.config', 'agentio');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json'); // kept for backward-compat imports elsewhere

const ALL_SERVICES: ServiceName[] = ['gdocs', 'gdrive', 'gmail', 'gcal', 'gtasks', 'gchat', 'gsheets', 'github', 'jira', 'slack', 'telegram', 'whatsapp', 'discourse', 'sql'];

/**
 * Normalize a profile value to ProfileEntry format
 */
function normalizeProfile(entry: ProfileValue): ProfileEntry {
  return typeof entry === 'string' ? { name: entry } : entry;
}

/**
 * Get the profile name from a ProfileValue
 */
function getProfileName(entry: ProfileValue): string {
  return typeof entry === 'string' ? entry : entry.name;
}

export async function ensureConfigDir(): Promise<void> {
  if (!existsSync(CONFIG_DIR)) {
    await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * Migrate legacy `config.gateway` into `config.daemon` in place.
 * Pure: returns a new Config value; does not mutate input.
 * - If `daemon` already exists, drops `gateway` untouched.
 * - Otherwise moves `gateway` verbatim under `daemon`.
 */
export function migrateGatewayToDaemon(config: Config): Config {
  if (!config.gateway) return config;
  if (config.daemon) {
    const { gateway: _drop, ...rest } = config;
    return rest;
  }
  const { gateway, ...rest } = config;
  return { ...rest, daemon: gateway };
}

export async function loadConfig(): Promise<Config> {
  const vault = await loadVault();
  const migrated = migrateGatewayToDaemon(vault.config);
  // If migration changed anything, persist it.
  if (migrated !== vault.config) {
    await saveVault({
      version: CURRENT_VAULT_VERSION,
      config: migrated,
      credentials: vault.credentials,
    });
  }
  return migrated;
}

export async function saveConfig(config: Config): Promise<void> {
  const vault = await loadVault();
  await saveVault({
    version: CURRENT_VAULT_VERSION,
    config,
    credentials: vault.credentials,
  });
}

export async function getProfile(
  service: ServiceName,
  profileName: string
): Promise<string | null> {
  const config = await loadConfig();

  const serviceProfiles = config.profiles[service] || [];
  const found = serviceProfiles.find((p) => getProfileName(p) === profileName);
  if (!found) {
    return null;
  }

  return profileName;
}

/**
 * Resolve profile name for a service.
 * - If profileName is provided, validates it exists
 * - If not provided and exactly 1 profile exists, returns that profile
 * - Returns null if no profiles exist or if multiple profiles exist without explicit selection
 * - Also returns the readOnly status of the resolved profile
 */
export async function resolveProfile(
  service: ServiceName,
  profileName?: string
): Promise<{ profile: string | null; readOnly?: boolean; error?: 'none' | 'multiple' }> {
  const config = await loadConfig();
  const serviceProfiles = config.profiles[service] || [];

  if (profileName) {
    // Explicit profile requested - validate it exists
    const found = serviceProfiles.find((p) => getProfileName(p) === profileName);
    if (!found) {
      return { profile: null };
    }
    const entry = normalizeProfile(found);
    return { profile: entry.name, readOnly: entry.readOnly };
  }

  // No profile specified - check if we can auto-select
  if (serviceProfiles.length === 0) {
    return { profile: null, error: 'none' };
  }

  if (serviceProfiles.length === 1) {
    const entry = normalizeProfile(serviceProfiles[0]);
    return { profile: entry.name, readOnly: entry.readOnly };
  }

  // Multiple profiles exist - user must specify
  return { profile: null, error: 'multiple' };
}

export interface SetProfileOptions {
  readOnly?: boolean;
}

export async function setProfile(
  service: ServiceName,
  profileName: string,
  options?: SetProfileOptions
): Promise<void> {
  const config = await loadConfig();

  if (!config.profiles[service]) {
    config.profiles[service] = [];
  }

  const existingIndex = config.profiles[service]!.findIndex(
    (p) => getProfileName(p) === profileName
  );

  const entry: ProfileEntry = {
    name: profileName,
    ...(options?.readOnly ? { readOnly: true } : {}),
  };

  if (existingIndex === -1) {
    config.profiles[service]!.push(entry);
  } else {
    // Update existing profile
    config.profiles[service]![existingIndex] = entry;
  }

  await saveConfig(config);
}

export async function removeProfile(
  service: ServiceName,
  profileName: string
): Promise<boolean> {
  const config = await loadConfig();

  const serviceProfiles = config.profiles[service];
  if (!serviceProfiles) {
    return false;
  }

  const found = serviceProfiles.find((p) => getProfileName(p) === profileName);
  if (!found) {
    return false;
  }

  config.profiles[service] = serviceProfiles.filter(
    (p) => getProfileName(p) !== profileName
  );

  await saveConfig(config);
  return true;
}

export async function listProfiles(service?: ServiceName): Promise<{
  service: ServiceName;
  profiles: ProfileEntry[];
}[]> {
  const config = await loadConfig();
  const services = service ? [service] : ALL_SERVICES;

  return services.map((svc) => ({
    service: svc,
    profiles: (config.profiles[svc] || []).map(normalizeProfile),
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

/**
 * Check if a profile is read-only
 */
export async function isProfileReadOnly(
  service: ServiceName,
  profileName: string
): Promise<boolean> {
  const config = await loadConfig();
  const serviceProfiles = config.profiles[service] || [];
  const found = serviceProfiles.find((p) => getProfileName(p) === profileName);
  if (!found) {
    return false;
  }
  return normalizeProfile(found).readOnly === true;
}

/**
 * Set the read-only status of a profile
 */
export async function setProfileReadOnly(
  service: ServiceName,
  profileName: string,
  readOnly: boolean
): Promise<boolean> {
  const config = await loadConfig();
  const serviceProfiles = config.profiles[service];
  if (!serviceProfiles) {
    return false;
  }

  const index = serviceProfiles.findIndex((p) => getProfileName(p) === profileName);
  if (index === -1) {
    return false;
  }

  const entry = normalizeProfile(serviceProfiles[index]);
  if (readOnly) {
    entry.readOnly = true;
  } else {
    delete entry.readOnly;
  }
  serviceProfiles[index] = entry;

  await saveConfig(config);
  return true;
}

export { CONFIG_DIR, CONFIG_FILE };
