export interface Config {
  profiles: {
    gmail?: string[];
    gchat?: string[];
    jira?: string[];
  };
  defaults: {
    gmail?: string;
    gchat?: string;
    jira?: string;
  };
}

export type ServiceName = 'gmail' | 'gchat' | 'jira';
