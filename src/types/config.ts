export interface Config {
  profiles: {
    gmail?: string[];
    gchat?: string[];
    jira?: string[];
    slack?: string[];
    telegram?: string[];
    discourse?: string[];
  };
  defaults: {
    gmail?: string;
    gchat?: string;
    jira?: string;
    slack?: string;
    telegram?: string;
    discourse?: string;
  };
}

export type ServiceName = 'gmail' | 'gchat' | 'jira' | 'slack' | 'telegram' | 'discourse';
