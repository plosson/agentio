/** Public, types-only contract for independently packaged Agentio plugins. */

export type PluginErrorCode =
  | 'AUTH_FAILED'
  | 'TOKEN_EXPIRED'
  | 'PROFILE_NOT_FOUND'
  | 'INVALID_PARAMS'
  | 'API_ERROR'
  | 'NETWORK_ERROR'
  | 'PERMISSION_DENIED'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'CONFIG_ERROR';

export interface ValidationResult {
  valid: boolean;
  info?: string;
  error?: string;
}

export interface SetupOptions {
  profile?: string;
  readOnly?: boolean;
  [name: string]: unknown;
}

export interface SetupResult<Credentials extends object> {
  credentials: Credentials;
  suggestedProfileName: string;
  info?: string;
}

export interface SetupContext {
  prompt(question: string, options?: { secret?: boolean }): Promise<string>;
  confirm(question: string): Promise<boolean>;
  log(...parts: unknown[]): void;
  fail(code: PluginErrorCode, message: string, suggestion?: string): never;
  fetch: typeof fetch;
}

export interface RunContext<Credentials extends object = Record<string, unknown>> {
  readonly credentials: Credentials;
  readonly profile: string;
  readonly signal: AbortSignal;
  readonly fetch: typeof fetch;
  log(...parts: unknown[]): void;
  fail(code: PluginErrorCode, message: string, suggestion?: string): never;
}

export interface ArgumentSpec {
  name: string;
  description: string;
  required?: boolean;
  variadic?: boolean;
}

export interface OptionSpec {
  flags: string;
  description: string;
  defaultValue?: string | boolean;
}

export interface CommandInput {
  args: Record<string, string | string[] | undefined>;
  options: Record<string, unknown>;
  stdin?: string | Record<string, unknown>;
}

export interface CommandSpec<Credentials extends object = Record<string, unknown>> {
  /** Nested path below the plugin id, for example `issues list`. */
  path: string;
  description: string;
  arguments?: readonly ArgumentSpec[];
  options?: readonly OptionSpec[];
  input?: 'none' | 'text' | 'json';
  access?: 'read' | 'write';
  examples: readonly string[];
  run(input: CommandInput, context: RunContext<Credentials>): Promise<unknown>;
  /** Human rendering. Without it the host prints JSON. */
  format?(value: unknown): string;
}

export interface RefreshSpec<Credentials extends object> {
  readonly secretFields: readonly Extract<keyof Credentials, string>[];
  applies(credentials: unknown): credentials is Credentials;
  isStale(credentials: Credentials, now: number, bufferMs: number): boolean;
  run(credentials: Credentials): Promise<Credentials>;
}

export interface ProfileSpec<Credentials extends object> {
  setup(options: SetupOptions, context: SetupContext): Promise<SetupResult<Credentials>>;
  validate(context: RunContext<Credentials>): Promise<ValidationResult>;
  reauthenticate?(credentials: Credentials | null, profileName: string, context: SetupContext): Promise<Credentials>;
  refresh?: RefreshSpec<Credentials>;
}

export interface AgentioPlugin<Credentials extends object = Record<string, unknown>> {
  readonly apiVersion: 1;
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly brand?: { color?: string; iconPath?: string };
  readonly profile?: ProfileSpec<Credentials>;
  readonly commands: readonly CommandSpec<Credentials>[];
}

