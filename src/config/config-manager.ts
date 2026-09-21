import { homedir } from 'os';
import { join } from 'path';
import { mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { loadVault, updateVault } from '../vault/vault';
import { isRemoteMode, remoteProfiles } from '../auth/remote';
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

/** Atomic read-modify-write of the config; `mutate` runs under the vault write lock. */
export function updateConfig<T>(mutate: (config: Config) => T | Promise<T>): Promise<T> {
  return updateVault((vault) => mutate(vault.config));
}

/**
 * The profiles of one service as `ProfileEntry`s, from the vault or, in remote
 * mode, from the hub's allow-listed view (whose readOnly already folds in the
 * key's flag). Every profile read below goes through here.
 */
async function profilesOf(service: ServiceName): Promise<ProfileEntry[]> {
  if (isRemoteMode()) {
    return (await remoteProfiles())
      .filter((r) => r.service === service)
      .map((r) => ({ name: r.name, readOnly: r.readOnly || undefined }));
  }
  const config = await loadConfig();
  return (config.profiles[service] || []).map(normalizeProfile);
}

/** Stable built-in ordering followed by external/stored plugin ids. */
async function configuredServiceIds(): Promise<ServiceName[]> {
  if (isRemoteMode()) {
    const ids = new Set((await remoteProfiles()).map((profile) => profile.service));
    return [...ALL_SERVICES.filter((service) => ids.delete(service)), ...[...ids].sort()];
  }
  const ids = new Set(Object.keys((await loadConfig()).profiles));
  return [...ALL_SERVICES.filter((service) => ids.delete(service)), ...[...ids].sort()];
}

export async function getProfile(
  service: ServiceName,
  profileName: string
): Promise<string | null> {
  return (await resolveProfile(service, profileName)).profile;
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
  const serviceProfiles = await profilesOf(service);

  if (profileName) {
    // Explicit profile requested - validate it exists
    const entry = serviceProfiles.find((p) => p.name === profileName);
    return entry ? { profile: entry.name, readOnly: entry.readOnly } : { profile: null, error: 'none' };
  }

  // No profile specified - check if we can auto-select
  if (serviceProfiles.length === 0) return { profile: null, error: 'none' };
  if (serviceProfiles.length === 1) {
    return { profile: serviceProfiles[0].name, readOnly: serviceProfiles[0].readOnly };
  }

  // Multiple profiles exist - user must specify
  return { profile: null, error: 'multiple', names: serviceProfiles.map((p) => p.name) };
}

export interface SetProfileOptions {
  readOnly?: boolean;
}

/** Index of the profile in its service's list, whatever form the entry takes; -1 when absent. */
export function findProfileIndex(config: Config, service: ServiceName, profileName: string): number {
  return config.profiles[service]?.findIndex((p) => getProfileName(p) === profileName) ?? -1;
}

export function hasProfile(config: Config, service: ServiceName, profileName: string): boolean {
  return findProfileIndex(config, service, profileName) !== -1;
}

/** The stored shape of a profile entry. The one place it is built. */
export function profileEntry(name: string, options?: SetProfileOptions): ProfileEntry {
  return { name, ...(options?.readOnly ? { readOnly: true } : {}) };
}

/** The options an existing entry carries, whatever form it is stored in. */
export function optionsOf(entry: ProfileValue): SetProfileOptions {
  return { readOnly: normalizeProfile(entry).readOnly };
}

/** Add or replace a profile entry in `config`, in place. */
export function putProfileEntry(
  config: Config,
  service: ServiceName,
  profileName: string,
  options?: SetProfileOptions
): void {
  const existingIndex = findProfileIndex(config, service, profileName);
  if (existingIndex === -1) (config.profiles[service] ??= []).push(profileEntry(profileName, options));
  else config.profiles[service]![existingIndex] = profileEntry(profileName, options);
}

/** The entry at `index`, renamed in place, keeping every other field it carries. */
export function renameProfileEntry(config: Config, service: ServiceName, index: number, to: string): void {
  const entry = config.profiles[service]![index];
  config.profiles[service]![index] = profileEntry(to, optionsOf(entry));
}

/** The `service/name` form a key's allow-list holds. */
export const profileRef = (service: string, name: string): string => `${service}/${name}`;

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
  const services = service ? [service] : await configuredServiceIds();
  return Promise.all(services.map(async (svc) => ({ service: svc, profiles: await profilesOf(svc) })));
}

/**
 * Check if a profile is read-only
 */
export async function isProfileReadOnly(
  service: ServiceName,
  profileName: string
): Promise<boolean> {
  return (await profilesOf(service)).find((p) => p.name === profileName)?.readOnly === true;
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
    const index = findProfileIndex(config, service, profileName);
    if (index === -1) return false;
    const serviceProfiles = config.profiles[service]!;

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
