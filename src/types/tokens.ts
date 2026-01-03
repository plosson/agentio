export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;
  token_type: string;
  scope?: string;
}

export interface StoredCredentials {
  [service: string]: {
    [profile: string]: Record<string, unknown>;
  };
}
