package gtasks

import (
	"context"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/google"
	tasks "google.golang.org/api/tasks/v1"
)

// The models are the Bun client's objects (GTaskList, GTask and the list
// results), built from the answer as JavaScript reads it (google.Answer): an
// id the answer lacks is undefined, and a null item fails with Bun's
// TypeError.

// taskListOf is the GTaskList Bun builds from tl.
func taskListOf(tl any) (*jsvalue.Object, error) {
	if jsvalue.Nullish(tl) {
		return nil, jsvalue.TypeError(tl, "tl.id")
	}
	get := func(k string) any { return jsvalue.Member(tl, k) }
	return jsvalue.ObjectOf(
		"id", get("id"),
		"title", jsvalue.Or(get("title"), ""),
		"updated", jsvalue.Or(get("updated"), jsvalue.Undefined),
		"selfLink", jsvalue.Or(get("selfLink"), jsvalue.Undefined),
	), nil
}

// parseTask is Bun parseTask: every falsy optional field is undefined.
func parseTask(t any) (*jsvalue.Object, error) {
	if jsvalue.Nullish(t) {
		return nil, jsvalue.TypeError(t, "task.id")
	}
	get := func(k string) any { return jsvalue.Member(t, k) }
	opt := func(k string) any { return jsvalue.Or(get(k), jsvalue.Undefined) }
	return jsvalue.ObjectOf(
		"id", get("id"),
		"title", jsvalue.Or(get("title"), ""),
		"status", jsvalue.Or(get("status"), "needsAction"),
		"notes", opt("notes"),
		"due", opt("due"),
		"completed", opt("completed"),
		"parent", opt("parent"),
		"position", opt("position"),
		"updated", opt("updated"),
		"selfLink", opt("selfLink"),
		"webViewLink", opt("webViewLink"),
		"hidden", opt("hidden"),
		"deleted", opt("deleted"),
	), nil
}

// page is `{ <key>: (response.data.items || []).map(parse), nextPageToken:
// response.data.nextPageToken || undefined }`.
func page(raw any, key string, parse func(any) (*jsvalue.Object, error)) (*jsvalue.Object, error) {
	items, err := google.AnswerItems(raw, "response.data", "items")
	if err != nil {
		return nil, err
	}
	out, err := jsvalue.Map(items, "", func(item any) (any, error) { return parse(item) })
	if err != nil {
		return nil, err
	}
	return jsvalue.ObjectOf(key, out, "nextPageToken", jsvalue.Or(jsvalue.Member(raw, "nextPageToken"), jsvalue.Undefined)), nil
}

type taskListRef struct {
	TasklistID string `json:"tasklistId"`
}

type taskRef struct {
	TasklistID string `json:"tasklistId"`
	TaskID     string `json:"taskId"`
}

type api struct {
	google.API
	svc *tasks.Service
}

func service(ctx context.Context, run *plugins.RunContext) (*tasks.Service, error) {
	return google.NewService(ctx, run, google.Snake, tasks.NewService)
}

func apiFrom(ctx context.Context, run *plugins.RunContext) (*api, error) {
	svc, err := service(ctx, run)
	if err != nil {
		return nil, err
	}
	return &api{API: google.API{Ctx: ctx, RunContext: run}, svc: svc}, nil
}

func (a *api) listTaskLists(limit float64) (*jsvalue.Object, error) {
	_, raw, err := google.Answer(a.Ctx, a.svc.Tasklists.List(), google.MaxResults(limit, 100))
	if err == nil {
		var out *jsvalue.Object
		if out, err = page(raw, "taskLists", taskListOf); err == nil {
			return out, nil
		}
	}
	return nil, a.APIError("Tasks API error", err)
}

func (a *api) createTaskList(title string) (*jsvalue.Object, error) {
	body := &tasks.TaskList{Title: title, ForceSendFields: []string{"Title"}}
	_, raw, err := google.Answer(a.Ctx, a.svc.Tasklists.Insert(body))
	if err == nil && jsvalue.Nullish(raw) {
		err = jsvalue.TypeError(raw, "response.data.id")
	}
	if err != nil {
		return nil, a.APIError("Failed to create task list", err)
	}
	return taskListOf(raw)
}

func (a *api) deleteTaskList(id string) error {
	if err := a.svc.Tasklists.Delete(id).Context(a.Ctx).Do(); err != nil {
		return a.NotFoundOr("Task list", id, "Failed to delete task list", err)
	}
	return nil
}

type listOptions struct {
	tasklistID                string
	limit                     float64
	showCompleted, showHidden bool
	dueMin, dueMax            string
}

func (a *api) listTasks(o listOptions) (*jsvalue.Object, error) {
	call := a.svc.Tasks.List(o.tasklistID).
		ShowCompleted(o.showCompleted).ShowDeleted(false).ShowHidden(o.showHidden)
	if o.dueMin != "" {
		call.DueMin(o.dueMin)
	}
	if o.dueMax != "" {
		call.DueMax(o.dueMax)
	}
	_, raw, err := google.Answer(a.Ctx, call, google.MaxResults(o.limit, 100))
	if err == nil {
		var out *jsvalue.Object
		if out, err = page(raw, "tasks", parseTask); err == nil {
			return out, nil
		}
	}
	return nil, a.NotFoundOr("Task list", o.tasklistID, "Tasks API error", err)
}

// taskAnswer is `this.parseTask(response.data)` inside a client method's try:
// a failure, the call's or parseTask's, goes to fail.
func taskAnswer[C google.Call[C, *tasks.Task]](a *api, call C, fail func(error) error) (*jsvalue.Object, error) {
	_, raw, err := google.Answer(a.Ctx, call)
	if err != nil {
		return nil, fail(err)
	}
	t, err := parseTask(raw)
	if err != nil {
		return nil, fail(err)
	}
	return t, nil
}

func (a *api) getTask(tasklistID, taskID string) (*jsvalue.Object, error) {
	return taskAnswer(a, a.svc.Tasks.Get(tasklistID, taskID), func(err error) error {
		return a.NotFoundOr("Task", taskID, "Tasks API error", err)
	})
}

type createOptions struct {
	tasklistID, title, notes string
	notesGiven               bool
	due, parent, previous    string
}

func (a *api) createTask(o createOptions) (*jsvalue.Object, error) {
	body := &tasks.Task{Title: o.title, ForceSendFields: []string{"Title"}}
	if o.notesGiven {
		body.Notes = o.notes
		body.ForceSendFields = append(body.ForceSendFields, "Notes")
	}
	if o.due != "" {
		body.Due = normalizeDue(o.due)
	}
	call := a.svc.Tasks.Insert(o.tasklistID, body)
	if o.parent != "" {
		call.Parent(o.parent)
	}
	if o.previous != "" {
		call.Previous(o.previous)
	}
	return taskAnswer(a, call, func(err error) error {
		return a.NotFoundOr("Task list", o.tasklistID, "Failed to create task", err)
	})
}

// updateOptions keeps Bun's `!== undefined` checks: a given empty value is
// sent, and a given empty --due clears the date (null).
type updateOptions struct {
	tasklistID, taskID string
	title              string
	titleGiven         bool
	notes              string
	notesGiven         bool
	due                string
	dueGiven           bool
	status             string
	statusGiven        bool
}

func (a *api) updateTask(o updateOptions) (*jsvalue.Object, error) {
	patch := &tasks.Task{}
	if o.titleGiven {
		patch.Title = o.title
		patch.ForceSendFields = append(patch.ForceSendFields, "Title")
	}
	if o.notesGiven {
		patch.Notes = o.notes
		patch.ForceSendFields = append(patch.ForceSendFields, "Notes")
	}
	if o.dueGiven {
		if o.due == "" {
			patch.NullFields = append(patch.NullFields, "Due")
		} else {
			patch.Due = normalizeDue(o.due)
		}
	}
	if o.statusGiven {
		patch.Status = o.status
		patch.ForceSendFields = append(patch.ForceSendFields, "Status")
	}
	return taskAnswer(a, a.svc.Tasks.Patch(o.tasklistID, o.taskID, patch), func(err error) error {
		return a.NotFoundOr("Task", o.taskID, "Failed to update task", err)
	})
}

func (a *api) deleteTask(tasklistID, taskID string) error {
	if err := a.svc.Tasks.Delete(tasklistID, taskID).Context(a.Ctx).Do(); err != nil {
		return a.NotFoundOr("Task", taskID, "Failed to delete task", err)
	}
	return nil
}

func (a *api) clearCompleted(tasklistID string) error {
	if err := a.svc.Tasks.Clear(tasklistID).Context(a.Ctx).Do(); err != nil {
		return a.NotFoundOr("Task list", tasklistID, "Failed to clear completed tasks", err)
	}
	return nil
}

func (a *api) moveTask(tasklistID, taskID, parent, previous string) (*jsvalue.Object, error) {
	call := a.svc.Tasks.Move(tasklistID, taskID)
	if parent != "" {
		call.Parent(parent)
	}
	if previous != "" {
		call.Previous(previous)
	}
	return taskAnswer(a, call, func(err error) error {
		return a.NotFoundOr("Task", taskID, "Failed to move task", err)
	})
}

// normalizeDue is Bun normalizeDue: a date without "T" is midnight UTC.
func normalizeDue(due string) string {
	if strings.Contains(due, "T") {
		return due
	}
	return due + "T00:00:00.000Z"
}
