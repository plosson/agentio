import type { GTaskList, GTask } from './types';

// Google Tasks specific formatters
export function printGTasksList(taskLists: GTaskList[], nextPageToken?: string): void {
  if (taskLists.length === 0) {
    console.log('No task lists found');
    return;
  }

  console.log(`Task Lists (${taskLists.length})\n`);

  for (let i = 0; i < taskLists.length; i++) {
    const tl = taskLists[i];
    console.log(`[${i + 1}] ${tl.title}`);
    console.log(`    ID: ${tl.id}`);
    if (tl.updated) console.log(`    Updated: ${tl.updated}`);
    console.log('');
  }

  if (nextPageToken) {
    console.log(`(more results available)`);
  }
}

export function printGTaskList(taskList: GTaskList): void {
  console.log(`ID: ${taskList.id}`);
  console.log(`Title: ${taskList.title}`);
  if (taskList.updated) console.log(`Updated: ${taskList.updated}`);
  if (taskList.selfLink) console.log(`Link: ${taskList.selfLink}`);
}

export function printGTaskListCreated(taskList: GTaskList): void {
  console.log('Task list created');
  console.log(`ID: ${taskList.id}`);
  console.log(`Title: ${taskList.title}`);
}

export function printGTaskListDeleted(tasklistId: string): void {
  console.log('Task list deleted');
  console.log(`ID: ${tasklistId}`);
}

export function printGTasks(tasks: GTask[], nextPageToken?: string): void {
  if (tasks.length === 0) {
    console.log('No tasks found');
    return;
  }

  console.log(`Tasks (${tasks.length})\n`);

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const statusIcon = task.status === 'completed' ? '[x]' : '[ ]';
    const dueStr = task.due ? ` (due: ${task.due.split('T')[0]})` : '';

    console.log(`[${i + 1}] ${statusIcon} ${task.title}${dueStr}`);
    console.log(`    ID: ${task.id}`);
    console.log(`    Status: ${task.status}`);
    if (task.notes) {
      const preview = task.notes.length > 60 ? task.notes.slice(0, 60) + '...' : task.notes;
      console.log(`    > ${preview}`);
    }
    console.log('');
  }

  if (nextPageToken) {
    console.log(`(more results available)`);
  }
}

export function printGTask(task: GTask): void {
  console.log(`ID: ${task.id}`);
  console.log(`Title: ${task.title}`);
  console.log(`Status: ${task.status}`);
  if (task.due) console.log(`Due: ${task.due}`);
  if (task.completed) console.log(`Completed: ${task.completed}`);
  if (task.updated) console.log(`Updated: ${task.updated}`);
  if (task.parent) console.log(`Parent: ${task.parent}`);
  if (task.webViewLink) console.log(`Link: ${task.webViewLink}`);
  if (task.notes) {
    console.log('---');
    console.log(task.notes);
  }
}

export function printGTaskCreated(task: GTask): void {
  console.log('Task created');
  console.log(`ID: ${task.id}`);
  console.log(`Title: ${task.title}`);
  console.log(`Status: ${task.status}`);
  if (task.due) console.log(`Due: ${task.due}`);
  if (task.webViewLink) console.log(`Link: ${task.webViewLink}`);
}

export function printGTaskDeleted(tasklistId: string, taskId: string): void {
  console.log('Task deleted');
  console.log(`Task List: ${tasklistId}`);
  console.log(`Task ID: ${taskId}`);
}

export function printGTasksCleared(tasklistId: string): void {
  console.log('Completed tasks cleared');
  console.log(`Task List: ${tasklistId}`);
}
