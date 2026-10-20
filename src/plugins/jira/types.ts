// JIRA OAuth credentials stored per profile.
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

// A Jira user as an issue, a comment or a user search returns it. accountId is the stable id;
// display names are neither unique nor stable. emailAddress is there only when the user's
// profile visibility shows it.
export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
  active?: boolean;
  accountType?: string;
}

// An issue's parent: the epic of a story, or the story of a sub-task.
export interface JiraIssueParent {
  id: string;
  key: string;
  summary?: string;
  issueType?: string;
}

// JIRA Issue
export interface JiraIssue {
  id: string;
  key: string;
  summary: string;
  status: string;
  statusCategoryKey: string;
  priority?: string;
  assignee?: JiraUser;
  reporter?: JiraUser;
  created: string;
  updated: string;
  resolution?: string;
  resolutionDate?: string;
  projectKey: string;
  issueType: string;
  parent?: JiraIssueParent;
  labels: string[];
  components: string[];
  fixVersions: string[];
  description?: string;
  // The raw value of each field asked for with --fields, keyed by field id.
  extraFields?: Record<string, unknown>;
  // Only with `get --comments` and `get --changelog`.
  comments?: JiraComment[];
  changelog?: JiraChangelogEntry[];
}

// One change to an issue: who, when, and every field it changed.
export interface JiraChangelogEntry {
  id: string;
  created: string;
  author?: JiraUser;
  items: JiraChangelogItem[];
}

export interface JiraChangelogItem {
  field: string;
  fieldId?: string;
  from: string | null;
  fromString: string | null;
  to: string | null;
  toString: string | null;
}

// One page of a search, or all the pages a limit allowed.
export interface JiraSearchResult {
  issues: JiraIssue[];
  // True when more issues match than were fetched (the limit was reached).
  truncated: boolean;
  // Pass to --page-token to fetch the issues after these. Set only when truncated.
  nextPageToken?: string;
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
  authorAccountId?: string;
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
  // Issues to return in total, across pages; Infinity for every match.
  maxResults?: number;
  // Resume after a page an earlier search ended on.
  nextPageToken?: string;
  // Extra field ids to fetch (e.g. customfield_10016), returned raw in extraFields.
  fields?: string[];
}

export interface JiraGetOptions {
  fields?: string[];
  comments?: boolean;
  changelog?: boolean;
}

export interface JiraUserSearchOptions {
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
