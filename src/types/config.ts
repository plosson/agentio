export interface Config {
  profiles: {
    gmail?: string[];
    gchat?: string[];
    jira?: string[];
    slack?: string[];
    telegram?: string[];
  };
  defaults: {
    gmail?: string;
    gchat?: string;
    jira?: string;
    slack?: string;
    telegram?: string;
  };
}

export type ServiceName = 'gmail' | 'gchat' | 'jira' | 'slack' | 'telegram';
