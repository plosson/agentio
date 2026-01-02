export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;
  token_type: string;
  scope?: string;
}

export interface StoredTokens {
  [service: string]: {
    [profile: string]: OAuthTokens;
  };
}
