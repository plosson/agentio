package gdrive

import (
	"fmt"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins/google"
)

// shortMimeTypes is getShortMimeType's table.
var shortMimeTypes = map[string]string{
	"application/vnd.google-apps.folder":       "folder",
	"application/vnd.google-apps.document":     "gdoc",
	"application/vnd.google-apps.spreadsheet":  "gsheet",
	"application/vnd.google-apps.presentation": "gslide",
	"application/pdf":                          "pdf",
	"image/png":                                "png",
	"image/jpeg":                               "jpg",
	"text/plain":                               "txt",
	"application/zip":                          "zip",
}

func shortMimeType(mimeType string) string {
	if s, ok := shortMimeTypes[mimeType]; ok {
		return s
	}
	for _, prefix := range []string{"image", "video", "audio", "text"} {
		if strings.HasPrefix(mimeType, prefix+"/") {
			return prefix
		}
	}
	return "file"
}

// formatFileList is printGDriveFileList.
func formatFileList(v any) string {
	l, _ := v.(fileList)
	if len(l.Files) == 0 {
		return "No files found"
	}
	lines := []string{fmt.Sprintf("%s (%d)", l.Title, len(l.Files)), ""}
	for _, f := range l.Files {
		size := "       -"
		if f.Size != 0 {
			size = fmt.Sprintf("%8s", google.FormatBytes(f.Size))
		}
		date := "          "
		if f.ModifiedTime != "" {
			date = jsvalue.Slice(f.ModifiedTime, 10)
		}
		flags := ""
		if f.Starred {
			flags += "*"
		}
		if f.Shared {
			flags += "⇄"
		}
		name := f.Name
		if f.MimeType == folderMimeType {
			name += "/"
		}
		lines = append(lines, fmt.Sprintf("%-7s %s  %s  %-2s %s", shortMimeType(f.MimeType), size, date, flags, name), "  "+f.ID)
	}
	return strings.Join(lines, "\n")
}

func yesNo(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}

// formatFile is printGDriveFile.
func formatFile(v any) string {
	f, _ := v.(*file)
	if f == nil {
		return ""
	}
	lines := []string{"ID: " + f.ID, "Name: " + f.Name, "Type: " + f.MimeType}
	if f.Size != 0 {
		lines = append(lines, "Size: "+google.FormatBytes(f.Size))
	}
	if f.Description != "" {
		lines = append(lines, "Description: "+f.Description)
	}
	if len(f.Owners) > 0 {
		lines = append(lines, "Owners: "+strings.Join(f.Owners, ", "))
	}
	if len(f.Parents) > 0 {
		lines = append(lines, "Parents: "+strings.Join(f.Parents, ", "))
	}
	lines = append(lines, "Starred: "+yesNo(f.Starred), "Shared: "+yesNo(f.Shared), "Trashed: "+yesNo(f.Trashed))
	if f.CreatedTime != "" {
		lines = append(lines, "Created: "+f.CreatedTime)
	}
	if f.ModifiedTime != "" {
		lines = append(lines, "Modified: "+f.ModifiedTime)
	}
	if f.WebViewLink != "" {
		lines = append(lines, "View: "+f.WebViewLink)
	}
	if f.WebContentLink != "" {
		lines = append(lines, "Download: "+f.WebContentLink)
	}
	return strings.Join(lines, "\n")
}

// formatDownloaded is printGDriveDownloaded.
func formatDownloaded(v any) string {
	d, _ := v.(*downloaded)
	if d == nil {
		return ""
	}
	return strings.Join([]string{
		"Downloaded: " + d.Filename, "  Path: " + d.Path, "  Size: " + google.FormatBytes(d.Size), "  Type: " + d.MimeType,
	}, "\n")
}

// formatUploaded is printGDriveUploaded, then printGDriveShared for --public.
func formatUploaded(v any) string {
	u, _ := v.(*uploaded)
	if u == nil {
		return ""
	}
	lines := []string{"Uploaded: " + u.Name, "  ID: " + u.ID, "  Size: " + google.FormatBytes(u.Size), "  Type: " + u.MimeType}
	if u.WebViewLink != "" {
		lines = append(lines, "  Link: "+u.WebViewLink)
	}
	if u.Share != nil {
		lines = append(lines, formatShared(u.Share))
	}
	return strings.Join(lines, "\n")
}

// formatCopied is printGDriveCopied.
func formatCopied(v any) string {
	c, _ := v.(*copied)
	if c == nil {
		return ""
	}
	lines := []string{"Copied: " + c.Name, "  ID: " + c.ID, "  Type: " + c.MimeType}
	if len(c.Parents) > 0 {
		lines = append(lines, "  Folder: "+c.Parents[0])
	}
	if c.WebViewLink != "" {
		lines = append(lines, "  Link: "+c.WebViewLink)
	}
	return strings.Join(lines, "\n")
}

// formatShared is printGDriveShared.
func formatShared(v any) string {
	s, _ := v.(*shared)
	if s == nil {
		return ""
	}
	lines := []string{"Permission created", "  Permission ID: " + s.PermissionID, "  Type: " + s.Type, "  Role: " + s.Role}
	if s.EmailAddress != "" {
		lines = append(lines, "  Email: "+s.EmailAddress)
	}
	if s.Domain != "" {
		lines = append(lines, "  Domain: "+s.Domain)
	}
	if s.Type == "anyone" {
		lines = append(lines, "  Public URL: https://drive.google.com/uc?id="+s.FileID)
	}
	return strings.Join(lines, "\n")
}

// formatPermissions is printGDrivePermissions.
func formatPermissions(v any) string {
	perms, _ := v.([]permission)
	if len(perms) == 0 {
		return "No permissions found"
	}
	lines := []string{fmt.Sprintf("Permissions (%d)", len(perms)), ""}
	for _, p := range perms {
		target := p.EmailAddress
		if target == "" {
			target = p.Domain
		}
		if target == "" {
			target = p.Type
		}
		discovery := ""
		if p.Type == "anyone" && p.AllowFileDiscovery {
			discovery = " (discoverable)"
		}
		lines = append(lines, fmt.Sprintf("  %-10s %s%s", p.Role, target, discovery), "    ID: "+p.ID)
		if p.DisplayName != "" {
			lines = append(lines, "    Name: "+p.DisplayName)
		}
	}
	return strings.Join(lines, "\n")
}

// fileLine is the one-line report of mkdir, rename and trash.
func fileLine(prefix string) func(any) string {
	return func(v any) string {
		f, _ := v.(*file)
		if f == nil {
			return ""
		}
		return prefix + f.Name + " (" + f.ID + ")"
	}
}

// formatCreatedFolder is the mkdir report.
func formatCreatedFolder(v any) string {
	f, _ := v.(*file)
	if f == nil {
		return ""
	}
	out := fileLine("Created folder: ")(f)
	if f.WebViewLink != "" {
		out += "\n  Link: " + f.WebViewLink
	}
	return out
}

// formatMoved is the move report.
func formatMoved(v any) string {
	f, _ := v.(*file)
	if f == nil {
		return ""
	}
	out := fileLine("Moved: ")(f)
	if len(f.Parents) > 0 {
		out += "\n  Folder: " + f.Parents[0]
	}
	return out
}

func formatUnshared(v any) string {
	u, _ := v.(unshared)
	return "Permission " + u.PermissionID + " removed"
}
