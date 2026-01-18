export interface GitHubCredentials {
  accessToken: string;
  username: string;
  email: string | null;
}

export interface GitHubUser {
  login: string;
  email: string | null;
  name: string | null;
}

export interface GitHubPublicKey {
  key_id: string;
  key: string;
}
