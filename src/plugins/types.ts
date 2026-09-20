import type { Command } from 'commander';
import type { ServiceClient } from '../types/service';

export interface ProfileAddOptions {
  profile?: string;
  readOnly?: boolean;
}

export interface ProfilePlugin {
  add(options: ProfileAddOptions): Promise<void>;
  createClient(credentials: unknown): ServiceClient;
  /** Return replacement credentials; the host remains responsible for persistence. */
  reauthenticate?(credentials: unknown, profileName: string): Promise<object>;
}

export interface CredentialLifecycle {
  /** Credential fields that must never be sent to a remote agent. */
  readonly secretFields: readonly string[];
  /** Whether this credential shape supports refresh. */
  applies(credentials: unknown): boolean;
  /** Whether the credentials expire within the supplied buffer. */
  isStale(credentials: unknown, now: number, bufferMs: number): boolean;
  /** Return refreshed credentials without persisting them. */
  refresh(credentials: unknown): Promise<unknown>;
}

/**
 * The boundary between the CLI host and an in-tree service plugin.
 *
 * A service owns its commands and implementation. The host only needs the
 * metadata required to register it and, for authenticated services, the
 * profile hooks used by `profile add` and `status`.
 */
export interface ServiceRegistration {
  readonly id: string;
  readonly registerCommands: (program: Command) => void;
}

export interface ServicePlugin extends ServiceRegistration {
  readonly apiVersion: 1;
  readonly displayName: string;
  readonly description: string;
  readonly profile?: ProfilePlugin;
  readonly credentialLifecycle?: CredentialLifecycle;
}

/** Keep each plugin definition type-checked without widening its literals. */
export function defineServicePlugin<const T extends ServicePlugin>(plugin: T): T {
  return plugin;
}
