package gtasks

import (
	"fmt"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins/google"
)

// The printers read the Bun objects the client builds (see parseTask), as
// Bun's template strings do: a missing field prints "undefined".

// formatTaskLists is printGTasksList.
func formatTaskLists(v any) string {
	lists, _ := jsvalue.Member(v, "taskLists").([]any)
	if len(lists) == 0 {
		return "No task lists found"
	}
	lines := []string{fmt.Sprintf("Task Lists (%d)", len(lists)), ""}
	for i, tl := range lists {
		lines = append(lines, fmt.Sprintf("[%d] %s", i+1, google.Field(tl, "title")), "    ID: "+google.Field(tl, "id"))
		if google.Truthy(tl, "updated") {
			lines = append(lines, "    Updated: "+google.Field(tl, "updated"))
		}
		lines = append(lines, "")
	}
	if google.Truthy(v, "nextPageToken") {
		lines = append(lines, "(more results available)")
	}
	return strings.Join(lines, "\n")
}

// formatTaskListCreated is printGTaskListCreated.
func formatTaskListCreated(v any) string {
	return strings.Join([]string{"Task list created", "ID: " + google.Field(v, "id"), "Title: " + google.Field(v, "title")}, "\n")
}

// formatTaskListDeleted is printGTaskListDeleted.
func formatTaskListDeleted(v any) string {
	ref, _ := v.(taskListRef)
	return "Task list deleted\nID: " + ref.TasklistID
}

// formatTasks is printGTasks.
func formatTasks(v any) string {
	tasks, _ := jsvalue.Member(v, "tasks").([]any)
	if len(tasks) == 0 {
		return "No tasks found"
	}
	lines := []string{fmt.Sprintf("Tasks (%d)", len(tasks)), ""}
	for i, t := range tasks {
		icon := "[ ]"
		if jsvalue.StrictEqual(jsvalue.Member(t, "status"), "completed") {
			icon = "[x]"
		}
		due := ""
		if google.Truthy(t, "due") {
			due = " (due: " + strings.SplitN(google.Field(t, "due"), "T", 2)[0] + ")"
		}
		lines = append(lines, fmt.Sprintf("[%d] %s %s%s", i+1, icon, google.Field(t, "title"), due),
			"    ID: "+google.Field(t, "id"), "    Status: "+google.Field(t, "status"))
		if google.Truthy(t, "notes") {
			lines = append(lines, "    > "+jsvalue.Truncate(google.Field(t, "notes"), 60))
		}
		lines = append(lines, "")
	}
	if google.Truthy(v, "nextPageToken") {
		lines = append(lines, "(more results available)")
	}
	return strings.Join(lines, "\n")
}

// formatTask is printGTask.
func formatTask(t any) string {
	lines := []string{"ID: " + google.Field(t, "id"), "Title: " + google.Field(t, "title"), "Status: " + google.Field(t, "status")}
	for _, f := range []struct{ label, key string }{
		{"Due", "due"}, {"Completed", "completed"}, {"Updated", "updated"}, {"Parent", "parent"}, {"Link", "webViewLink"},
	} {
		if google.Truthy(t, f.key) {
			lines = append(lines, f.label+": "+google.Field(t, f.key))
		}
	}
	if google.Truthy(t, "notes") {
		lines = append(lines, "---", google.Field(t, "notes"))
	}
	return strings.Join(lines, "\n")
}

// formatTaskCreated is printGTaskCreated.
func formatTaskCreated(t any) string {
	lines := []string{"Task created", "ID: " + google.Field(t, "id"), "Title: " + google.Field(t, "title"), "Status: " + google.Field(t, "status")}
	if google.Truthy(t, "due") {
		lines = append(lines, "Due: "+google.Field(t, "due"))
	}
	if google.Truthy(t, "webViewLink") {
		lines = append(lines, "Link: "+google.Field(t, "webViewLink"))
	}
	return strings.Join(lines, "\n")
}

// formatStatusChange is the done/undo command's three console.log lines.
func formatStatusChange(verb string) func(any) string {
	return func(t any) string {
		return strings.Join([]string{"Task " + verb + ": " + google.Field(t, "title"), "ID: " + google.Field(t, "id"), "Status: " + google.Field(t, "status")}, "\n")
	}
}

// formatTaskDeleted is printGTaskDeleted.
func formatTaskDeleted(v any) string {
	ref, _ := v.(taskRef)
	return strings.Join([]string{"Task deleted", "Task List: " + ref.TasklistID, "Task ID: " + ref.TaskID}, "\n")
}

// formatCleared is printGTasksCleared.
func formatCleared(v any) string {
	ref, _ := v.(taskListRef)
	return "Completed tasks cleared\nTask List: " + ref.TasklistID
}

// formatMoved is the move command's console.log lines.
func formatMoved(t any) string {
	lines := []string{"Task moved: " + google.Field(t, "title"), "ID: " + google.Field(t, "id")}
	if google.Truthy(t, "parent") {
		lines = append(lines, "Parent: "+google.Field(t, "parent"))
	}
	return strings.Join(lines, "\n")
}
