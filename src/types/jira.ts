// JIRA OAuth credentials stored per profile
// Note: clientId and clientSecret are embedded in the app (see config/credentials.ts)
export interface JiraCredentials {
  accessToken: string;
  refreshToken: string;
  expiryDate: number;
  cloudId: string;
  siteUrl: string;
}

// JIRA Project
export interface JiraProject {
  id: string;
  key: string;
  name: string;
  projectTypeKey: string;
  simplified: boolean;
  style: string;
  isPrivate: boolean;
  avatarUrls?: Record<string, string>;
}

// JIRA Issue
export interface JiraIssue {
  id: string;
  key: string;
  summary: string;
  status: string;
  statusCategoryKey: string;
  priority?: string;
  assignee?: string;
  reporter?: string;
  created: string;
  updated: string;
  projectKey: string;
  issueType: string;
  description?: string;
}

// JIRA Issue Transition
export interface JiraTransition {
  id: string;
  name: string;
  to: {
    id: string;
    name: string;
    statusCategory: {
      key: string;
      name: string;
    };
  };
}

// JIRA Comment
export interface JiraComment {
  id: string;
  author: string;
  body: string;
  created: string;
  updated: string;
}

// Options for search
export interface JiraSearchOptions {
  jql?: string;
  project?: string;
  status?: string;
  assignee?: string;
  maxResults?: number;
}

// Options for listing projects
export interface JiraProjectListOptions {
  maxResults?: number;
}

// Result types
export interface JiraCommentResult {
  id: string;
  issueKey: string;
}

export interface JiraTransitionResult {
  issueKey: string;
  transitionName: string;
  newStatus: string;
}
