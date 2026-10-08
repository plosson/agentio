import type { Command } from 'commander';
import type { ServiceClient } from '../types/service';
import type { AgentioPlugin, SetupContext, SetupResult } from '../plugin-sdk';
import type { PluginStore } from '../daemon/plugin-store';

export interface ProfileAddOptions {
  profile?: string;
  readOnly?: boolean;
}

export interface ProfilePlugin<TCredentials extends object> {
  /** Authenticate and return credentials, asking only through `context`; the host names and persists them. */
  setup(options: ProfileAddOptions, context: SetupContext): Promise<SetupResult<TCredentials>>;
  createClient(credentials: TCredentials): ServiceClient;
  /** Sign in again and return replacement credentials, asking only through `context`; the host persists them. */
  reauthenticate?(credentials: TCredentials | null, profileName: string, context: SetupContext): Promise<TCredentials>;
  /**
   * What the admin may show about a profile without calling the service: the
   * account it signs in as and a link to it. Pick public fields only (an
   * email, a username, a server the owner chose); never a token, key or a URL
   * that is itself a secret. The host keeps only http(s) links.
   */
  describe?(credentials: TCredentials): ProfileDetails;
}

/** Public facts about a profile, for people to read. */
export interface ProfileDetails {
  account?: string;
  url?: string;
  /** True when `url` is the service's own web app, not an address the profile signs in to. */
  serviceUrl?: true;
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
 * Where a session stands. `needs_pairing` and `replaced` are final: the
 * session stops reconnecting until the profile is paired again or the other
 * connection goes away and the daemon restarts it.
 */
export type SessionState = 'connecting' | 'open' | 'needs_pairing' | 'replaced' | 'closed';

export interface SessionStatus {
  state: SessionState;
  /** The linked account, such as a phone number, once known. */
  account?: string;
  /** Why the session is not open, for people to read. */
  detail?: string;
}

/** One call to a session's own operations, already authorised by the daemon. */
export interface SessionRequest {
  operation: string;
  params: Record<string, unknown>;
  /** The profile is read-only for this caller: the session must not write, not even read receipts. */
  readOnly: boolean;
}

export type SessionLogFields = Record<string, string | number | boolean | undefined>;

/** What the daemon lends a session: its own store, and the daemon's log. */
export interface SessionHost {
  store: PluginStore;
  log(fields: SessionLogFields): void;
}

export interface Session {
  status(): SessionStatus;
  /** The service's own operations. Throw CliError for anything the caller should see. */
  handle(request: SessionRequest): Promise<unknown>;
  /** Close the connection after writing the last state; with `logout`, unlink the account first, best effort. */
  stop(options?: { logout?: boolean }): Promise<void>;
}

export type PairingStatus =
  | { state: 'waiting'; qr?: string; code?: string }
  | { state: 'paired'; account?: string }
  | { state: 'expired' }
  | { state: 'error'; message: string };

export interface Pairing {
  status(): PairingStatus;
  /** Settles when pairing ends: with the now open session when paired, else with null. */
  readonly done: Promise<{ session: Session; account?: string } | null>;
  cancel(): Promise<void>;
}

/**
 * A long-lived connection the daemon keeps open per profile while the vault
 * is unlocked. Only the daemon calls these; the CLI reaches a session through
 * the daemon's routes.
 */
export interface SessionPlugin {
  /** Operations that act on other people's view, refused on a read-only profile. */
  readonly writeOperations: readonly string[];
  /** Open the connection for one profile, whose store already holds its state. */
  start(profile: string, host: SessionHost): Promise<Session>;
  /** Link a new account, writing its state to host.store, which starts empty. */
  pair(profile: string, options: { phone?: string }, host: SessionHost): Promise<Pairing>;
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
  /** `url`: the service's own web app (mail.google.com…), the link for profiles that have none of their own. */
  readonly brand?: { color?: string; iconPath?: string; url?: string };
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
  /** A long-lived connection the daemon keeps open per profile while the vault is unlocked. */
  readonly session?: SessionPlugin;
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
