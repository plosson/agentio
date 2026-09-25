package gchat

import (
	"fmt"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins/google"
)

// formatSendResult is printGChatSendResult.
func formatSendResult(v any) string {
	r, _ := v.(*sendResult)
	if r == nil {
		return ""
	}
	lines := []string{"Message sent", "ID: " + r.MessageID}
	if r.SpaceID != "" {
		lines = append(lines, "Space: "+r.SpaceID)
	}
	if r.IsJSONPayload {
		lines = append(lines, "Type: JSON payload")
	}
	return strings.Join(lines, "\n")
}

// The printers read the Bun objects the client builds (messageOf, spaceOf,
// listMembers, personToUser) as Bun's template strings do.

// from is the printers' `sender.email ? \`${displayName} <${email}>\` :
// sender.displayName || 'Unknown'`.
func from(s any) string {
	if google.Truthy(s, "email") {
		return fmt.Sprintf("%s <%s>", google.Field(s, "displayName"), google.Field(s, "email"))
	}
	return jsvalue.String(jsvalue.Or(jsvalue.Member(s, "displayName"), "Unknown"))
}

// asJSON is the `--format json` rendering: JSON.stringify(value, null, 2).
func asJSON(v any) string {
	raw, err := stringify(v, "  ")
	if err != nil {
		return ""
	}
	return string(raw)
}

// formatMessageList is printGChatMessageList, or the JSON array.
func formatMessageList(v any) string {
	s, _ := v.(shown[[]any])
	if s.JSON {
		return asJSON(s.Value)
	}
	if len(s.Value) == 0 {
		return "No messages found"
	}
	lines := []string{fmt.Sprintf("Messages (%d)", len(s.Value)), ""}
	for i, m := range s.Value {
		lines = append(lines, fmt.Sprintf("[%d] %s", i+1, google.Field(m, "name")))
		if google.Truthy(m, "sender") {
			lines = append(lines, "    From: "+from(jsvalue.Member(m, "sender")))
		}
		if google.Truthy(m, "text") {
			lines = append(lines, "    > "+jsvalue.Truncate(google.Field(m, "text"), 100))
		}
		lines = append(lines, "    Date: "+google.Field(m, "createTime"), "")
	}
	return strings.Join(lines, "\n")
}

// formatMessage is printGChatMessage, or the JSON object.
func formatMessage(v any) string {
	s, _ := v.(shown[*jsvalue.Object])
	if s.Value == nil {
		return ""
	}
	if s.JSON {
		return asJSON(s.Value)
	}
	m := s.Value
	lines := []string{"ID: " + google.Field(m, "name")}
	if google.Truthy(m, "sender") {
		lines = append(lines, "From: "+from(jsvalue.Member(m, "sender")))
	}
	lines = append(lines, "Date: "+google.Field(m, "createTime"))
	if google.Truthy(m, "thread") {
		lines = append(lines, "Thread: "+google.Field(jsvalue.Member(m, "thread"), "name"))
	}
	if google.Truthy(m, "text") {
		lines = append(lines, "---", google.Field(m, "text"))
	}
	return strings.Join(lines, "\n")
}

// formatSpaces is printGChatSpaceList.
func formatSpaces(v any) string {
	spaces, _ := v.([]any)
	if len(spaces) == 0 {
		return "No spaces found"
	}
	lines := []string{fmt.Sprintf("Spaces (%d)", len(spaces)), ""}
	for _, s := range spaces {
		name := jsvalue.String(jsvalue.Or(jsvalue.Member(s, "displayName"), "Unnamed"))
		desc := ""
		if google.Truthy(s, "description") {
			desc = "  - " + google.Field(s, "description")
		}
		lines = append(lines, fmt.Sprintf("[%s] %s  %s%s", google.Field(s, "type"), strings.Replace(google.Field(s, "name"), "spaces/", "", 1), name, desc))
	}
	return strings.Join(lines, "\n")
}

// orgLine is `[org.title, org.department, org.name].filter(Boolean).join(' · ')`.
func orgLine(o any) string {
	var parts []any
	for _, k := range []string{"title", "department", "name"} {
		if v := jsvalue.Member(o, k); jsvalue.Truthy(v) {
			parts = append(parts, v)
		}
	}
	return jsvalue.Join(parts, " · ")
}

// list is a `?.length` list of an object built by the client.
func list(o any, key string) []any {
	l, _ := jsvalue.Optional(o, key).([]any)
	return l
}

// formatMembers is printGChatMemberList.
func formatMembers(v any) string {
	members, _ := v.([]any)
	if len(members) == 0 {
		return "No members found"
	}
	lines := []string{fmt.Sprintf("Members (%d)", len(members)), ""}
	for i, m := range members {
		u := jsvalue.Member(m, "user")
		label := jsvalue.String(jsvalue.Or(jsvalue.Or(jsvalue.Optional(u, "displayName"), jsvalue.Optional(u, "name")), "(unknown)"))
		email := ""
		if jsvalue.Truthy(jsvalue.Optional(u, "email")) {
			email = " <" + google.Field(u, "email") + ">"
		}
		tags := ""
		if jsvalue.StrictEqual(jsvalue.Member(m, "role"), "ROLE_MANAGER") {
			tags += " [MANAGER]"
		}
		if jsvalue.StrictEqual(jsvalue.Member(m, "memberType"), "BOT") {
			tags += " [BOT]"
		}
		if !jsvalue.StrictEqual(jsvalue.Member(m, "state"), "JOINED") {
			tags += " [" + google.Field(m, "state") + "]"
		}
		lines = append(lines, fmt.Sprintf("[%d] %s%s%s", i+1, label, email, tags))
		if jsvalue.Truthy(jsvalue.Optional(u, "name")) {
			lines = append(lines, "    User ID: "+google.Field(u, "name"))
		}
		if orgs := list(u, "organizations"); len(orgs) > 0 {
			if line := orgLine(orgs[0]); line != "" {
				lines = append(lines, "    "+line)
			}
		}
	}
	return strings.Join(lines, "\n")
}

// formatUser is printGChatUser.
func formatUser(v any) string {
	u, _ := v.(*jsvalue.Object)
	if u == nil {
		return ""
	}
	lines := []string{"ID: " + google.Field(u, "name")}
	if google.Truthy(u, "displayName") {
		lines = append(lines, "Name: "+google.Field(u, "displayName"))
	}
	if google.Truthy(u, "email") {
		lines = append(lines, "Email: "+google.Field(u, "email"))
	}
	if phones := list(u, "phoneNumbers"); len(phones) > 0 {
		lines = append(lines, "Phone: "+jsvalue.Join(phones, ", "))
	}
	if orgs := list(u, "organizations"); len(orgs) > 0 {
		lines = append(lines, "Organizations:")
		for _, o := range orgs {
			if line := orgLine(o); line != "" {
				lines = append(lines, "  - "+line)
			}
		}
	}
	if locations := list(u, "locations"); len(locations) > 0 {
		lines = append(lines, "Location: "+jsvalue.Join(locations, ", "))
	}
	if google.Truthy(u, "photoUrl") {
		lines = append(lines, "Photo: "+google.Field(u, "photoUrl"))
	}
	return strings.Join(lines, "\n")
}

// formatDirectoryRefresh is the directory refresh command's three lines.
func formatDirectoryRefresh(v any) string {
	r, _ := v.(*directoryRefresh)
	if r == nil {
		return ""
	}
	return fmt.Sprintf("Refreshed: %d users\nPath: %s\nFetched at: %s", r.Size, r.Path, r.FetchedAt)
}
