package gchat

import (
	"fmt"
	"strings"

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

func from(s *sender) string {
	if s.Email != "" {
		return fmt.Sprintf("%s <%s>", s.DisplayName, s.Email)
	}
	if s.DisplayName == "" {
		return "Unknown"
	}
	return s.DisplayName
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
	s, _ := v.(shown[[]message])
	if s.JSON {
		return asJSON(s.Value)
	}
	if len(s.Value) == 0 {
		return "No messages found"
	}
	lines := []string{fmt.Sprintf("Messages (%d)", len(s.Value)), ""}
	for i, m := range s.Value {
		lines = append(lines, fmt.Sprintf("[%d] %s", i+1, m.Name))
		if m.Sender != nil {
			lines = append(lines, "    From: "+from(m.Sender))
		}
		if m.Text != "" {
			lines = append(lines, "    > "+google.Truncate(m.Text, 100))
		}
		lines = append(lines, "    Date: "+m.CreateTime, "")
	}
	return strings.Join(lines, "\n")
}

// formatMessage is printGChatMessage, or the JSON object.
func formatMessage(v any) string {
	s, _ := v.(shown[*message])
	if s.Value == nil {
		return ""
	}
	if s.JSON {
		return asJSON(s.Value)
	}
	m := s.Value
	lines := []string{"ID: " + m.Name}
	if m.Sender != nil {
		lines = append(lines, "From: "+from(m.Sender))
	}
	lines = append(lines, "Date: "+m.CreateTime)
	if m.Thread != nil {
		lines = append(lines, "Thread: "+m.Thread.Name)
	}
	if m.Text != "" {
		lines = append(lines, "---", m.Text)
	}
	return strings.Join(lines, "\n")
}

// formatSpaces is printGChatSpaceList.
func formatSpaces(v any) string {
	spaces, _ := v.([]space)
	if len(spaces) == 0 {
		return "No spaces found"
	}
	lines := []string{fmt.Sprintf("Spaces (%d)", len(spaces)), ""}
	for _, s := range spaces {
		name := s.DisplayName
		if name == "" {
			name = "Unnamed"
		}
		desc := ""
		if s.Description != "" {
			desc = "  - " + s.Description
		}
		lines = append(lines, fmt.Sprintf("[%s] %s  %s%s", s.Type, strings.Replace(s.Name, "spaces/", "", 1), name, desc))
	}
	return strings.Join(lines, "\n")
}

func orgLine(o organization) string {
	var parts []string
	for _, p := range []string{o.Title, o.Department, o.Name} {
		if p != "" {
			parts = append(parts, p)
		}
	}
	return strings.Join(parts, " · ")
}

// formatMembers is printGChatMemberList.
func formatMembers(v any) string {
	members, _ := v.([]member)
	if len(members) == 0 {
		return "No members found"
	}
	lines := []string{fmt.Sprintf("Members (%d)", len(members)), ""}
	for i, m := range members {
		label, email := "(unknown)", ""
		if m.User != nil {
			if m.User.DisplayName != "" {
				label = m.User.DisplayName
			} else if m.User.Name != "" {
				label = m.User.Name
			}
			if m.User.Email != "" {
				email = " <" + m.User.Email + ">"
			}
		}
		tags := ""
		if m.Role == "ROLE_MANAGER" {
			tags += " [MANAGER]"
		}
		if m.MemberType == "BOT" {
			tags += " [BOT]"
		}
		if m.State != "JOINED" {
			tags += " [" + m.State + "]"
		}
		lines = append(lines, fmt.Sprintf("[%d] %s%s%s", i+1, label, email, tags))
		if m.User != nil && m.User.Name != "" {
			lines = append(lines, "    User ID: "+m.User.Name)
		}
		if m.User != nil && len(m.User.Organizations) > 0 {
			if line := orgLine(m.User.Organizations[0]); line != "" {
				lines = append(lines, "    "+line)
			}
		}
	}
	return strings.Join(lines, "\n")
}

// formatUser is printGChatUser.
func formatUser(v any) string {
	u, _ := v.(*user)
	if u == nil {
		return ""
	}
	lines := []string{"ID: " + u.Name}
	if u.DisplayName != "" {
		lines = append(lines, "Name: "+u.DisplayName)
	}
	if u.Email != "" {
		lines = append(lines, "Email: "+u.Email)
	}
	if len(u.PhoneNumbers) > 0 {
		lines = append(lines, "Phone: "+strings.Join(u.PhoneNumbers, ", "))
	}
	if len(u.Organizations) > 0 {
		lines = append(lines, "Organizations:")
		for _, o := range u.Organizations {
			if line := orgLine(o); line != "" {
				lines = append(lines, "  - "+line)
			}
		}
	}
	if len(u.Locations) > 0 {
		lines = append(lines, "Location: "+strings.Join(u.Locations, ", "))
	}
	if u.PhotoURL != "" {
		lines = append(lines, "Photo: "+u.PhotoURL)
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
