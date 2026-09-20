export interface StoredCredentials {
  [service: string]: {
    [profile: string]: Record<string, unknown>;
  };
}
