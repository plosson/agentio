package gtasks

import (
	"context"
	"strings"

	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/google"
	tasks "google.golang.org/api/tasks/v1"
)

// taskList is GTaskList.
type taskList struct {
	ID       string `json:"id,omitempty"`
	Title    string `json:"title"`
	Updated  string `json:"updated,omitempty"`
	SelfLink string `json:"selfLink,omitempty"`
}

// task is GTask: Bun's parseTask drops every falsy optional field.
type task struct {
	ID          string `json:"id,omitempty"`
	Title       string `json:"title"`
	Status      string `json:"status"`
	Notes       string `json:"notes,omitempty"`
	Due         string `json:"due,omitempty"`
	Completed   string `json:"completed,omitempty"`
	Parent      string `json:"parent,omitempty"`
	Position    string `json:"position,omitempty"`
	Updated     string `json:"updated,omitempty"`
	SelfLink    string `json:"selfLink,omitempty"`
	WebViewLink string `json:"webViewLink,omitempty"`
	Hidden      bool   `json:"hidden,omitempty"`
	Deleted     bool   `json:"deleted,omitempty"`
}

type taskListPage struct {
	TaskLists     []taskList `json:"taskLists"`
	NextPageToken string     `json:"nextPageToken,omitempty"`
}

type taskPage struct {
	Tasks         []task `json:"tasks"`
	NextPageToken string `json:"nextPageToken,omitempty"`
}

type taskListRef struct {
	TasklistID string `json:"tasklistId"`
}

type taskRef struct {
	TasklistID string `json:"tasklistId"`
	TaskID     string `json:"taskId"`
}

type api struct {
	ctx  context.Context
	svc  *tasks.Service
	fail func(code plugins.ErrorCode, message, suggestion string) error
}

func service(ctx context.Context, run *plugins.RunContext) (*tasks.Service, error) {
	return google.NewService(ctx, run, google.Snake, tasks.NewService)
}

func apiFrom(ctx context.Context, run *plugins.RunContext) (*api, error) {
	svc, err := service(ctx, run)
	if err != nil {
		return nil, err
	}
	return &api{ctx: ctx, svc: svc, fail: run.Fail}, nil
}

// apiError is Bun `throw new CliError('API_ERROR', `${prefix}: ${message}`)`.
func (a *api) apiError(prefix string, err error) error {
	return a.fail("API_ERROR", prefix+": "+google.Message(err), "")
}

// notFoundOr is the Bun isNotFoundError branch before the generic API error.
func (a *api) notFoundOr(what, id, prefix string, err error) error {
	if google.IsNotFound(err) {
		return a.fail("NOT_FOUND", what+" not found: "+id, "")
	}
	return a.apiError(prefix, err)
}

func (a *api) listTaskLists(limit float64) (*taskListPage, error) {
	resp, err := a.svc.Tasklists.List().Context(a.ctx).Do(google.MaxResults(limit, 100))
	if err != nil {
		return nil, a.apiError("Tasks API error", err)
	}
	out := &taskListPage{TaskLists: []taskList{}, NextPageToken: resp.NextPageToken}
	for _, tl := range resp.Items {
		out.TaskLists = append(out.TaskLists, parseTaskList(tl))
	}
	return out, nil
}

func (a *api) createTaskList(title string) (*taskList, error) {
	body := &tasks.TaskList{Title: title, ForceSendFields: []string{"Title"}}
	tl, err := a.svc.Tasklists.Insert(body).Context(a.ctx).Do()
	if err != nil {
		return nil, a.apiError("Failed to create task list", err)
	}
	parsed := parseTaskList(tl)
	return &parsed, nil
}

func (a *api) deleteTaskList(id string) error {
	if err := a.svc.Tasklists.Delete(id).Context(a.ctx).Do(); err != nil {
		return a.notFoundOr("Task list", id, "Failed to delete task list", err)
	}
	return nil
}

type listOptions struct {
	tasklistID                string
	limit                     float64
	showCompleted, showHidden bool
	dueMin, dueMax            string
}

func (a *api) listTasks(o listOptions) (*taskPage, error) {
	call := a.svc.Tasks.List(o.tasklistID).
		ShowCompleted(o.showCompleted).ShowDeleted(false).ShowHidden(o.showHidden).Context(a.ctx)
	if o.dueMin != "" {
		call.DueMin(o.dueMin)
	}
	if o.dueMax != "" {
		call.DueMax(o.dueMax)
	}
	resp, err := call.Do(google.MaxResults(o.limit, 100))
	if err != nil {
		return nil, a.notFoundOr("Task list", o.tasklistID, "Tasks API error", err)
	}
	out := &taskPage{Tasks: []task{}, NextPageToken: resp.NextPageToken}
	for _, t := range resp.Items {
		out.Tasks = append(out.Tasks, parseTask(t))
	}
	return out, nil
}

func (a *api) getTask(tasklistID, taskID string) (*task, error) {
	t, err := a.svc.Tasks.Get(tasklistID, taskID).Context(a.ctx).Do()
	if err != nil {
		return nil, a.notFoundOr("Task", taskID, "Tasks API error", err)
	}
	parsed := parseTask(t)
	return &parsed, nil
}

type createOptions struct {
	tasklistID, title, notes string
	notesGiven               bool
	due, parent, previous    string
}

func (a *api) createTask(o createOptions) (*task, error) {
	body := &tasks.Task{Title: o.title, ForceSendFields: []string{"Title"}}
	if o.notesGiven {
		body.Notes = o.notes
		body.ForceSendFields = append(body.ForceSendFields, "Notes")
	}
	if o.due != "" {
		body.Due = normalizeDue(o.due)
	}
	call := a.svc.Tasks.Insert(o.tasklistID, body).Context(a.ctx)
	if o.parent != "" {
		call.Parent(o.parent)
	}
	if o.previous != "" {
		call.Previous(o.previous)
	}
	t, err := call.Do()
	if err != nil {
		return nil, a.notFoundOr("Task list", o.tasklistID, "Failed to create task", err)
	}
	parsed := parseTask(t)
	return &parsed, nil
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

func (a *api) updateTask(o updateOptions) (*task, error) {
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
	t, err := a.svc.Tasks.Patch(o.tasklistID, o.taskID, patch).Context(a.ctx).Do()
	if err != nil {
		return nil, a.notFoundOr("Task", o.taskID, "Failed to update task", err)
	}
	parsed := parseTask(t)
	return &parsed, nil
}

func (a *api) deleteTask(tasklistID, taskID string) error {
	if err := a.svc.Tasks.Delete(tasklistID, taskID).Context(a.ctx).Do(); err != nil {
		return a.notFoundOr("Task", taskID, "Failed to delete task", err)
	}
	return nil
}

func (a *api) clearCompleted(tasklistID string) error {
	if err := a.svc.Tasks.Clear(tasklistID).Context(a.ctx).Do(); err != nil {
		return a.notFoundOr("Task list", tasklistID, "Failed to clear completed tasks", err)
	}
	return nil
}

func (a *api) moveTask(tasklistID, taskID, parent, previous string) (*task, error) {
	call := a.svc.Tasks.Move(tasklistID, taskID).Context(a.ctx)
	if parent != "" {
		call.Parent(parent)
	}
	if previous != "" {
		call.Previous(previous)
	}
	t, err := call.Do()
	if err != nil {
		return nil, a.notFoundOr("Task", taskID, "Failed to move task", err)
	}
	parsed := parseTask(t)
	return &parsed, nil
}

// normalizeDue is Bun normalizeDue: a date without "T" is midnight UTC.
func normalizeDue(due string) string {
	if strings.Contains(due, "T") {
		return due
	}
	return due + "T00:00:00.000Z"
}

func parseTaskList(tl *tasks.TaskList) taskList {
	return taskList{ID: tl.Id, Title: tl.Title, Updated: tl.Updated, SelfLink: tl.SelfLink}
}

func parseTask(t *tasks.Task) task {
	out := task{
		ID: t.Id, Title: t.Title, Status: t.Status, Notes: t.Notes, Due: t.Due,
		Parent: t.Parent, Position: t.Position, Updated: t.Updated, SelfLink: t.SelfLink,
		WebViewLink: t.WebViewLink, Hidden: t.Hidden, Deleted: t.Deleted,
	}
	if out.Status == "" {
		out.Status = "needsAction"
	}
	if t.Completed != nil {
		out.Completed = *t.Completed
	}
	return out
}
