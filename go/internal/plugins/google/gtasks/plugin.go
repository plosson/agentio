// Package gtasks is the Google Tasks service.
package gtasks

import (
	"context"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/google"
)

func New() *plugins.Plugin {
	return &plugins.Plugin{
		APIVersion:  plugins.APIVersion,
		ID:          "gtasks",
		DisplayName: "Google Tasks",
		Description: "Use when interacting with Google Tasks via the agentio CLI.",
		Profile: &plugins.ProfileSpec{
			Setup:          google.SnakeSetup("gtasks", "Google Tasks", "Could not fetch email"),
			Validate:       validate,
			Reauthenticate: google.Reauthenticate("gtasks", google.Snake),
			Refresh:        google.Snake.RefreshSpec(),
			ListInfo:       google.EmailListInfo,
		},
		Commands: []plugins.CommandSpec{
			listsListCmd(), listsCreateCmd(), listsDeleteCmd(),
			listCmd(), getCmd(), addCmd(), updateCmd(), doneCmd(), undoCmd(),
			deleteCmd(), clearCmd(), moveCmd(),
		},
	}
}

// validate is GTasksClient.validate: listing one task list proves access.
func validate(ctx context.Context, run *plugins.RunContext) (plugins.ValidationResult, error) {
	svc, err := service(ctx, run)
	if err != nil {
		return google.ValidationFailure(err), nil
	}
	if _, err := svc.Tasklists.List().MaxResults(1).Context(ctx).Do(); err != nil {
		return google.ValidationFailure(err), nil
	}
	return plugins.ValidationResult{Valid: true, Info: "tasks access ok"}, nil
}

// addInputError is Commander's requiredOption check on --title.
func addInputError(in plugins.CommandInput, fail plugins.FailFunc) error {
	if in.Option("title") == "" {
		return fail("INVALID_PARAMS", "required option '--title <title>' not specified", "")
	}
	return nil
}

// updateInputError is Bun's --status check, made before enforceWriteAccess.
func updateInputError(in plugins.CommandInput, fail plugins.FailFunc) error {
	if status := in.Option("status"); status != "" && status != "needsAction" && status != "completed" {
		return fail("INVALID_PARAMS", "Invalid status: "+status, "Use: needsAction or completed")
	}
	return nil
}

// moveInputError is Bun's --parent/--previous check, made before enforceWriteAccess.
func moveInputError(in plugins.CommandInput, fail plugins.FailFunc) error {
	if in.Option("parent") == "" && in.Option("previous") == "" {
		return fail("INVALID_PARAMS", "At least one of --parent or --previous is required", "")
	}
	return nil
}

var (
	tasklistArg = plugins.ArgumentSpec{Name: "tasklist-id", Required: true}
	taskArg     = plugins.ArgumentSpec{Name: "task-id", Required: true}
)

func listsListCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "lists list",
		Description: "List all task lists",
		Default:     true,
		Access:      "read",
		Options: []plugins.OptionSpec{
			{Flags: "--limit <n>", Description: "Max results", DefaultValue: "100"},
		},
		Examples: []string{
			"# show all your task lists with IDs",
			"agentio gtasks lists list",
			"# cap at a smaller number",
			"agentio gtasks lists list --limit 10",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.listTaskLists(jsvalue.ParseInt(in.Option("limit"))))
		},
		Format: formatTaskLists,
	}
}

func listsCreateCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "lists create",
		Description: "Create a new task list",
		Access:      "write",
		Operation:   "create task list",
		Arguments:   []plugins.ArgumentSpec{{Name: "title", Required: true}},
		Examples: []string{
			"# create a new top-level task list",
			`agentio gtasks lists create "Groceries"`,
			"# title with spaces (quote it)",
			`agentio gtasks lists create "Q4 Roadmap"`,
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.createTaskList(in.Arg("title")))
		},
		Format: formatTaskListCreated,
	}
}

func listsDeleteCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "lists delete",
		Description: "Delete a task list",
		Access:      "write",
		Operation:   "delete task list",
		Arguments:   []plugins.ArgumentSpec{tasklistArg},
		Examples: []string{
			"# delete a list (irreversible — deletes all its tasks)",
			"agentio gtasks lists delete MTIzNDU2Nzg5MA",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			id := in.Arg("tasklist-id")
			if err := a.deleteTaskList(id); err != nil {
				return nil, err
			}
			return taskListRef{TasklistID: id}, nil
		},
		Format: formatTaskListDeleted,
	}
}

func listCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "list",
		Description: "List tasks in a task list",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{tasklistArg},
		Options: []plugins.OptionSpec{
			{Flags: "--limit <n>", Description: "Max results", DefaultValue: "20"},
			{Flags: "--show-completed", Description: "Include completed tasks", DefaultValue: true},
			{Flags: "--no-show-completed", Description: "Exclude completed tasks"},
			{Flags: "--show-hidden", Description: "Include hidden tasks"},
			{Flags: "--due-min <datetime>", Description: "Filter: due date minimum (RFC3339)"},
			{Flags: "--due-max <datetime>", Description: "Filter: due date maximum (RFC3339)"},
		},
		Examples: []string{
			"# tasks in a list (default: includes completed)",
			"agentio gtasks list MTIzNDU2Nzg5MA",
			"# only outstanding work",
			"agentio gtasks list MTIzNDU2Nzg5MA --no-show-completed",
			"# tasks due this week",
			`agentio gtasks list MTIzNDU2Nzg5MA \`,
			"  --due-min 2024-04-15T00:00:00Z --due-max 2024-04-22T00:00:00Z",
			"# include hidden (cleared completed) tasks too",
			"agentio gtasks list MTIzNDU2Nzg5MA --show-hidden",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.listTasks(listOptions{
				tasklistID:    in.Arg("tasklist-id"),
				limit:         jsvalue.ParseInt(in.Option("limit")),
				showCompleted: in.Flag("show-completed") && !in.Flag("no-show-completed"),
				showHidden:    in.Flag("show-hidden"),
				dueMin:        in.Option("due-min"),
				dueMax:        in.Option("due-max"),
			}))
		},
		Format: formatTasks,
	}
}

func getCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "get",
		Description: "Get a specific task",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{tasklistArg, taskArg},
		Examples: []string{
			"# full task details (notes, due, status, parent)",
			"agentio gtasks get MTIzNDU2Nzg5MA NjU0MzIxMA",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.getTask(in.Arg("tasklist-id"), in.Arg("task-id")))
		},
		Format: formatTask,
	}
}

func addCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "add",
		Description: "Add a new task",
		Access:      "write",
		AccessFor:   plugins.WriteUnlessInvalid(addInputError),
		Operation:   "create task",
		Input:       "text",
		Arguments:   []plugins.ArgumentSpec{tasklistArg},
		Options: []plugins.OptionSpec{
			{Flags: "--title <title>", Description: "Task title"},
			{Flags: "--notes <text>", Description: "Task notes/description (or pipe via stdin)"},
			{Flags: "--due <date>", Description: "Due date (RFC3339 or YYYY-MM-DD)"},
			{Flags: "--parent <task-id>", Description: "Parent task ID (create as subtask)"},
			{Flags: "--previous <task-id>", Description: "Previous sibling task ID (controls ordering)"},
		},
		Examples: []string{
			"# simple task",
			`agentio gtasks add MTIzNDU2Nzg5MA --title "Buy milk"`,
			"# task with notes (piped from stdin) and a due date",
			`echo "2 cartons, organic" | agentio gtasks add MTIzNDU2Nzg5MA --title "Buy milk" --due 2024-04-20`,
			"# subtask of an existing task",
			`agentio gtasks add MTIzNDU2Nzg5MA --title "Section 1" --parent NjU0MzIxMA`,
			"# control ordering: place new task right after another",
			`agentio gtasks add MTIzNDU2Nzg5MA --title "Step 2" --previous NjU0MzIxMA`,
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			if err := addInputError(in, run.Fail); err != nil {
				return nil, err
			}
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			text, given := plugins.OptionOrStdin(in, "notes", true)
			return plugins.Result(a.createTask(createOptions{
				tasklistID: in.Arg("tasklist-id"),
				title:      in.Option("title"),
				notes:      text,
				notesGiven: given,
				due:        in.Option("due"),
				parent:     in.Option("parent"),
				previous:   in.Option("previous"),
			}))
		},
		Format: formatTaskCreated,
	}
}

func updateCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "update",
		Description: "Update an existing task",
		Access:      "write",
		AccessFor:   plugins.WriteUnlessInvalid(updateInputError),
		Operation:   "update task",
		Input:       "text",
		Arguments:   []plugins.ArgumentSpec{tasklistArg, taskArg},
		Options: []plugins.OptionSpec{
			{Flags: "--title <title>", Description: "New title"},
			{Flags: "--notes <text>", Description: "New notes (or pipe via stdin)"},
			{Flags: "--due <date>", Description: "New due date (RFC3339 or YYYY-MM-DD, empty to clear)"},
			{Flags: "--status <status>", Description: "New status: needsAction or completed"},
		},
		Examples: []string{
			"# rename a task",
			`agentio gtasks update MTIzNDU2Nzg5MA NjU0MzIxMA --title "Buy oat milk"`,
			"# change due date",
			"agentio gtasks update MTIzNDU2Nzg5MA NjU0MzIxMA --due 2024-04-22",
			"# replace notes from stdin",
			"cat new-notes.txt | agentio gtasks update MTIzNDU2Nzg5MA NjU0MzIxMA",
			"# mark complete via status",
			"agentio gtasks update MTIzNDU2Nzg5MA NjU0MzIxMA --status completed",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			if err := updateInputError(in, run.Fail); err != nil {
				return nil, err
			}
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			o := updateOptions{tasklistID: in.Arg("tasklist-id"), taskID: in.Arg("task-id")}
			o.title, o.titleGiven = in.LookupOption("title")
			o.notes, o.notesGiven = plugins.OptionOrStdin(in, "notes", false)
			o.due, o.dueGiven = in.LookupOption("due")
			o.status, o.statusGiven = in.LookupOption("status")
			return plugins.Result(a.updateTask(o))
		},
		Format: formatTask,
	}
}

// statusCmd is done/undo: an update of the status alone.
func statusCmd(path, alias, description, operation, status, verb, example string) plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        path,
		Aliases:     []string{alias},
		Description: description,
		Access:      "write",
		Operation:   operation,
		Arguments:   []plugins.ArgumentSpec{tasklistArg, taskArg},
		Examples:    []string{example, "agentio gtasks " + path + " MTIzNDU2Nzg5MA NjU0MzIxMA"},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.updateTask(updateOptions{
				tasklistID: in.Arg("tasklist-id"), taskID: in.Arg("task-id"), status: status, statusGiven: true,
			}))
		},
		Format: formatStatusChange(verb),
	}
}

func doneCmd() plugins.CommandSpec {
	return statusCmd("done", "complete", "Mark a task as completed", "complete task", "completed", "completed", "# mark a task complete")
}

func undoCmd() plugins.CommandSpec {
	return statusCmd("undo", "uncomplete", "Mark a task as needs action (not completed)", "uncomplete task", "needsAction", "uncompleted", "# revert a task back to needs-action")
}

func deleteCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "delete",
		Description: "Delete a task",
		Access:      "write",
		Operation:   "delete task",
		Arguments:   []plugins.ArgumentSpec{tasklistArg, taskArg},
		Examples: []string{
			"# remove a task entirely (irreversible)",
			"agentio gtasks delete MTIzNDU2Nzg5MA NjU0MzIxMA",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			ref := taskRef{TasklistID: in.Arg("tasklist-id"), TaskID: in.Arg("task-id")}
			if err := a.deleteTask(ref.TasklistID, ref.TaskID); err != nil {
				return nil, err
			}
			return ref, nil
		},
		Format: formatTaskDeleted,
	}
}

func clearCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "clear",
		Description: "Clear all completed tasks from a task list",
		Access:      "write",
		Operation:   "clear tasks",
		Arguments:   []plugins.ArgumentSpec{tasklistArg},
		Examples: []string{
			"# hide all completed tasks from the list",
			"agentio gtasks clear MTIzNDU2Nzg5MA",
			"Cleared tasks remain accessible via 'gtasks list --show-hidden'.",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			id := in.Arg("tasklist-id")
			if err := a.clearCompleted(id); err != nil {
				return nil, err
			}
			return taskListRef{TasklistID: id}, nil
		},
		Format: formatCleared,
	}
}

func moveCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "move",
		Description: "Move a task (change parent or position)",
		Access:      "write",
		AccessFor:   plugins.WriteUnlessInvalid(moveInputError),
		Operation:   "move task",
		Arguments:   []plugins.ArgumentSpec{tasklistArg, taskArg},
		Options: []plugins.OptionSpec{
			{Flags: "--parent <task-id>", Description: "New parent task ID (make subtask)"},
			{Flags: "--previous <task-id>", Description: "Previous sibling task ID (change position)"},
		},
		Examples: []string{
			"# nest a task under another (make it a subtask)",
			"agentio gtasks move MTIzNDU2Nzg5MA NjU0MzIxMA --parent ABCD1234EFGH",
			"# reorder: place after a specific sibling",
			"agentio gtasks move MTIzNDU2Nzg5MA NjU0MzIxMA --previous ABCD1234EFGH",
			"# promote subtask + reorder in one call",
			"agentio gtasks move MTIzNDU2Nzg5MA NjU0MzIxMA --parent NEWP4R3NTID --previous ABCD1234EFGH",
			"At least one of --parent or --previous is required.",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			if err := moveInputError(in, run.Fail); err != nil {
				return nil, err
			}
			a, err := apiFrom(ctx, run)
			if err != nil {
				return nil, err
			}
			return plugins.Result(a.moveTask(in.Arg("tasklist-id"), in.Arg("task-id"), in.Option("parent"), in.Option("previous")))
		},
		Format: formatMoved,
	}
}
