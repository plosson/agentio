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

// The printers read the Bun objects the client builds (see parseFile), as
// Bun's template strings do: a missing field prints "undefined".

// padStart is s.padStart(n) for the ASCII formatBytes text.
func padStart(s string, n int) string {
	if len(s) < n {
		return strings.Repeat(" ", n-len(s)) + s
	}
	return s
}

// joined is `a.join(', ')` for an array read from the answer.
func joined(v any) string {
	items, _ := v.([]any)
	return jsvalue.Join(items, ", ")
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
		if google.Truthy(f, "size") {
			size = padStart(google.FormatBytes(jsvalue.Member(f, "size")), 8)
		}
		date := "          "
		if google.Truthy(f, "modifiedTime") {
			date = jsvalue.Slice(google.Field(f, "modifiedTime"), 10)
		}
		flags := ""
		if google.Truthy(f, "starred") {
			flags += "*"
		}
		if google.Truthy(f, "shared") {
			flags += "⇄"
		}
		name := google.Field(f, "name")
		if jsvalue.StrictEqual(jsvalue.Member(f, "mimeType"), folderMimeType) {
			name += "/"
		}
		lines = append(lines, jsvalue.PadEnd(shortMimeType(google.Field(f, "mimeType")), 7)+" "+size+"  "+date+"  "+jsvalue.PadEnd(flags, 2)+" "+name,
			"  "+google.Field(f, "id"))
	}
	return strings.Join(lines, "\n")
}

func yesNo(o any, key string) string {
	if google.Truthy(o, key) {
		return "yes"
	}
	return "no"
}

// formatFile is printGDriveFile.
func formatFile(f any) string {
	lines := []string{"ID: " + google.Field(f, "id"), "Name: " + google.Field(f, "name"), "Type: " + google.Field(f, "mimeType")}
	if google.Truthy(f, "size") {
		lines = append(lines, "Size: "+google.FormatBytes(jsvalue.Member(f, "size")))
	}
	if google.Truthy(f, "description") {
		lines = append(lines, "Description: "+google.Field(f, "description"))
	}
	if owners := jsvalue.Member(f, "owners"); google.Truthy(owners, "length") {
		lines = append(lines, "Owners: "+joined(owners))
	}
	if parents := jsvalue.Member(f, "parents"); google.Truthy(parents, "length") {
		lines = append(lines, "Parents: "+joined(parents))
	}
	lines = append(lines, "Starred: "+yesNo(f, "starred"), "Shared: "+yesNo(f, "shared"), "Trashed: "+yesNo(f, "trashed"))
	for _, x := range []struct{ label, key string }{
		{"Created", "createdTime"}, {"Modified", "modifiedTime"}, {"View", "webViewLink"}, {"Download", "webContentLink"},
	} {
		if google.Truthy(f, x.key) {
			lines = append(lines, x.label+": "+google.Field(f, x.key))
		}
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
		"Downloaded: " + jsvalue.String(d.Filename), "  Path: " + d.Path, "  Size: " + google.FormatBytes(d.Size), "  Type: " + jsvalue.String(d.MimeType),
	}, "\n")
}

// formatUploaded is printGDriveUploaded, then printGDriveShared for --public
// (the "share" member put's Run adds).
func formatUploaded(u any) string {
	lines := []string{"Uploaded: " + google.Field(u, "name"), "  ID: " + google.Field(u, "id"), "  Size: " + google.FormatBytes(jsvalue.Member(u, "size")), "  Type: " + google.Field(u, "mimeType")}
	if google.Truthy(u, "webViewLink") {
		lines = append(lines, "  Link: "+google.Field(u, "webViewLink"))
	}
	if share, ok := jsvalue.Member(u, "share").(*jsvalue.Object); ok {
		lines = append(lines, formatShared(&shared{Result: share, FileID: google.Field(u, "id")}))
	}
	return strings.Join(lines, "\n")
}

// formatCopied is printGDriveCopied.
func formatCopied(c any) string {
	lines := []string{"Copied: " + google.Field(c, "name"), "  ID: " + google.Field(c, "id"), "  Type: " + google.Field(c, "mimeType")}
	if parents := jsvalue.Member(c, "parents"); jsvalue.Truthy(parents) && google.Truthy(parents, "length") {
		lines = append(lines, "  Folder: "+jsvalue.String(jsvalue.Member(parents, "0")))
	}
	if google.Truthy(c, "webViewLink") {
		lines = append(lines, "  Link: "+google.Field(c, "webViewLink"))
	}
	return strings.Join(lines, "\n")
}

// formatShared is printGDriveShared.
func formatShared(v any) string {
	s, _ := v.(*shared)
	if s == nil {
		return ""
	}
	r := s.Result
	lines := []string{"Permission created", "  Permission ID: " + google.Field(r, "permissionId"), "  Type: " + google.Field(r, "type"), "  Role: " + google.Field(r, "role")}
	if google.Truthy(r, "emailAddress") {
		lines = append(lines, "  Email: "+google.Field(r, "emailAddress"))
	}
	if google.Truthy(r, "domain") {
		lines = append(lines, "  Domain: "+google.Field(r, "domain"))
	}
	if jsvalue.StrictEqual(jsvalue.Member(r, "type"), "anyone") {
		lines = append(lines, "  Public URL: https://drive.google.com/uc?id="+s.FileID)
	}
	return strings.Join(lines, "\n")
}

// formatPermissions is printGDrivePermissions. It stops, as Bun's
// console.log lines do, at the first permission without a role
// (permissionsError).
func formatPermissions(v any) string {
	perms, _ := v.([]any)
	if len(perms) == 0 {
		return "No permissions found"
	}
	lines := []string{fmt.Sprintf("Permissions (%d)", len(perms)), ""}
	for _, p := range perms {
		if jsvalue.Nullish(jsvalue.Member(p, "role")) {
			break
		}
		target := jsvalue.Or(jsvalue.Or(jsvalue.Member(p, "emailAddress"), jsvalue.Member(p, "domain")), jsvalue.Member(p, "type"))
		discovery := ""
		if jsvalue.StrictEqual(jsvalue.Member(p, "type"), "anyone") && google.Truthy(p, "allowFileDiscovery") {
			discovery = " (discoverable)"
		}
		lines = append(lines, "  "+jsvalue.PadEnd(google.Field(p, "role"), 10)+" "+jsvalue.String(target)+discovery, "    ID: "+google.Field(p, "id"))
		if google.Truthy(p, "displayName") {
			lines = append(lines, "    Name: "+google.Field(p, "displayName"))
		}
	}
	return strings.Join(lines, "\n")
}

// permissionsError is the TypeError printGDrivePermissions throws at the
// first permission whose role is null or undefined.
func permissionsError(perms []any) error {
	for _, p := range perms {
		if role := jsvalue.Member(p, "role"); jsvalue.Nullish(role) {
			return jsvalue.TypeError(role, "p.role.padEnd")
		}
	}
	return nil
}

// fileLine is the one-line report of mkdir, rename and trash.
func fileLine(prefix string) func(any) string {
	return func(f any) string {
		return prefix + google.Field(f, "name") + " (" + google.Field(f, "id") + ")"
	}
}

// formatCreatedFolder is the mkdir report.
func formatCreatedFolder(f any) string {
	out := fileLine("Created folder: ")(f)
	if google.Truthy(f, "webViewLink") {
		out += "\n  Link: " + google.Field(f, "webViewLink")
	}
	return out
}

// formatMoved is the move report.
func formatMoved(f any) string {
	out := fileLine("Moved: ")(f)
	if parents := jsvalue.Member(f, "parents"); jsvalue.Truthy(parents) && google.Truthy(parents, "length") {
		out += "\n  Folder: " + jsvalue.String(jsvalue.Member(parents, "0"))
	}
	return out
}

func formatUnshared(v any) string {
	u, _ := v.(unshared)
	return "Permission " + u.PermissionID + " removed"
}
