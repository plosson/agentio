import type { Command } from 'commander';
import type { ServiceClient } from '../types/service';
import type { AgentioPlugin } from '../plugin-sdk';

export interface ProfileAddOptions {
  profile?: string;
  readOnly?: boolean;
}

export interface ProfilePlugin<TCredentials extends object> {
  add(options: ProfileAddOptions): Promise<void>;
  createClient(credentials: TCredentials): ServiceClient;
  /** Return replacement credentials; the host remains responsible for persistence. */
  reauthenticate?(credentials: TCredentials | null, profileName: string): Promise<TCredentials>;
}

export interface CredentialLifecycle<TCredentials extends object> {
  /** Credential fields that must never be sent to a remote agent. */
  readonly secretFields: readonly Extract<keyof TCredentials, string>[];
  /** Whether this credential shape supports refresh. */
  applies(credentials: unknown): credentials is TCredentials;
  /** Whether the credentials expire within the supplied buffer. */
  isStale(credentials: TCredentials, now: number, bufferMs: number): boolean;
  /** Return refreshed credentials without persisting them. */
  refresh(credentials: TCredentials): Promise<TCredentials>;
}

/** Type-erased lifecycle shape used by host-side credential dispatch. */
export type RegisteredCredentialLifecycle = CredentialLifecycle<any>;

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

export interface ServicePlugin<
  TCredentials extends object = Record<string, unknown>,
  TRefreshCredentials extends object = TCredentials,
> extends ServiceRegistration {
  readonly apiVersion: 1;
  readonly displayName: string;
  readonly description: string;
  readonly profile?: ProfilePlugin<TCredentials>;
  readonly credentialLifecycle?: CredentialLifecycle<TRefreshCredentials>;
}

/** Type-erased shape used only after a plugin has crossed into the host registry. */
export type RegisteredServicePlugin = ServicePlugin<any, any> | AgentioPlugin<any>;

export function isDeclarativePlugin(plugin: unknown): plugin is AgentioPlugin<any> {
  return typeof plugin === 'object' && plugin !== null && 'commands' in plugin;
}

export function isLegacyServicePlugin(plugin: RegisteredServicePlugin): plugin is ServicePlugin<any, any> {
  return 'registerCommands' in plugin;
}

/** Keep each plugin definition credential-typed without widening its literals. */
export function defineServicePlugin<
  TCredentials extends object = Record<string, unknown>,
  TRefreshCredentials extends object = TCredentials,
>() {
  return <const T extends ServicePlugin<TCredentials, TRefreshCredentials>>(plugin: T): T => plugin;
}
