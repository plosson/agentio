import { CliError, httpStatusToErrorCode } from '../../utils/errors';
import type { ServiceClient, ValidationResult } from '../../types/service';
import type {
  ConfluenceCredentials,
  ConfluenceSpace,
  ConfluencePage,
  ConfluencePageDetail,
  ConfluenceComment,
  ConfluenceSearchOptions,
  ConfluenceSearchResult,
  ConfluencePageListOptions,
  ConfluenceSpaceListOptions,
  ConfluencePageCreateResult,
  ConfluencePageUpdateResult,
  ConfluenceCommentResult,
} from '../../types/confluence';

export class ConfluenceClient implements ServiceClient {
  private credentials: ConfluenceCredentials;
  private baseV2: string;     // /wiki/api/v2 — current API
  private baseV1: string;     // /wiki/rest/api — used for CQL search

  constructor(credentials: ConfluenceCredentials) {
    this.credentials = credentials;
    const root = `https://api.atlassian.com/ex/confluence/${credentials.cloudId}`;
    this.baseV2 = `${root}/wiki/api/v2`;
    this.baseV1 = `${root}/wiki/rest/api`;
  }

  async validate(): Promise<ValidationResult> {
    try {
      // Hitting /spaces with limit=1 is a cheap way to confirm scopes + cloudId.
      const response = await fetch(`${this.baseV2}/spaces?limit=1`, {
        headers: {
          Authorization: `Bearer ${this.credentials.accessToken}`,
          Accept: 'application/json',
        },
      });

      if (response.ok) {
        return { valid: true, info: this.credentials.siteUrl };
      }

      return {
        valid: false,
        error: `API returned ${response.status}`,
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
    base: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${base}${path}`;
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
      const code = httpStatusToErrorCode(response.status);
      throw new CliError(code, `Confluence API error: ${errorText}`);
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json();
  }

  private webUrl(path: string): string {
    return `${this.credentials.siteUrl.replace(/\/$/, '')}/wiki${path}`;
  }

  async listSpaces(options: ConfluenceSpaceListOptions = {}): Promise<ConfluenceSpace[]> {
    const params = new URLSearchParams();
    params.set('limit', String(options.limit ?? 50));
    if (options.type) {
      params.set('type', options.type);
    }

    interface SpacesResponse {
      results: Array<{
        id: string;
        key: string;
        name: string;
        type: string;
        status: string;
        homepageId?: string;
        description?: { plain?: { value?: string } };
      }>;
    }

    const response = await this.request<SpacesResponse>('GET', this.baseV2, `/spaces?${params.toString()}`);

    return response.results.map((s) => ({
      id: s.id,
      key: s.key,
      name: s.name,
      type: s.type,
      status: s.status,
      homepageId: s.homepageId,
      description: s.description?.plain?.value,
    }));
  }

  async getSpace(idOrKey: string): Promise<ConfluenceSpace> {
    // v2 lookup is by id; for keys, fall back to listing and matching.
    if (/^\d+$/.test(idOrKey)) {
      interface SpaceResponse {
        id: string;
        key: string;
        name: string;
        type: string;
        status: string;
        homepageId?: string;
        description?: { plain?: { value?: string } };
      }
      const s = await this.request<SpaceResponse>('GET', this.baseV2, `/spaces/${idOrKey}`);
      return {
        id: s.id,
        key: s.key,
        name: s.name,
        type: s.type,
        status: s.status,
        homepageId: s.homepageId,
        description: s.description?.plain?.value,
      };
    }

    const params = new URLSearchParams();
    params.set('keys', idOrKey);
    params.set('limit', '1');

    interface SpacesResponse {
      results: Array<{
        id: string;
        key: string;
        name: string;
        type: string;
        status: string;
        homepageId?: string;
        description?: { plain?: { value?: string } };
      }>;
    }

    const response = await this.request<SpacesResponse>('GET', this.baseV2, `/spaces?${params.toString()}`);
    const match = response.results[0];
    if (!match) {
      throw new CliError('NOT_FOUND', `Space "${idOrKey}" not found`);
    }
    return {
      id: match.id,
      key: match.key,
      name: match.name,
      type: match.type,
      status: match.status,
      homepageId: match.homepageId,
      description: match.description?.plain?.value,
    };
  }

  async listPages(options: ConfluencePageListOptions = {}): Promise<ConfluencePage[]> {
    const limit = options.limit ?? 25;

    let spaceId = options.spaceId;
    if (!spaceId && options.spaceKey) {
      const space = await this.getSpace(options.spaceKey);
      spaceId = space.id;
    }

    const params = new URLSearchParams();
    params.set('limit', String(limit));
    if (options.parentId) {
      params.set('parent-id', options.parentId);
    }

    const path = spaceId
      ? `/spaces/${spaceId}/pages?${params.toString()}`
      : `/pages?${params.toString()}`;

    interface PagesResponse {
      results: Array<{
        id: string;
        title: string;
        spaceId: string;
        status: string;
        parentId?: string;
        authorId?: string;
        createdAt: string;
        version: { number: number };
        _links?: { webui?: string };
      }>;
    }

    const response = await this.request<PagesResponse>('GET', this.baseV2, path);

    return response.results.map((p) => ({
      id: p.id,
      title: p.title,
      spaceId: p.spaceId,
      status: p.status,
      parentId: p.parentId,
      authorId: p.authorId,
      createdAt: p.createdAt,
      version: p.version.number,
      webUrl: p._links?.webui ? this.webUrl(p._links.webui) : undefined,
    }));
  }

  async getPage(
    pageId: string,
    bodyFormat: 'storage' | 'atlas_doc_format' | 'view' = 'storage'
  ): Promise<ConfluencePageDetail> {
    const params = new URLSearchParams();
    params.set('body-format', bodyFormat);

    interface PageResponse {
      id: string;
      title: string;
      spaceId: string;
      status: string;
      parentId?: string;
      authorId?: string;
      createdAt: string;
      version: { number: number };
      body?: {
        storage?: { value: string };
        atlas_doc_format?: { value: string };
        view?: { value: string };
      };
      _links?: { webui?: string };
    }

    const response = await this.request<PageResponse>(
      'GET',
      this.baseV2,
      `/pages/${pageId}?${params.toString()}`
    );

    let body = '';
    if (bodyFormat === 'atlas_doc_format' && response.body?.atlas_doc_format?.value) {
      try {
        body = this.extractTextFromAdf(JSON.parse(response.body.atlas_doc_format.value));
      } catch {
        body = response.body.atlas_doc_format.value;
      }
    } else if (bodyFormat === 'view' && response.body?.view?.value) {
      body = this.stripHtml(response.body.view.value);
    } else if (response.body?.storage?.value) {
      body = this.stripHtml(response.body.storage.value);
    }

    return {
      id: response.id,
      title: response.title,
      spaceId: response.spaceId,
      status: response.status,
      parentId: response.parentId,
      authorId: response.authorId,
      createdAt: response.createdAt,
      version: response.version.number,
      webUrl: response._links?.webui ? this.webUrl(response._links.webui) : undefined,
      body,
      bodyFormat,
    };
  }

  async createPage(params: {
    spaceKey?: string;
    spaceId?: string;
    title: string;
    body: string;
    parentId?: string;
  }): Promise<ConfluencePageCreateResult> {
    let spaceId = params.spaceId;
    if (!spaceId && params.spaceKey) {
      const space = await this.getSpace(params.spaceKey);
      spaceId = space.id;
    }
    if (!spaceId) {
      throw new CliError('INVALID_PARAMS', 'spaceId or spaceKey is required to create a page');
    }

    const storage = this.textToStorage(params.body);

    interface CreateResponse {
      id: string;
      title: string;
      spaceId: string;
      _links?: { webui?: string };
    }

    const response = await this.request<CreateResponse>('POST', this.baseV2, '/pages', {
      spaceId,
      status: 'current',
      title: params.title,
      parentId: params.parentId,
      body: {
        representation: 'storage',
        value: storage,
      },
    });

    return {
      id: response.id,
      title: response.title,
      spaceId: response.spaceId,
      webUrl: response._links?.webui ? this.webUrl(response._links.webui) : undefined,
    };
  }

  async updatePage(params: {
    pageId: string;
    title?: string;
    body: string;
  }): Promise<ConfluencePageUpdateResult> {
    // v2 update requires the new version number; fetch current first.
    const current = await this.getPage(params.pageId);
    const storage = this.textToStorage(params.body);

    interface UpdateResponse {
      id: string;
      title: string;
      version: { number: number };
    }

    const response = await this.request<UpdateResponse>('PUT', this.baseV2, `/pages/${params.pageId}`, {
      id: params.pageId,
      status: current.status,
      title: params.title ?? current.title,
      body: {
        representation: 'storage',
        value: storage,
      },
      version: {
        number: current.version + 1,
      },
    });

    return {
      id: response.id,
      title: response.title,
      version: response.version.number,
    };
  }

  async listComments(pageId: string): Promise<ConfluenceComment[]> {
    interface CommentsResponse {
      results: Array<{
        id: string;
        authorId?: string;
        createdAt: string;
        version: { number: number };
        body?: { storage?: { value: string }; atlas_doc_format?: { value: string } };
      }>;
    }

    const response = await this.request<CommentsResponse>(
      'GET',
      this.baseV2,
      `/pages/${pageId}/footer-comments?body-format=storage`
    );

    return response.results.map((c) => ({
      id: c.id,
      pageId,
      authorId: c.authorId,
      body: c.body?.storage?.value ? this.stripHtml(c.body.storage.value) : '',
      createdAt: c.createdAt,
      version: c.version.number,
    }));
  }

  async addComment(pageId: string, body: string): Promise<ConfluenceCommentResult> {
    const storage = this.textToStorage(body);

    interface CommentResponse {
      id: string;
    }

    const response = await this.request<CommentResponse>('POST', this.baseV2, '/footer-comments', {
      pageId,
      body: {
        representation: 'storage',
        value: storage,
      },
    });

    return {
      id: response.id,
      pageId,
    };
  }

  async search(options: ConfluenceSearchOptions = {}): Promise<ConfluenceSearchResult[]> {
    const cqlParts: string[] = [];

    if (options.cql) {
      cqlParts.push(options.cql);
    }
    if (options.spaceKey) {
      cqlParts.push(`space.key = "${options.spaceKey}"`);
    }
    if (options.type) {
      cqlParts.push(`type = "${options.type}"`);
    }
    if (options.text) {
      cqlParts.push(`text ~ "${options.text.replace(/"/g, '\\"')}"`);
    }

    const cql = cqlParts.join(' AND ') || 'type = "page" ORDER BY lastmodified DESC';
    const limit = options.limit ?? 25;

    const params = new URLSearchParams();
    params.set('cql', cql);
    params.set('limit', String(limit));

    interface SearchResponse {
      results: Array<{
        content?: {
          id: string;
          type: string;
          title: string;
          space?: { key: string };
        };
        title?: string;
        excerpt?: string;
        url?: string;
        lastModified?: string;
      }>;
    }

    const response = await this.request<SearchResponse>(
      'GET',
      this.baseV1,
      `/search?${params.toString()}`
    );

    return response.results.map((r) => ({
      id: r.content?.id ?? '',
      type: r.content?.type ?? 'unknown',
      title: r.content?.title ?? r.title ?? '(untitled)',
      spaceKey: r.content?.space?.key,
      url: r.url ? this.webUrl(r.url) : undefined,
      excerpt: r.excerpt ? this.stripHtml(r.excerpt) : undefined,
      lastModified: r.lastModified,
    }));
  }

  // Wrap plain text in Confluence storage format. Each blank-line-separated
  // block becomes a <p>; single newlines become <br/>.
  private textToStorage(text: string): string {
    const escape = (s: string): string =>
      s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    return text
      .split(/\n\n+/)
      .map((block) => {
        const escaped = escape(block).replace(/\n/g, '<br/>');
        return `<p>${escaped}</p>`;
      })
      .join('');
  }

  // Strip HTML tags from Confluence storage/view format for plain-text output.
  private stripHtml(html: string): string {
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
      .replace(/<\/?p[^>]*>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // Extract plain text from Atlassian Document Format (ADF). Mirrors the
  // helper in JiraClient since pages can opt into ADF.
  private extractTextFromAdf(adf: unknown): string {
    if (!adf || typeof adf !== 'object') {
      return '';
    }

    const doc = adf as { content?: unknown[] };
    if (!Array.isArray(doc.content)) {
      return '';
    }

    const extractText = (node: unknown): string => {
      if (!node || typeof node !== 'object') return '';
      const n = node as { type?: string; text?: string; content?: unknown[] };

      if (n.type === 'text' && n.text) return n.text;
      if (n.type === 'hardBreak') return '\n';
      if (Array.isArray(n.content)) return n.content.map(extractText).join('');
      return '';
    };

    return doc.content.map((block) => extractText(block)).join('\n\n');
  }
}
