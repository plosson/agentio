import { google, tasks_v1 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type {
  GTaskList,
  GTask,
  GTasksListOptions,
  GTasksCreateOptions,
  GTasksUpdateOptions,
} from '../../types/gtasks';
import type { ServiceClient, ValidationResult } from '../../types/service';
import { CliError } from '../../utils/errors';

export class GTasksClient implements ServiceClient {
  private tasks: tasks_v1.Tasks;
  private userEmail: string | null = null;

  constructor(auth: OAuth2Client) {
    this.tasks = google.tasks({ version: 'v1', auth });
  }

  async validate(): Promise<ValidationResult> {
    try {
      // Try to list task lists to verify credentials work
      await this.tasks.tasklists.list({ maxResults: 1 });
      return { valid: true, info: 'tasks access ok' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (message.includes('invalid_grant') || message.includes('Token has been expired or revoked')) {
        return { valid: false, error: 'refresh token expired, re-authenticate' };
      }
      return { valid: false, error: message };
    }
  }

  async listTaskLists(maxResults: number = 100, pageToken?: string): Promise<{ taskLists: GTaskList[]; nextPageToken?: string }> {
    try {
      const response = await this.tasks.tasklists.list({
        maxResults: Math.min(maxResults, 100),
        pageToken,
      });

      const taskLists: GTaskList[] = (response.data.items || []).map((tl) => ({
        id: tl.id!,
        title: tl.title || '',
        updated: tl.updated || undefined,
        selfLink: tl.selfLink || undefined,
      }));

      return {
        taskLists,
        nextPageToken: response.data.nextPageToken || undefined,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Tasks API error: ${message}`);
    }
  }

  async createTaskList(title: string): Promise<GTaskList> {
    try {
      const response = await this.tasks.tasklists.insert({
        requestBody: { title },
      });

      return {
        id: response.data.id!,
        title: response.data.title || '',
        updated: response.data.updated || undefined,
        selfLink: response.data.selfLink || undefined,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Failed to create task list: ${message}`);
    }
  }

  async deleteTaskList(tasklistId: string): Promise<void> {
    try {
      await this.tasks.tasklists.delete({ tasklist: tasklistId });
    } catch (error) {
      if (this.isNotFoundError(error)) {
        throw new CliError('NOT_FOUND', `Task list not found: ${tasklistId}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Failed to delete task list: ${message}`);
    }
  }

  async listTasks(options: GTasksListOptions): Promise<{ tasks: GTask[]; nextPageToken?: string }> {
    const {
      tasklistId,
      maxResults = 20,
      pageToken,
      showCompleted = true,
      showDeleted = false,
      showHidden = false,
      dueMin,
      dueMax,
      completedMin,
      completedMax,
      updatedMin,
    } = options;

    try {
      const params: tasks_v1.Params$Resource$Tasks$List = {
        tasklist: tasklistId,
        maxResults: Math.min(maxResults, 100),
        showCompleted,
        showDeleted,
        showHidden,
      };

      if (pageToken) params.pageToken = pageToken;
      if (dueMin) params.dueMin = dueMin;
      if (dueMax) params.dueMax = dueMax;
      if (completedMin) params.completedMin = completedMin;
      if (completedMax) params.completedMax = completedMax;
      if (updatedMin) params.updatedMin = updatedMin;

      const response = await this.tasks.tasks.list(params);

      const tasks: GTask[] = (response.data.items || []).map((t) => this.parseTask(t));

      return {
        tasks,
        nextPageToken: response.data.nextPageToken || undefined,
      };
    } catch (error) {
      if (this.isNotFoundError(error)) {
        throw new CliError('NOT_FOUND', `Task list not found: ${tasklistId}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Tasks API error: ${message}`);
    }
  }

  async getTask(tasklistId: string, taskId: string): Promise<GTask> {
    try {
      const response = await this.tasks.tasks.get({
        tasklist: tasklistId,
        task: taskId,
      });

      return this.parseTask(response.data);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        throw new CliError('NOT_FOUND', `Task not found: ${taskId}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Tasks API error: ${message}`);
    }
  }

  async createTask(options: GTasksCreateOptions): Promise<GTask> {
    const { tasklistId, title, notes, due, parent, previous } = options;

    try {
      const task: tasks_v1.Schema$Task = {
        title,
        notes,
        due: due ? this.normalizeDue(due) : undefined,
      };

      const params: tasks_v1.Params$Resource$Tasks$Insert = {
        tasklist: tasklistId,
        requestBody: task,
      };

      if (parent) params.parent = parent;
      if (previous) params.previous = previous;

      const response = await this.tasks.tasks.insert(params);

      return this.parseTask(response.data);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        throw new CliError('NOT_FOUND', `Task list not found: ${tasklistId}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Failed to create task: ${message}`);
    }
  }

  async updateTask(options: GTasksUpdateOptions): Promise<GTask> {
    const { tasklistId, taskId, title, notes, due, status } = options;

    try {
      const patch: tasks_v1.Schema$Task = {};

      if (title !== undefined) patch.title = title;
      if (notes !== undefined) patch.notes = notes;
      if (due !== undefined) patch.due = due ? this.normalizeDue(due) : null;
      if (status !== undefined) patch.status = status;

      const response = await this.tasks.tasks.patch({
        tasklist: tasklistId,
        task: taskId,
        requestBody: patch,
      });

      return this.parseTask(response.data);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        throw new CliError('NOT_FOUND', `Task not found: ${taskId}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Failed to update task: ${message}`);
    }
  }

  async completeTask(tasklistId: string, taskId: string): Promise<GTask> {
    return this.updateTask({ tasklistId, taskId, status: 'completed' });
  }

  async uncompleteTask(tasklistId: string, taskId: string): Promise<GTask> {
    return this.updateTask({ tasklistId, taskId, status: 'needsAction' });
  }

  async deleteTask(tasklistId: string, taskId: string): Promise<void> {
    try {
      await this.tasks.tasks.delete({
        tasklist: tasklistId,
        task: taskId,
      });
    } catch (error) {
      if (this.isNotFoundError(error)) {
        throw new CliError('NOT_FOUND', `Task not found: ${taskId}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Failed to delete task: ${message}`);
    }
  }

  async clearCompleted(tasklistId: string): Promise<void> {
    try {
      await this.tasks.tasks.clear({ tasklist: tasklistId });
    } catch (error) {
      if (this.isNotFoundError(error)) {
        throw new CliError('NOT_FOUND', `Task list not found: ${tasklistId}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Failed to clear completed tasks: ${message}`);
    }
  }

  async moveTask(tasklistId: string, taskId: string, parent?: string, previous?: string): Promise<GTask> {
    try {
      const params: tasks_v1.Params$Resource$Tasks$Move = {
        tasklist: tasklistId,
        task: taskId,
      };

      if (parent) params.parent = parent;
      if (previous) params.previous = previous;

      const response = await this.tasks.tasks.move(params);

      return this.parseTask(response.data);
    } catch (error) {
      if (this.isNotFoundError(error)) {
        throw new CliError('NOT_FOUND', `Task not found: ${taskId}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new CliError('API_ERROR', `Failed to move task: ${message}`);
    }
  }

  private normalizeDue(due: string): string {
    // If it's already RFC3339, return as-is
    if (due.includes('T')) {
      return due;
    }
    // If it's just a date (YYYY-MM-DD), convert to RFC3339 with midnight UTC
    return `${due}T00:00:00.000Z`;
  }

  private parseTask(task: tasks_v1.Schema$Task): GTask {
    return {
      id: task.id!,
      title: task.title || '',
      status: (task.status as 'needsAction' | 'completed') || 'needsAction',
      notes: task.notes || undefined,
      due: task.due || undefined,
      completed: task.completed || undefined,
      parent: task.parent || undefined,
      position: task.position || undefined,
      updated: task.updated || undefined,
      selfLink: task.selfLink || undefined,
      webViewLink: task.webViewLink || undefined,
      hidden: task.hidden || undefined,
      deleted: task.deleted || undefined,
    };
  }

  private isNotFoundError(error: unknown): boolean {
    if (error && typeof error === 'object' && 'code' in error) {
      return (error as { code: unknown }).code === 404;
    }
    return false;
  }
}
