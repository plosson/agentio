import type { OAuthTokens } from './tokens';

export type GTasksCredentials = OAuthTokens & { email?: string };

export interface GTaskList {
  id: string;
  title: string;
  updated?: string;
  selfLink?: string;
}

export interface GTask {
  id: string;
  title: string;
  status: 'needsAction' | 'completed';
  notes?: string;
  due?: string;
  completed?: string;
  parent?: string;
  position?: string;
  updated?: string;
  selfLink?: string;
  webViewLink?: string;
  hidden?: boolean;
  deleted?: boolean;
}

export interface GTasksListOptions {
  tasklistId: string;
  maxResults?: number;
  pageToken?: string;
  showCompleted?: boolean;
  showDeleted?: boolean;
  showHidden?: boolean;
  dueMin?: string;
  dueMax?: string;
  completedMin?: string;
  completedMax?: string;
  updatedMin?: string;
}

export interface GTasksCreateOptions {
  tasklistId: string;
  title: string;
  notes?: string;
  due?: string;
  parent?: string;
  previous?: string;
}

export interface GTasksUpdateOptions {
  tasklistId: string;
  taskId: string;
  title?: string;
  notes?: string;
  due?: string;
  status?: 'needsAction' | 'completed';
}
