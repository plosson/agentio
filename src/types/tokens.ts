export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  expiry_date?: number;
  token_type: string;
  scope?: string;
}

/** Google tokens as the Docs/Drive/Sheets/Slides/Script/Chat clients store them. */
export interface GoogleCamelTokens {
  accessToken: string;
  refreshToken?: string;
  expiryDate?: number;
  tokenType: string;
  scope?: string;
}

export interface StoredCredentials {
  [service: string]: {
    [profile: string]: Record<string, unknown>;
  };
}
