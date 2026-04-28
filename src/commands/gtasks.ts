import { Command } from 'commander';
import { getValidTokens, createGoogleAuth, fetchGoogleUserEmail } from '../auth/token-manager';
import { setCredentials } from '../auth/token-store';
import { setProfile, getProfile } from '../config/config-manager';
import { createProfileCommands } from '../utils/profile-commands';
import { performOAuthFlow } from '../auth/oauth';
import { GTasksClient } from '../services/gtasks/client';
import {
  printGTasksList,
  printGTaskList,
  printGTaskListCreated,
  printGTaskListDeleted,
  printGTasks,
  printGTask,
  printGTaskCreated,
  printGTaskDeleted,
  printGTasksCleared,
} from '../utils/output';
import { CliError, handleError } from '../utils/errors';
import { readStdin } from '../utils/stdin';
import { enforceWriteAccess } from '../utils/read-only';
import { addExamples } from '../utils/command-tree';

async function getGTasksClient(profileName?: string): Promise<{ client: GTasksClient; profile: string }> {
  const { tokens, profile } = await getValidTokens('gtasks', profileName);
  const auth = createGoogleAuth(tokens);
  return { client: new GTasksClient(auth), profile };
}

export function registerGTasksCommands(program: Command): void {
  const gtasks = program
    .command('gtasks')
    .description('Google Tasks operations');

  // === Task Lists Commands ===

  const lists = gtasks
    .command('lists')
    .description('Manage task lists');

  // List task lists (default subcommand)
  addExamples(
    lists
      .command('list', { isDefault: true })
      .description('List all task lists')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .option('--limit <n>', 'Max results', '100')
      .action(async (options) => {
        try {
          const { client } = await getGTasksClient(options.profile);
          const result = await client.listTaskLists(parseInt(options.limit, 10));
          printGTasksList(result.taskLists, result.nextPageToken);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # show all your task lists with IDs
  agentio gtasks lists list

  # cap at a smaller number
  agentio gtasks lists list --limit 10`,
  );

  // Create task list
  addExamples(
    lists
      .command('create <title>')
      .description('Create a new task list')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .action(async (title: string, options) => {
        try {
          const { client, profile } = await getGTasksClient(options.profile);
          await enforceWriteAccess('gtasks', profile, 'create task list');
          const taskList = await client.createTaskList(title);
          printGTaskListCreated(taskList);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # create a new top-level task list
  agentio gtasks lists create "Groceries"

  # title with spaces (quote it)
  agentio gtasks lists create "Q4 Roadmap"`,
  );

  // Delete task list
  addExamples(
    lists
      .command('delete <tasklist-id>')
      .description('Delete a task list')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .action(async (tasklistId: string, options) => {
        try {
          const { client, profile } = await getGTasksClient(options.profile);
          await enforceWriteAccess('gtasks', profile, 'delete task list');
          await client.deleteTaskList(tasklistId);
          printGTaskListDeleted(tasklistId);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # delete a list (irreversible — deletes all its tasks)
  agentio gtasks lists delete MTIzNDU2Nzg5MA`,
  );

  // === Task Commands ===

  // List tasks in a task list
  addExamples(
    gtasks
      .command('list <tasklist-id>')
      .description('List tasks in a task list')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .option('--limit <n>', 'Max results', '20')
      .option('--show-completed', 'Include completed tasks', true)
      .option('--no-show-completed', 'Exclude completed tasks')
      .option('--show-hidden', 'Include hidden tasks')
      .option('--due-min <datetime>', 'Filter: due date minimum (RFC3339)')
      .option('--due-max <datetime>', 'Filter: due date maximum (RFC3339)')
      .action(async (tasklistId: string, options) => {
        try {
          const { client } = await getGTasksClient(options.profile);
          const result = await client.listTasks({
            tasklistId,
            maxResults: parseInt(options.limit, 10),
            showCompleted: options.showCompleted,
            showHidden: options.showHidden,
            dueMin: options.dueMin,
            dueMax: options.dueMax,
          });
          printGTasks(result.tasks, result.nextPageToken);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # tasks in a list (default: includes completed)
  agentio gtasks list MTIzNDU2Nzg5MA

  # only outstanding work
  agentio gtasks list MTIzNDU2Nzg5MA --no-show-completed

  # tasks due this week
  agentio gtasks list MTIzNDU2Nzg5MA \\
    --due-min 2024-04-15T00:00:00Z --due-max 2024-04-22T00:00:00Z

  # include hidden (cleared completed) tasks too
  agentio gtasks list MTIzNDU2Nzg5MA --show-hidden`,
  );

  // Get a specific task
  addExamples(
    gtasks
      .command('get <tasklist-id> <task-id>')
      .description('Get a specific task')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .action(async (tasklistId: string, taskId: string, options) => {
        try {
          const { client } = await getGTasksClient(options.profile);
          const task = await client.getTask(tasklistId, taskId);
          printGTask(task);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # full task details (notes, due, status, parent)
  agentio gtasks get MTIzNDU2Nzg5MA NjU0MzIxMA`,
  );

  // Add a new task
  const addCmd = gtasks
    .command('add <tasklist-id>')
    .description('Add a new task')
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
    .requiredOption('--title <title>', 'Task title')
    .option('--notes <text>', 'Task notes/description (or pipe via stdin)')
    .option('--due <date>', 'Due date (RFC3339 or YYYY-MM-DD)')
    .option('--parent <task-id>', 'Parent task ID (create as subtask)')
    .option('--previous <task-id>', 'Previous sibling task ID (controls ordering)')
    .action(async (tasklistId: string, options) => {
      try {
        let notes = options.notes;
        if (!notes) {
          const stdin = await readStdin();
          if (stdin) notes = stdin;
        }

        const { client, profile } = await getGTasksClient(options.profile);
        await enforceWriteAccess('gtasks', profile, 'create task');
        const task = await client.createTask({
          tasklistId,
          title: options.title,
          notes,
          due: options.due,
          parent: options.parent,
          previous: options.previous,
        });
        printGTaskCreated(task);
      } catch (error) {
        handleError(error);
      }
    });

  addExamples(
    addCmd,
    `Examples:

  # simple task
  agentio gtasks add MTIzNDU2Nzg5MA --title "Buy milk"

  # task with notes (piped from stdin) and a due date
  echo "2 cartons, organic" | agentio gtasks add MTIzNDU2Nzg5MA --title "Buy milk" --due 2024-04-20

  # subtask of an existing task
  agentio gtasks add MTIzNDU2Nzg5MA --title "Section 1" --parent NjU0MzIxMA

  # control ordering: place new task right after another
  agentio gtasks add MTIzNDU2Nzg5MA --title "Step 2" --previous NjU0MzIxMA`,
  );

  // Update a task
  const updateCmd = gtasks
    .command('update <tasklist-id> <task-id>')
    .description('Update an existing task')
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
    .option('--title <title>', 'New title')
    .option('--notes <text>', 'New notes (or pipe via stdin)')
    .option('--due <date>', 'New due date (RFC3339 or YYYY-MM-DD, empty to clear)')
    .option('--status <status>', 'New status: needsAction or completed')
    .action(async (tasklistId: string, taskId: string, options) => {
      try {
        let notes = options.notes;
        if (notes === undefined && !process.stdin.isTTY) {
          const stdin = await readStdin();
          if (stdin) notes = stdin;
        }

        if (options.status && !['needsAction', 'completed'].includes(options.status)) {
          throw new CliError('INVALID_PARAMS', `Invalid status: ${options.status}`, 'Use: needsAction or completed');
        }

        const { client, profile } = await getGTasksClient(options.profile);
        await enforceWriteAccess('gtasks', profile, 'update task');
        const task = await client.updateTask({
          tasklistId,
          taskId,
          title: options.title,
          notes,
          due: options.due,
          status: options.status,
        });
        printGTask(task);
      } catch (error) {
        handleError(error);
      }
    });

  addExamples(
    updateCmd,
    `Examples:

  # rename a task
  agentio gtasks update MTIzNDU2Nzg5MA NjU0MzIxMA --title "Buy oat milk"

  # change due date
  agentio gtasks update MTIzNDU2Nzg5MA NjU0MzIxMA --due 2024-04-22

  # replace notes from stdin
  cat new-notes.txt | agentio gtasks update MTIzNDU2Nzg5MA NjU0MzIxMA

  # mark complete via status
  agentio gtasks update MTIzNDU2Nzg5MA NjU0MzIxMA --status completed`,
  );

  // Mark task as done
  addExamples(
    gtasks
      .command('done <tasklist-id> <task-id>')
      .alias('complete')
      .description('Mark a task as completed')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .action(async (tasklistId: string, taskId: string, options) => {
        try {
          const { client, profile } = await getGTasksClient(options.profile);
          await enforceWriteAccess('gtasks', profile, 'complete task');
          const task = await client.completeTask(tasklistId, taskId);
          console.log(`Task completed: ${task.title}`);
          console.log(`ID: ${task.id}`);
          console.log(`Status: ${task.status}`);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # mark a task complete
  agentio gtasks done MTIzNDU2Nzg5MA NjU0MzIxMA`,
  );

  // Mark task as not done
  addExamples(
    gtasks
      .command('undo <tasklist-id> <task-id>')
      .alias('uncomplete')
      .description('Mark a task as needs action (not completed)')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .action(async (tasklistId: string, taskId: string, options) => {
        try {
          const { client, profile } = await getGTasksClient(options.profile);
          await enforceWriteAccess('gtasks', profile, 'uncomplete task');
          const task = await client.uncompleteTask(tasklistId, taskId);
          console.log(`Task uncompleted: ${task.title}`);
          console.log(`ID: ${task.id}`);
          console.log(`Status: ${task.status}`);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # revert a task back to needs-action
  agentio gtasks undo MTIzNDU2Nzg5MA NjU0MzIxMA`,
  );

  // Delete a task
  addExamples(
    gtasks
      .command('delete <tasklist-id> <task-id>')
      .description('Delete a task')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .action(async (tasklistId: string, taskId: string, options) => {
        try {
          const { client, profile } = await getGTasksClient(options.profile);
          await enforceWriteAccess('gtasks', profile, 'delete task');
          await client.deleteTask(tasklistId, taskId);
          printGTaskDeleted(tasklistId, taskId);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # remove a task entirely (irreversible)
  agentio gtasks delete MTIzNDU2Nzg5MA NjU0MzIxMA`,
  );

  // Clear completed tasks
  addExamples(
    gtasks
      .command('clear <tasklist-id>')
      .description('Clear all completed tasks from a task list')
      .option('--profile <name>', 'Profile name (optional if only one profile exists)')
      .action(async (tasklistId: string, options) => {
        try {
          const { client, profile } = await getGTasksClient(options.profile);
          await enforceWriteAccess('gtasks', profile, 'clear tasks');
          await client.clearCompleted(tasklistId);
          printGTasksCleared(tasklistId);
        } catch (error) {
          handleError(error);
        }
      }),
    `Examples:

  # hide all completed tasks from the list
  agentio gtasks clear MTIzNDU2Nzg5MA

Cleared tasks remain accessible via 'gtasks list --show-hidden'.`,
  );

  // Move a task
  const moveCmd = gtasks
    .command('move <tasklist-id> <task-id>')
    .description('Move a task (change parent or position)')
    .option('--profile <name>', 'Profile name (optional if only one profile exists)')
    .option('--parent <task-id>', 'New parent task ID (make subtask)')
    .option('--previous <task-id>', 'Previous sibling task ID (change position)')
    .action(async (tasklistId: string, taskId: string, options) => {
      try {
        if (!options.parent && !options.previous) {
          throw new CliError('INVALID_PARAMS', 'At least one of --parent or --previous is required');
        }
        const { client, profile } = await getGTasksClient(options.profile);
        await enforceWriteAccess('gtasks', profile, 'move task');
        const task = await client.moveTask(tasklistId, taskId, options.parent, options.previous);
        console.log(`Task moved: ${task.title}`);
        console.log(`ID: ${task.id}`);
        if (task.parent) console.log(`Parent: ${task.parent}`);
      } catch (error) {
        handleError(error);
      }
    });

  addExamples(
    moveCmd,
    `Examples:

  # nest a task under another (make it a subtask)
  agentio gtasks move MTIzNDU2Nzg5MA NjU0MzIxMA --parent ABCD1234EFGH

  # reorder: place after a specific sibling
  agentio gtasks move MTIzNDU2Nzg5MA NjU0MzIxMA --previous ABCD1234EFGH

  # promote subtask + reorder in one call
  agentio gtasks move MTIzNDU2Nzg5MA NjU0MzIxMA --parent NEWP4R3NTID --previous ABCD1234EFGH

At least one of --parent or --previous is required.`,
  );

  // Profile management
  const profile = createProfileCommands<{ email?: string }>(gtasks, {
    service: 'gtasks',
    displayName: 'Google Tasks',
    getExtraInfo: (credentials) => credentials?.email ? ` - ${credentials.email}` : '',
  });

  profile
    .command('add')
    .description('Add a new Google Tasks profile')
    .option('--profile <name>', 'Profile name (auto-detected from email if not provided)')
    .option('--read-only', 'Create as read-only profile (blocks write operations)')
    .action(async (options) => {
      try {
        await gtasksProfileAdd(options);
      } catch (error) {
        handleError(error);
      }
    });
}

export async function gtasksProfileAdd(options: { profile?: string; readOnly?: boolean }): Promise<void> {
  console.error('Starting OAuth flow for Google Tasks...\n');

  const tokens = await performOAuthFlow('gtasks');

  // Fetch user email
  let email: string;
  try {
    email = await fetchGoogleUserEmail(tokens.access_token);
  } catch (error) {
    throw new CliError('AUTH_FAILED', 'Could not fetch email', 'Try again or specify --profile manually');
  }

  // Determine profile name: use explicit --profile, or email, or email-readonly if conflict
  let profileName: string;
  if (options.profile) {
    profileName = options.profile;
  } else if (options.readOnly && await getProfile('gtasks', email)) {
    // Profile with email already exists, use -readonly suffix
    profileName = `${email}-readonly`;
  } else {
    profileName = email;
  }

  await setProfile('gtasks', profileName, { readOnly: options.readOnly });
  await setCredentials('gtasks', profileName, { ...tokens, email });

  console.log(`\nSuccess! Profile "${profileName}" configured.`);
  console.log(`   Email: ${email}`);
  if (options.readOnly) {
    console.log(`   Access: read-only`);
  }
}
