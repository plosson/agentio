import { CliError, type ErrorCode } from '../../utils/errors';
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
} from '../../types/jira';

export class JiraClient implements ServiceClient {
  private credentials: JiraCredentials;
  private baseUrl: string;

  constructor(credentials: JiraCredentials) {
    this.credentials = credentials;
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

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      const code = this.getErrorCode(response.status);
      throw new CliError(code, `JIRA API error: ${errorText}`);
    }

    // Some endpoints return 204 No Content
    if (response.status === 204) {
      return {} as T;
    }

    return response.json();
  }

  private getErrorCode(status: number): ErrorCode {
    if (status === 401) return 'AUTH_FAILED';
    if (status === 403) return 'PERMISSION_DENIED';
    if (status === 404) return 'NOT_FOUND';
    if (status === 429) return 'RATE_LIMITED';
    return 'API_ERROR';
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

  async searchIssues(options: JiraSearchOptions = {}): Promise<JiraIssue[]> {
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
    const maxResults = options.maxResults || 50;

    const params = new URLSearchParams();
    params.set('jql', jql);
    params.set('maxResults', String(maxResults));
    params.set('fields', 'summary,status,priority,assignee,reporter,created,updated,project,issuetype,description');

    interface SearchResponse {
      issues: Array<{
        id: string;
        key: string;
        fields: {
          summary: string;
          status: {
            name: string;
            statusCategory: { key: string };
          };
          priority?: { name: string };
          assignee?: { displayName: string };
          reporter?: { displayName: string };
          created: string;
          updated: string;
          project: { key: string };
          issuetype: { name: string };
          description?: unknown;
        };
      }>;
    }

    const response = await this.request<SearchResponse>('GET', `/search/jql?${params.toString()}`);

    return response.issues.map((issue) => ({
      id: issue.id,
      key: issue.key,
      summary: issue.fields.summary,
      status: issue.fields.status.name,
      statusCategoryKey: issue.fields.status.statusCategory.key,
      priority: issue.fields.priority?.name,
      assignee: issue.fields.assignee?.displayName,
      reporter: issue.fields.reporter?.displayName,
      created: issue.fields.created,
      updated: issue.fields.updated,
      projectKey: issue.fields.project.key,
      issueType: issue.fields.issuetype.name,
      description: this.extractTextFromAdf(issue.fields.description),
    }));
  }

  async getIssue(issueKey: string): Promise<JiraIssue> {
    interface IssueResponse {
      id: string;
      key: string;
      fields: {
        summary: string;
        status: {
          name: string;
          statusCategory: { key: string };
        };
        priority?: { name: string };
        assignee?: { displayName: string };
        reporter?: { displayName: string };
        created: string;
        updated: string;
        project: { key: string };
        issuetype: { name: string };
        description?: unknown;
      };
    }

    const response = await this.request<IssueResponse>('GET', `/issue/${issueKey}`);

    return {
      id: response.id,
      key: response.key,
      summary: response.fields.summary,
      status: response.fields.status.name,
      statusCategoryKey: response.fields.status.statusCategory.key,
      priority: response.fields.priority?.name,
      assignee: response.fields.assignee?.displayName,
      reporter: response.fields.reporter?.displayName,
      created: response.fields.created,
      updated: response.fields.updated,
      projectKey: response.fields.project.key,
      issueType: response.fields.issuetype.name,
      description: this.extractTextFromAdf(response.fields.description),
    };
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
        author: { displayName: string };
        body: unknown;
        created: string;
        updated: string;
      }>;
    }

    const response = await this.request<CommentsResponse>('GET', `/issue/${issueKey}/comment`);

    return response.comments.map((c) => ({
      id: c.id,
      author: c.author.displayName,
      body: this.extractTextFromAdf(c.body),
      created: c.created,
      updated: c.updated,
    }));
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
