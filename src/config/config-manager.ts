import { homedir } from 'os';
import { join } from 'path';
import { mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { loadVault, updateVault, CURRENT_VAULT_VERSION } from '../vault/vault';
import { ALL_SERVICES } from '../types/config';
import type { Config, ServiceName, ProfileEntry, ProfileValue } from '../types/config';

const CONFIG_DIR = join(process.env.HOME || homedir(), '.config', 'agentio');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json'); // kept for backward-compat imports elsewhere

/**
 * Normalize a profile value to ProfileEntry format
 */
function normalizeProfile(entry: ProfileValue): ProfileEntry {
  return typeof entry === 'string' ? { name: entry } : entry;
}

/**
 * Get the profile name from a ProfileValue
 */
export function getProfileName(entry: ProfileValue): string {
  return typeof entry === 'string' ? entry : entry.name;
}

export async function ensureConfigDir(): Promise<void> {
  if (!existsSync(CONFIG_DIR)) {
    await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

export async function loadConfig(): Promise<Config> {
  const vault = await loadVault();
  return vault.config;
}

export async function saveConfig(config: Config): Promise<void> {
  await updateVault((vault) => ({ ...vault, config }));
}

/** Atomic read-modify-write of the config; `mutate` runs under the vault write lock. */
export async function updateConfig<T>(mutate: (config: Config) => T | Promise<T>): Promise<T> {
  let result!: T;
  await updateVault(async (vault) => {
    result = await mutate(vault.config);
  });
  return result;
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

export type ResolveProfileResult =
  | { profile: string; readOnly?: boolean }
  | { profile: null; error: 'none' }
  | { profile: null; error: 'multiple'; names: string[] };

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
): Promise<ResolveProfileResult> {
  const config = await loadConfig();
  const serviceProfiles = config.profiles[service] || [];

  if (profileName) {
    // Explicit profile requested - validate it exists
    const found = serviceProfiles.find((p) => getProfileName(p) === profileName);
    if (!found) {
      return { profile: null, error: 'none' };
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
  return { profile: null, error: 'multiple', names: serviceProfiles.map(getProfileName) };
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

/** A configured profile, flattened. */
export interface ProfileRef {
  service: ServiceName;
  name: string;
  readOnly?: boolean;
}

/** Every configured profile, in ALL_SERVICES order. */
export async function listProfileRefs(): Promise<ProfileRef[]> {
  return (await listProfiles()).flatMap(({ service, profiles }) =>
    profiles.map((p) => ({ service, name: p.name, readOnly: p.readOnly })),
  );
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
export function setProfileReadOnly(
  service: ServiceName,
  profileName: string,
  readOnly: boolean
): Promise<boolean> {
  return updateConfig((config) => {
    const serviceProfiles = config.profiles[service];
    const index = serviceProfiles?.findIndex((p) => getProfileName(p) === profileName) ?? -1;
    if (!serviceProfiles || index === -1) return false;

    const entry = normalizeProfile(serviceProfiles[index]);
    if (readOnly) {
      entry.readOnly = true;
    } else {
      delete entry.readOnly;
    }
    serviceProfiles[index] = entry;
    return true;
  });
}

export { CONFIG_DIR, CONFIG_FILE };
