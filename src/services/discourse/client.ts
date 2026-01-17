import type {
  DiscourseCredentials,
  DiscourseCategory,
  DiscourseTopic,
  DiscourseTopicDetail,
  DiscoursePost,
  DiscourseListOptions,
} from '../../types/discourse';
import type { ServiceClient, ValidationResult } from '../../types/service';
import { CliError, type ErrorCode } from '../../utils/errors';

interface DiscourseApiResponse {
  errors?: string[];
  error_type?: string;
}

interface CategoryListResponse extends DiscourseApiResponse {
  category_list: {
    categories: RawCategory[];
  };
}

interface RawCategory {
  id: number;
  name: string;
  slug: string;
  description: string;
  topic_count: number;
  post_count: number;
  color: string;
  parent_category_id?: number;
}

interface TopicListResponse extends DiscourseApiResponse {
  topic_list: {
    topics: RawTopic[];
  };
}

interface RawTopic {
  id: number;
  title: string;
  slug: string;
  posts_count: number;
  reply_count: number;
  views: number;
  like_count: number;
  category_id: number;
  created_at: string;
  last_posted_at: string;
  pinned: boolean;
  closed: boolean;
  archived: boolean;
  posters?: Array<{ user_id: number; extras?: string }>;
}

interface TopicDetailResponse extends DiscourseApiResponse {
  id: number;
  title: string;
  slug: string;
  posts_count: number;
  reply_count: number;
  views: number;
  like_count: number;
  category_id: number;
  created_at: string;
  last_posted_at: string;
  pinned: boolean;
  closed: boolean;
  archived: boolean;
  post_stream: {
    posts: RawPost[];
  };
}

interface RawPost {
  id: number;
  username: string;
  display_username?: string;
  created_at: string;
  updated_at: string;
  post_number: number;
  raw?: string;
  cooked: string;
  reply_count: number;
  like_count: number;
}

export class DiscourseClient implements ServiceClient {
  private baseUrl: string;
  private apiKey: string;
  private username: string;
  private categoryCache: Map<number, string> = new Map();

  constructor(credentials: DiscourseCredentials) {
    this.baseUrl = credentials.baseUrl.replace(/\/$/, '');
    this.apiKey = credentials.apiKey;
    this.username = credentials.username;
  }

  async validate(): Promise<ValidationResult> {
    try {
      await this.getCategories();
      return { valid: true, info: this.baseUrl };
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
    body?: Record<string, unknown>
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    try {
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Api-Key': this.apiKey,
          'Api-Username': this.username,
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      if (!response.ok) {
        const errorCode = this.getErrorCode(response.status);
        const text = await response.text();
        let message = `Discourse API error: ${response.status}`;
        try {
          const data = JSON.parse(text) as DiscourseApiResponse;
          if (data.errors) {
            message = data.errors.join(', ');
          }
        } catch {
          if (text) message = text;
        }
        throw new CliError(errorCode, message);
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof CliError) throw error;

      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new CliError('NETWORK_ERROR', `Failed to connect to Discourse: ${message}`);
    }
  }

  private getErrorCode(status: number): ErrorCode {
    if (status === 401) return 'AUTH_FAILED';
    if (status === 403) return 'PERMISSION_DENIED';
    if (status === 404) return 'NOT_FOUND';
    if (status === 429) return 'RATE_LIMITED';
    return 'API_ERROR';
  }

  async getCategories(): Promise<DiscourseCategory[]> {
    const data = await this.request<CategoryListResponse>('GET', '/categories.json');

    const categories = data.category_list.categories.map((cat) => this.parseCategory(cat));

    // Cache category names for topic listings
    for (const cat of categories) {
      this.categoryCache.set(cat.id, cat.name);
    }

    return categories;
  }

  private parseCategory(raw: RawCategory): DiscourseCategory {
    return {
      id: raw.id,
      name: raw.name,
      slug: raw.slug,
      description: raw.description || '',
      topicCount: raw.topic_count,
      postCount: raw.post_count,
      color: raw.color,
      parentCategoryId: raw.parent_category_id,
    };
  }

  async listTopics(options?: DiscourseListOptions): Promise<DiscourseTopic[]> {
    let path: string;

    if (options?.category) {
      // Need to find category by slug
      const categories = await this.getCategories();
      const category = categories.find(
        (c) => c.slug === options.category || c.name.toLowerCase() === options.category?.toLowerCase()
      );
      if (!category) {
        throw new CliError('NOT_FOUND', `Category "${options.category}" not found`);
      }
      path = `/c/${category.slug}/${category.id}/l/latest.json`;
    } else {
      path = '/latest.json';
    }

    if (options?.page && options.page > 0) {
      path += `?page=${options.page}`;
    }

    const data = await this.request<TopicListResponse>('GET', path);

    // Ensure category cache is populated
    if (this.categoryCache.size === 0) {
      await this.getCategories();
    }

    return data.topic_list.topics.map((topic) => this.parseTopic(topic));
  }

  private parseTopic(raw: RawTopic): DiscourseTopic {
    return {
      id: raw.id,
      title: raw.title,
      slug: raw.slug,
      postsCount: raw.posts_count,
      replyCount: raw.reply_count,
      views: raw.views,
      likeCount: raw.like_count,
      categoryId: raw.category_id,
      categoryName: this.categoryCache.get(raw.category_id),
      createdAt: raw.created_at,
      lastPostedAt: raw.last_posted_at,
      pinned: raw.pinned,
      closed: raw.closed,
      archived: raw.archived,
      posters: raw.posters?.map((p) => ({ userId: p.user_id })),
    };
  }

  async getTopic(topicId: number): Promise<DiscourseTopicDetail> {
    const data = await this.request<TopicDetailResponse>('GET', `/t/${topicId}.json`);

    // Ensure category cache is populated
    if (this.categoryCache.size === 0) {
      await this.getCategories();
    }

    return {
      id: data.id,
      title: data.title,
      slug: data.slug,
      postsCount: data.posts_count,
      replyCount: data.reply_count,
      views: data.views,
      likeCount: data.like_count,
      categoryId: data.category_id,
      categoryName: this.categoryCache.get(data.category_id),
      createdAt: data.created_at,
      lastPostedAt: data.last_posted_at,
      pinned: data.pinned,
      closed: data.closed,
      archived: data.archived,
      posts: data.post_stream.posts.map((p) => this.parsePost(p)),
    };
  }

  private parsePost(raw: RawPost): DiscoursePost {
    return {
      id: raw.id,
      username: raw.username,
      displayName: raw.display_username,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
      postNumber: raw.post_number,
      raw: raw.raw,
      cooked: raw.cooked,
      replyCount: raw.reply_count,
      likeCount: raw.like_count,
    };
  }

  async validateCredentials(): Promise<{ username: string }> {
    // Try to fetch categories as a validation check
    await this.getCategories();
    return { username: this.username };
  }
}
