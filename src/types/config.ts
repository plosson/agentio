export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri?: string; // Optional, will use dynamic port
}

export interface ServiceProfiles {
  [profileName: string]: OAuthClientConfig;
}

export interface Config {
  profiles: {
    gmail?: ServiceProfiles;
    gchat?: ServiceProfiles;
    jira?: ServiceProfiles;
  };
  defaults: {
    gmail?: string;
    gchat?: string;
    jira?: string;
  };
}

export type ServiceName = 'gmail' | 'gchat' | 'jira';
