export interface DiscourseCredentials {
  baseUrl: string;
  apiKey: string;
  username: string;
}

export interface DiscourseCategory {
  id: number;
  name: string;
  slug: string;
  description: string;
  topicCount: number;
  postCount: number;
  color: string;
  parentCategoryId?: number;
}

export interface DiscoursePoster {
  userId: number;
  username?: string;
}

export interface DiscourseTopic {
  id: number;
  title: string;
  slug: string;
  postsCount: number;
  replyCount: number;
  views: number;
  likeCount: number;
  categoryId: number;
  categoryName?: string;
  createdAt: string;
  lastPostedAt: string;
  pinned: boolean;
  closed: boolean;
  archived: boolean;
  posters?: DiscoursePoster[];
}

export interface DiscoursePost {
  id: number;
  username: string;
  displayName?: string;
  createdAt: string;
  updatedAt: string;
  postNumber: number;
  raw?: string;
  cooked: string;
  replyCount: number;
  likeCount: number;
}

export interface DiscourseTopicDetail extends DiscourseTopic {
  posts: DiscoursePost[];
}

export interface DiscourseListOptions {
  category?: string;
  page?: number;
  order?: 'default' | 'created' | 'activity' | 'views' | 'posts' | 'likes';
}
