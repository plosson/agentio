export interface PicsiCredentials {
  /** Picsi's own session token, sent as `uk`. This is not a Discord token. */
  token: string;
  name?: string;
  email?: string;
}

export interface PicsiAccount {
  id: string;
  name: string;
  email?: string;
  plan: string;
  creditsRemaining: number;
  creditsTotal: number;
}

export interface PicsiImage {
  blob: Blob;
  name: string;
}

export interface PicsiSwapResult {
  output: string;
  creditsRemaining?: number;
  creditsTotal?: number;
}

export interface PicsiResponse {
  code: number;
  message?: string;
  data?: Record<string, unknown>;
}
