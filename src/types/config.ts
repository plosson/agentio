export interface Config {
  profiles: {
    gmail?: string[];
    gchat?: string[];
    jira?: string[];
    telegram?: string[];
  };
  defaults: {
    gmail?: string;
    gchat?: string;
    jira?: string;
    telegram?: string;
  };
}

export type ServiceName = 'gmail' | 'gchat' | 'jira' | 'telegram';
