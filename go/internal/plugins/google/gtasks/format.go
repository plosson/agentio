package gtasks

import (
	"fmt"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
)

// formatTaskLists is printGTasksList.
func formatTaskLists(v any) string {
	page, _ := v.(*taskListPage)
	if page == nil || len(page.TaskLists) == 0 {
		return "No task lists found"
	}
	lines := []string{fmt.Sprintf("Task Lists (%d)", len(page.TaskLists)), ""}
	for i, tl := range page.TaskLists {
		lines = append(lines, fmt.Sprintf("[%d] %s", i+1, tl.Title), "    ID: "+tl.ID)
		if tl.Updated != "" {
			lines = append(lines, "    Updated: "+tl.Updated)
		}
		lines = append(lines, "")
	}
	if page.NextPageToken != "" {
		lines = append(lines, "(more results available)")
	}
	return strings.Join(lines, "\n")
}

// formatTaskListCreated is printGTaskListCreated.
func formatTaskListCreated(v any) string {
	tl, _ := v.(*taskList)
	if tl == nil {
		return ""
	}
	return strings.Join([]string{"Task list created", "ID: " + tl.ID, "Title: " + tl.Title}, "\n")
}

// formatTaskListDeleted is printGTaskListDeleted.
func formatTaskListDeleted(v any) string {
	ref, _ := v.(taskListRef)
	return "Task list deleted\nID: " + ref.TasklistID
}

// formatTasks is printGTasks.
func formatTasks(v any) string {
	page, _ := v.(*taskPage)
	if page == nil || len(page.Tasks) == 0 {
		return "No tasks found"
	}
	lines := []string{fmt.Sprintf("Tasks (%d)", len(page.Tasks)), ""}
	for i, t := range page.Tasks {
		icon := "[ ]"
		if t.Status == "completed" {
			icon = "[x]"
		}
		due := ""
		if t.Due != "" {
			due = " (due: " + strings.SplitN(t.Due, "T", 2)[0] + ")"
		}
		lines = append(lines, fmt.Sprintf("[%d] %s %s%s", i+1, icon, t.Title, due), "    ID: "+t.ID, "    Status: "+t.Status)
		if t.Notes != "" {
			lines = append(lines, "    > "+jsvalue.Truncate(t.Notes, 60))
		}
		lines = append(lines, "")
	}
	if page.NextPageToken != "" {
		lines = append(lines, "(more results available)")
	}
	return strings.Join(lines, "\n")
}

// formatTask is printGTask.
func formatTask(v any) string {
	t, _ := v.(*task)
	if t == nil {
		return ""
	}
	lines := []string{"ID: " + t.ID, "Title: " + t.Title, "Status: " + t.Status}
	for _, f := range []struct{ label, value string }{
		{"Due", t.Due}, {"Completed", t.Completed}, {"Updated", t.Updated}, {"Parent", t.Parent}, {"Link", t.WebViewLink},
	} {
		if f.value != "" {
			lines = append(lines, f.label+": "+f.value)
		}
	}
	if t.Notes != "" {
		lines = append(lines, "---", t.Notes)
	}
	return strings.Join(lines, "\n")
}

// formatTaskCreated is printGTaskCreated.
func formatTaskCreated(v any) string {
	t, _ := v.(*task)
	if t == nil {
		return ""
	}
	lines := []string{"Task created", "ID: " + t.ID, "Title: " + t.Title, "Status: " + t.Status}
	if t.Due != "" {
		lines = append(lines, "Due: "+t.Due)
	}
	if t.WebViewLink != "" {
		lines = append(lines, "Link: "+t.WebViewLink)
	}
	return strings.Join(lines, "\n")
}

// formatStatusChange is the done/undo command's three console.log lines.
func formatStatusChange(verb string) func(any) string {
	return func(v any) string {
		t, _ := v.(*task)
		if t == nil {
			return ""
		}
		return strings.Join([]string{"Task " + verb + ": " + t.Title, "ID: " + t.ID, "Status: " + t.Status}, "\n")
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
func formatMoved(v any) string {
	t, _ := v.(*task)
	if t == nil {
		return ""
	}
	lines := []string{"Task moved: " + t.Title, "ID: " + t.ID}
	if t.Parent != "" {
		lines = append(lines, "Parent: "+t.Parent)
	}
	return strings.Join(lines, "\n")
}
