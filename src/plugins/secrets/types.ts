/** What the vault stores for a secrets profile: one map of names to values. */
export interface SecretsCredentials {
  values: Record<string, string>;
}
