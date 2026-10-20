import { CliError, httpStatusToErrorCode } from '../../utils/errors';
import type { ServiceClient, ValidationResult } from '../../types/service';
import type {
  JiraCredentials,
  JiraProject,
  JiraIssue,
  JiraTransition,
  JiraComment,
  JiraSearchOptions,
  JiraProjectListOptions,
  JiraCommentResult,
  JiraTransitionResult,
  JiraChangelogEntry,
  JiraGetOptions,
  JiraSearchResult,
  JiraUser,
  JiraUserSearchOptions,
} from './types';

/** The most issues /search/jql takes as maxResults; it may still answer with fewer per page (often 100). */
export const SEARCH_PAGE_MAX = 5000;
/** The most changelog entries or comments one page can hold. */
export const CHANGELOG_PAGE_MAX = 100;
export const COMMENT_PAGE_MAX = 100;
/** User search only ever looks at the first 1000 users. */
export const USER_SEARCH_MAX = 1000;
/** Retries of a request Jira answers with 429 or 503, waiting Retry-After (capped) between them. */
const MAX_RETRIES = 4;
const MAX_RETRY_WAIT_MS = 30_000;

/** The fields every issue is read with; `--fields` adds to them. */
export const ISSUE_FIELDS = [
  'summary', 'status', 'priority', 'assignee', 'reporter', 'created', 'updated',
  'resolution', 'resolutiondate', 'project', 'issuetype', 'parent', 'labels',
  'components', 'fixVersions', 'description',
];

interface RawUser {
  accountId: string;
  displayName?: string;
  emailAddress?: string;
  active?: boolean;
  accountType?: string;
}

interface RawIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    status: { name: string; statusCategory: { key: string } };
    priority?: { name: string } | null;
    assignee?: RawUser | null;
    reporter?: RawUser | null;
    created: string;
    updated: string;
    resolution?: { name: string } | null;
    resolutiondate?: string | null;
    project: { key: string };
    issuetype: { name: string };
    parent?: { id: string; key: string; fields?: { summary?: string; issuetype?: { name: string } } } | null;
    labels?: string[];
    components?: Array<{ name: string }>;
    fixVersions?: Array<{ name: string }>;
    description?: unknown;
    [field: string]: unknown;
  };
}

export function mapUser(user: RawUser | null | undefined): JiraUser | undefined {
  if (!user || !user.accountId) return undefined;
  return {
    accountId: user.accountId,
    displayName: user.displayName ?? '',
    ...(user.emailAddress ? { emailAddress: user.emailAddress } : {}),
    ...(user.active !== undefined ? { active: user.active } : {}),
    ...(user.accountType ? { accountType: user.accountType } : {}),
  };
}

/** Field ids from a `--fields` list, without blanks or the ones every issue already carries. */
export function extraFieldIds(fields: string[] | undefined): string[] {
  const ids = (fields ?? []).map((f) => f.trim()).filter((f) => f !== '');
  return [...new Set(ids)];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class JiraClient implements ServiceClient {
  private credentials: JiraCredentials;
  private baseUrl: string;

  private wait: (ms: number) => Promise<void>;

  constructor(credentials: JiraCredentials, options: { wait?: (ms: number) => Promise<void> } = {}) {
    this.credentials = credentials;
    this.wait = options.wait ?? sleep;
    this.baseUrl = `https://api.atlassian.com/ex/jira/${credentials.cloudId}/rest/api/3`;
  }

  async validate(): Promise<ValidationResult> {
    try {
      // Try /myself endpoint first (requires read:me scope)
      const url = `${this.baseUrl}/myself`;
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.credentials.accessToken}`,
          Accept: 'application/json',
        },
      });

      if (response.ok) {
        const user = await response.json() as { displayName?: string; emailAddress?: string };
        const info = user.displayName || user.emailAddress || this.credentials.siteUrl;
        return { valid: true, info };
      }

      // Fall back to project search if /myself fails (older tokens without read:me scope)
      const fallbackUrl = `${this.baseUrl}/project/search?maxResults=1`;
      const fallbackResponse = await fetch(fallbackUrl, {
        headers: {
          Authorization: `Bearer ${this.credentials.accessToken}`,
          Accept: 'application/json',
        },
      });

      if (fallbackResponse.ok) {
        return { valid: true, info: this.credentials.siteUrl };
      }

      return {
        valid: false,
        error: `API returned ${fallbackResponse.status}`,
      };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.credentials.accessToken}`,
      Accept: 'application/json',
    };

    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    let response: Response;
    for (let attempt = 0; ; attempt++) {
      response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      // A long backfill hits Jira's rate limit; wait as told and try again rather than lose the run.
      if ((response.status === 429 || response.status === 503) && attempt < MAX_RETRIES) {
        const retryAfter = Number(response.headers.get('Retry-After'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter >= 0 && response.headers.has('Retry-After')
          ? retryAfter * 1000
          : 1000 * 2 ** attempt;
        await response.text().catch(() => '');
        await this.wait(Math.min(waitMs, MAX_RETRY_WAIT_MS));
        continue;
      }
      break;
    }

    if (!response.ok) {
      const errorText = await response.text();
      const code = httpStatusToErrorCode(response.status);
      throw new CliError(code, `JIRA API error: ${errorText}`);
    }

    // Some endpoints return 204 No Content
    if (response.status === 204) {
      return {} as T;
    }

    return response.json();
  }

  async listProjects(options: JiraProjectListOptions = {}): Promise<JiraProject[]> {
    const params = new URLSearchParams();
    if (options.maxResults) {
      params.set('maxResults', String(options.maxResults));
    }

    const queryString = params.toString();
    const path = `/project/search${queryString ? `?${queryString}` : ''}`;

    interface ProjectSearchResponse {
      values: Array<{
        id: string;
        key: string;
        name: string;
        projectTypeKey: string;
        simplified: boolean;
        style: string;
        isPrivate: boolean;
        avatarUrls?: Record<string, string>;
      }>;
    }

    const response = await this.request<ProjectSearchResponse>('GET', path);

    return response.values.map((p) => ({
      id: p.id,
      key: p.key,
      name: p.name,
      projectTypeKey: p.projectTypeKey,
      simplified: p.simplified,
      style: p.style,
      isPrivate: p.isPrivate,
      avatarUrls: p.avatarUrls,
    }));
  }

  /**
   * Search with JQL through /search/jql, following nextPageToken until `maxResults` issues are
   * read or none are left. Each page asks for at most SEARCH_PAGE_MAX, the API's own limit.
   */
  async searchIssues(options: JiraSearchOptions = {}): Promise<JiraSearchResult> {
    // Build JQL query
    const jqlParts: string[] = [];

    if (options.jql) {
      jqlParts.push(options.jql);
    }
    if (options.project) {
      jqlParts.push(`project = "${options.project}"`);
    }
    if (options.status) {
      jqlParts.push(`status = "${options.status}"`);
    }
    if (options.assignee) {
      jqlParts.push(`assignee = "${options.assignee}"`);
    }

    const jql = jqlParts.join(' AND ') || 'ORDER BY created DESC';
    const limit = options.maxResults ?? 50;
    const extras = extraFieldIds(options.fields);
    const fields = [...new Set([...ISSUE_FIELDS, ...extras])].join(',');

    interface SearchResponse {
      issues: RawIssue[];
      nextPageToken?: string;
      isLast?: boolean;
    }

    const issues: JiraIssue[] = [];
    let pageToken = options.nextPageToken;
    let more = false;

    while (issues.length < limit) {
      const params = new URLSearchParams();
      params.set('jql', jql);
      params.set('maxResults', String(Math.min(limit - issues.length, SEARCH_PAGE_MAX)));
      params.set('fields', fields);
      if (pageToken) params.set('nextPageToken', pageToken);

      const response = await this.request<SearchResponse>('GET', `/search/jql?${params.toString()}`);
      const page = response.issues ?? [];
      issues.push(...page.map((issue) => this.mapIssue(issue, extras)));

      pageToken = response.nextPageToken;
      more = !!pageToken && response.isLast !== true;
      if (!more || page.length === 0) break;
    }

    return {
      issues,
      truncated: more,
      ...(more && pageToken ? { nextPageToken: pageToken } : {}),
    };
  }

  async getIssue(issueKey: string, options: JiraGetOptions = {}): Promise<JiraIssue> {
    const extras = extraFieldIds(options.fields);
    const params = new URLSearchParams();
    params.set('fields', [...new Set([...ISSUE_FIELDS, ...extras])].join(','));

    const response = await this.request<RawIssue>('GET', `/issue/${encodeURIComponent(issueKey)}?${params.toString()}`);
    const issue = this.mapIssue(response, extras);

    if (options.comments) issue.comments = await this.getComments(issueKey);
    if (options.changelog) issue.changelog = await this.getChangelog(issueKey);
    return issue;
  }

  /** Every change to an issue, oldest first, read 100 at a time. */
  async getChangelog(issueKey: string): Promise<JiraChangelogEntry[]> {
    interface ChangelogResponse {
      values: Array<{
        id: string;
        created: string;
        author?: RawUser;
        items: Array<{
          field: string;
          fieldId?: string;
          from?: string | null;
          fromString?: string | null;
          to?: string | null;
          toString?: string | null;
        }>;
      }>;
      startAt?: number;
      total?: number;
      isLast?: boolean;
    }

    const entries: JiraChangelogEntry[] = [];
    for (let startAt = 0; ;) {
      const params = new URLSearchParams({ startAt: String(startAt), maxResults: String(CHANGELOG_PAGE_MAX) });
      const response = await this.request<ChangelogResponse>('GET', `/issue/${encodeURIComponent(issueKey)}/changelog?${params.toString()}`);
      const page = response.values ?? [];
      for (const entry of page) {
        entries.push({
          id: entry.id,
          created: entry.created,
          ...(mapUser(entry.author) ? { author: mapUser(entry.author) } : {}),
          items: (entry.items ?? []).map((item) => ({
            field: item.field,
            ...(item.fieldId ? { fieldId: item.fieldId } : {}),
            from: item.from ?? null,
            fromString: item.fromString ?? null,
            to: item.to ?? null,
            toString: item.toString ?? null,
          })),
        });
      }
      startAt += page.length;
      const done = response.isLast === true
        || page.length === 0
        || (response.total !== undefined && startAt >= response.total);
      if (done) break;
    }
    return entries;
  }

  /**
   * Users whose name or email matches `query`, with their accountId. Needs the
   * read:jira-user scope; a profile without it is told how to get it.
   */
  async searchUsers(query: string, options: JiraUserSearchOptions = {}): Promise<JiraUser[]> {
    const limit = Math.min(options.maxResults ?? 50, USER_SEARCH_MAX);
    const users: JiraUser[] = [];
    for (let startAt = 0; users.length < limit;) {
      const want = limit - users.length;
      const params = new URLSearchParams({ query, startAt: String(startAt), maxResults: String(want) });
      const page = await this.userRequest<RawUser[]>(`/user/search?${params.toString()}`);
      for (const raw of page) {
        const user = mapUser(raw);
        if (user) users.push(user);
      }
      startAt += page.length;
      if (page.length < want || startAt >= USER_SEARCH_MAX) break;
    }
    return users.slice(0, limit);
  }

  async getUser(accountId: string): Promise<JiraUser> {
    const raw = await this.userRequest<RawUser>(`/user?${new URLSearchParams({ accountId }).toString()}`);
    const user = mapUser(raw);
    if (!user) throw new CliError('NOT_FOUND', `No Jira user with accountId "${accountId}"`);
    return user;
  }

  private async userRequest<T>(path: string): Promise<T> {
    try {
      return await this.request<T>('GET', path);
    } catch (error) {
      if (error instanceof CliError && (error.code === 'AUTH_FAILED' || error.code === 'PERMISSION_DENIED')) {
        throw new CliError(
          error.code,
          error.message,
          'User lookup needs the read:jira-user scope, which agentio\'s Atlassian sign-in does not request yet, '
            + 'and the "Browse users and groups" permission. Assignee and reporter account ids (and emails, when visible) '
            + 'are in: agentio jira search --json',
        );
      }
      throw error;
    }
  }

  private mapIssue(issue: RawIssue, extras: string[] = []): JiraIssue {
    const f = issue.fields;
    const mapped: JiraIssue = {
      id: issue.id,
      key: issue.key,
      summary: f.summary,
      status: f.status.name,
      statusCategoryKey: f.status.statusCategory.key,
      priority: f.priority?.name,
      assignee: mapUser(f.assignee),
      reporter: mapUser(f.reporter),
      created: f.created,
      updated: f.updated,
      resolution: f.resolution?.name,
      resolutionDate: f.resolutiondate ?? undefined,
      projectKey: f.project.key,
      issueType: f.issuetype.name,
      parent: f.parent
        ? {
            id: f.parent.id,
            key: f.parent.key,
            summary: f.parent.fields?.summary,
            issueType: f.parent.fields?.issuetype?.name,
          }
        : undefined,
      labels: f.labels ?? [],
      components: (f.components ?? []).map((c) => c.name),
      fixVersions: (f.fixVersions ?? []).map((v) => v.name),
      description: this.extractTextFromAdf(f.description),
    };
    const wanted = extras.filter((id) => !ISSUE_FIELDS.includes(id));
    if (wanted.length > 0) {
      mapped.extraFields = Object.fromEntries(wanted.map((id) => [id, f[id] ?? null]));
    }
    return mapped;
  }

  async getTransitions(issueKey: string): Promise<JiraTransition[]> {
    interface TransitionsResponse {
      transitions: Array<{
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
      }>;
    }

    const response = await this.request<TransitionsResponse>('GET', `/issue/${issueKey}/transitions`);

    return response.transitions.map((t) => ({
      id: t.id,
      name: t.name,
      to: {
        id: t.to.id,
        name: t.to.name,
        statusCategory: {
          key: t.to.statusCategory.key,
          name: t.to.statusCategory.name,
        },
      },
    }));
  }

  async transitionIssue(issueKey: string, transitionId: string): Promise<JiraTransitionResult> {
    // Get transitions first to find the name
    const transitions = await this.getTransitions(issueKey);
    const transition = transitions.find((t) => t.id === transitionId);

    if (!transition) {
      throw new CliError('NOT_FOUND', `Transition "${transitionId}" not found or not available for this issue`);
    }

    await this.request<void>('POST', `/issue/${issueKey}/transitions`, {
      transition: { id: transitionId },
    });

    return {
      issueKey,
      transitionName: transition.name,
      newStatus: transition.to.name,
    };
  }

  async addComment(issueKey: string, body: string): Promise<JiraCommentResult> {
    // JIRA v3 API requires Atlassian Document Format (ADF)
    const adfBody = this.textToAdf(body);

    interface CommentResponse {
      id: string;
    }

    const response = await this.request<CommentResponse>('POST', `/issue/${issueKey}/comment`, {
      body: adfBody,
    });

    return {
      id: response.id,
      issueKey,
    };
  }

  async getComments(issueKey: string): Promise<JiraComment[]> {
    interface CommentsResponse {
      comments: Array<{
        id: string;
        author?: RawUser;
        body: unknown;
        created: string;
        updated: string;
      }>;
      total?: number;
    }

    const comments: JiraComment[] = [];
    for (let startAt = 0; ;) {
      const params = new URLSearchParams({ startAt: String(startAt), maxResults: String(COMMENT_PAGE_MAX) });
      const response = await this.request<CommentsResponse>('GET', `/issue/${encodeURIComponent(issueKey)}/comment?${params.toString()}`);
      const page = response.comments ?? [];
      for (const c of page) {
        comments.push({
          id: c.id,
          author: c.author?.displayName ?? '',
          ...(c.author?.accountId ? { authorAccountId: c.author.accountId } : {}),
          body: this.extractTextFromAdf(c.body),
          created: c.created,
          updated: c.updated,
        });
      }
      startAt += page.length;
      if (page.length === 0 || response.total === undefined || startAt >= response.total) break;
    }
    return comments;
  }

  // Convert plain text to Atlassian Document Format (ADF)
  private textToAdf(text: string): object {
    const paragraphs = text.split('\n\n');

    return {
      version: 1,
      type: 'doc',
      content: paragraphs.map((paragraph) => ({
        type: 'paragraph',
        content: paragraph.split('\n').flatMap((line, index, array) => {
          const parts: object[] = [{ type: 'text', text: line }];
          if (index < array.length - 1) {
            parts.push({ type: 'hardBreak' });
          }
          return parts;
        }),
      })),
    };
  }

  // Extract plain text from Atlassian Document Format (ADF)
  private extractTextFromAdf(adf: unknown): string {
    if (!adf || typeof adf !== 'object') {
      return '';
    }

    const doc = adf as { content?: Array<{ type: string; content?: Array<{ text?: string; type?: string }> }> };
    if (!doc.content) {
      return '';
    }

    const extractText = (node: unknown): string => {
      if (!node || typeof node !== 'object') return '';

      const n = node as { type?: string; text?: string; content?: unknown[] };

      if (n.type === 'text' && n.text) {
        return n.text;
      }

      if (n.type === 'hardBreak') {
        return '\n';
      }

      if (Array.isArray(n.content)) {
        return n.content.map(extractText).join('');
      }

      return '';
    };

    return doc.content
      .map((block) => extractText(block))
      .join('\n\n');
  }
}
