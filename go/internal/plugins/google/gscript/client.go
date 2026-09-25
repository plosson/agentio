package gscript

import (
	"context"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/google"
	drive "google.golang.org/api/drive/v3"
	script "google.golang.org/api/script/v1"
)

const (
	scriptMimeType = "application/vnd.google-apps.script"
	editorURL      = "https://script.google.com/d/"
)

// file is GScriptFile: a bare name (no extension) and its API type.
type file struct {
	Name   string
	Type   string
	Source string
}

// pulledFile and pulled are GScriptPullResult.
type pulledFile struct {
	LocalPath string `json:"localPath"`
	Type      string `json:"type"`
}

type pulled struct {
	RootDir  string       `json:"rootDir"`
	ScriptID string       `json:"scriptId"`
	Files    []pulledFile `json:"files"`
}

// pushedFile and pushed are GScriptPushResult (push and put).
type pushedFile struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

type pushed struct {
	ScriptID string       `json:"scriptId"`
	Files    []pushedFile `json:"files"`
}

func toPushed(scriptID string, files []file) *pushed {
	out := &pushed{ScriptID: scriptID, Files: []pushedFile{}}
	for _, f := range files {
		out.Files = append(out.Files, pushedFile{Name: f.Name, Type: f.Type})
	}
	return out
}

// api is GScriptClient: projects through script/v1, listing and deletion
// through drive/v3.
type api struct {
	google.API
	script *script.Service
	drive  *drive.Service
}

func apiFrom(ctx context.Context, run *plugins.RunContext) (*api, error) {
	driveSvc, err := google.DriveService(ctx, run)
	if err != nil {
		return nil, err
	}
	scriptSvc, err := google.NewService(ctx, run, google.Camel, script.NewService)
	if err != nil {
		return nil, err
	}
	return &api{API: google.API{Ctx: ctx, RunContext: run, ErrorMessage: errorMessage}, script: scriptSvc, drive: driveSvc}, nil
}

// errorMessage is GScriptClient.getErrorMessage.
var errorMessage = google.StatusText("Insufficient permissions for this script project", "Script project not found")

// The project and list objects are the Bun client's (GScriptProject,
// GScriptListItem), built from the answer as JavaScript reads it
// (google.Answer): a missing scriptId or id is undefined, and a null item or
// answer fails with Bun's TypeError. Content files keep Bun's fallbacks
// (name "", type SERVER_JS, source "") as strings.

// Bun's transpiler inlines `response` into the expression a TypeError names
// when the answer of these calls is null.
const (
	listFilesExpr = "(await this.drive.files.list({\n        pageSize: Math.min(limit, 100),\n        q,\n" +
		"        fields: \"files(id,name,parents,modifiedTime)\",\n        orderBy: \"modifiedTime desc\"\n      })).data"
	getContentExpr    = "(await this.script.projects.getContent({ scriptId })).data"
	updateContentExpr = "(await this.script.projects.updateContent({\n        scriptId,\n        requestBody: {\n" +
		"          files: files.map((f) => ({ name: f.name, type: f.type, source: f.source }))\n        }\n      })).data"
)

// create sends Bun's { title, parentId }: a nil parentID is left out, a given
// "" is sent.
func (a *api) create(title string, parentID *string) (*jsvalue.Object, error) {
	req := &script.CreateProjectRequest{Title: title, ForceSendFields: []string{"Title"}}
	if parentID != nil {
		req.ParentId = *parentID
		req.ForceSendFields = append(req.ForceSendFields, "ParentId")
	}
	return projectAnswer(a, a.script.Projects.Create(req), "create script project")
}

func (a *api) metadata(scriptID string) (*jsvalue.Object, error) {
	return projectAnswer(a, a.script.Projects.Get(scriptID), "get script project metadata")
}

// projectAnswer is `return this.toProject(response.data)` inside the
// client's try: either failure is thrown as "Failed to <operation>".
func projectAnswer[C google.Call[C, *script.Project]](a *api, call C, operation string) (*jsvalue.Object, error) {
	_, raw, err := google.Answer(a.Ctx, call)
	if err == nil {
		var p *jsvalue.Object
		if p, err = toProject(raw); err == nil {
			return p, nil
		}
	}
	return nil, a.Failed(operation, err)
}

// list is the most recently modified non-trashed script files, those under
// parentID when it is set, pageSize Math.min(limit, 100).
func (a *api) list(parentID string, limit float64) ([]any, error) {
	q := "mimeType='" + scriptMimeType + "' and trashed=false"
	if parentID != "" {
		q += " and '" + parentID + "' in parents"
	}
	_, raw, err := google.Answer(a.Ctx, a.drive.Files.List().Q(q).Fields("files(id,name,parents,modifiedTime)").
		OrderBy("modifiedTime desc"), google.PageSize(limit))
	var files []any
	if err == nil {
		files, err = google.AnswerItems(raw, listFilesExpr, "files")
	}
	out := []any{}
	for _, f := range files {
		if err != nil {
			break
		}
		if jsvalue.Nullish(f) {
			err = jsvalue.TypeError(f, "file.id")
			break
		}
		get := func(k string) any { return jsvalue.Member(f, k) }
		out = append(out, jsvalue.ObjectOf(
			"scriptId", get("id"),
			"title", jsvalue.Or(get("name"), "Untitled"),
			"parentId", jsvalue.Optional(get("parents"), "0"),
			"modifiedTime", jsvalue.Or(get("modifiedTime"), jsvalue.Undefined),
		))
	}
	if err != nil {
		return nil, a.Failed("list script projects", err)
	}
	return out, nil
}

func (a *api) delete(scriptID string) error {
	if err := a.drive.Files.Delete(scriptID).Context(a.Ctx).Do(); err != nil {
		return a.Failed("delete script project", err)
	}
	return nil
}

func (a *api) getContent(scriptID string) ([]file, error) {
	_, raw, err := google.Answer(a.Ctx, a.script.Projects.GetContent(scriptID))
	var files []file
	if err == nil {
		files, err = toFiles(raw, getContentExpr)
	}
	if err != nil {
		return nil, a.Failed("get script content", err)
	}
	return files, nil
}

// updateContent sends each file as { name, type, source }, an empty source
// included.
func (a *api) updateContent(scriptID string, files []file) ([]file, error) {
	body := &script.Content{Files: []*script.File{}}
	for _, f := range files {
		body.Files = append(body.Files, &script.File{Name: f.Name, Type: f.Type, Source: f.Source, ForceSendFields: []string{"Name", "Type", "Source"}})
	}
	_, raw, err := google.Answer(a.Ctx, a.script.Projects.UpdateContent(scriptID, body))
	var out []file
	if err == nil {
		out, err = toFiles(raw, updateContentExpr)
	}
	if err != nil {
		return nil, a.Failed("update script content", err)
	}
	return out, nil
}

// toFiles is `(<expr>.files || []).map(...)`: a missing name and source are
// "", a missing type SERVER_JS, and a null file is Bun's TypeError.
func toFiles(raw any, expr string) ([]file, error) {
	items, err := google.AnswerItems(raw, expr, "files")
	if err != nil {
		return nil, err
	}
	out := []file{}
	for _, f := range items {
		if jsvalue.Nullish(f) {
			return nil, jsvalue.TypeError(f, "f.name")
		}
		get := func(k string) any { return jsvalue.Member(f, k) }
		out = append(out, file{
			Name:   jsvalue.String(jsvalue.Or(get("name"), "")),
			Type:   jsvalue.String(jsvalue.Or(get("type"), "SERVER_JS")),
			Source: jsvalue.String(jsvalue.Or(get("source"), "")),
		})
	}
	return out, nil
}

// toProject is Bun toProject(data).
func toProject(data any) (*jsvalue.Object, error) {
	if jsvalue.Nullish(data) {
		return nil, jsvalue.TypeError(data, "data.scriptId")
	}
	get := func(k string) any { return jsvalue.Member(data, k) }
	scriptID := get("scriptId")
	return jsvalue.ObjectOf(
		"scriptId", scriptID,
		"title", jsvalue.Or(get("title"), "Untitled"),
		"parentId", jsvalue.Or(get("parentId"), jsvalue.Undefined),
		"createTime", jsvalue.Or(get("createTime"), jsvalue.Undefined),
		"updateTime", jsvalue.Or(get("updateTime"), jsvalue.Undefined),
		"creator", jsvalue.Or(jsvalue.Optional(get("creator"), "email"), jsvalue.Undefined),
		"lastModifyUser", jsvalue.Or(jsvalue.Optional(get("lastModifyUser"), "email"), jsvalue.Undefined),
		"url", editorURL+jsvalue.String(scriptID)+"/edit",
	), nil
}
