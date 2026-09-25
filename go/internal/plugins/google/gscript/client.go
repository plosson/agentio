package gscript

import (
	"context"

	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/google"
	drive "google.golang.org/api/drive/v3"
	script "google.golang.org/api/script/v1"
)

const (
	scriptMimeType = "application/vnd.google-apps.script"
	editorURL      = "https://script.google.com/d/"
)

// project is GScriptProject: the optional fields are absent when the API
// omits them.
type project struct {
	ScriptID       string `json:"scriptId"`
	Title          string `json:"title"`
	ParentID       string `json:"parentId,omitempty"`
	CreateTime     string `json:"createTime,omitempty"`
	UpdateTime     string `json:"updateTime,omitempty"`
	Creator        string `json:"creator,omitempty"`
	LastModifyUser string `json:"lastModifyUser,omitempty"`
	URL            string `json:"url"`
}

// listItem is GScriptListItem.
type listItem struct {
	ScriptID     string `json:"scriptId"`
	Title        string `json:"title"`
	ParentID     string `json:"parentId,omitempty"`
	ModifiedTime string `json:"modifiedTime,omitempty"`
}

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

// create sends Bun's { title, parentId }: a nil parentID is left out, a given
// "" is sent.
func (a *api) create(title string, parentID *string) (*project, error) {
	req := &script.CreateProjectRequest{Title: title, ForceSendFields: []string{"Title"}}
	if parentID != nil {
		req.ParentId = *parentID
		req.ForceSendFields = append(req.ForceSendFields, "ParentId")
	}
	resp, err := a.script.Projects.Create(req).Context(a.Ctx).Do()
	if err != nil {
		return nil, a.Failed("create script project", err)
	}
	return toProject(resp), nil
}

func (a *api) metadata(scriptID string) (*project, error) {
	resp, err := a.script.Projects.Get(scriptID).Context(a.Ctx).Do()
	if err != nil {
		return nil, a.Failed("get script project metadata", err)
	}
	return toProject(resp), nil
}

// list is the most recently modified non-trashed script files, those under
// parentID when it is set, pageSize Math.min(limit, 100).
func (a *api) list(parentID string, limit float64) ([]listItem, error) {
	q := "mimeType='" + scriptMimeType + "' and trashed=false"
	if parentID != "" {
		q += " and '" + parentID + "' in parents"
	}
	resp, err := a.drive.Files.List().Q(q).Fields("files(id,name,parents,modifiedTime)").
		OrderBy("modifiedTime desc").Context(a.Ctx).Do(google.PageSize(limit))
	if err != nil {
		return nil, a.Failed("list script projects", err)
	}
	out := []listItem{}
	for _, f := range resp.Files {
		item := listItem{ScriptID: f.Id, Title: f.Name, ModifiedTime: f.ModifiedTime}
		if item.Title == "" {
			item.Title = "Untitled"
		}
		if len(f.Parents) > 0 {
			item.ParentID = f.Parents[0]
		}
		out = append(out, item)
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
	resp, err := a.script.Projects.GetContent(scriptID).Context(a.Ctx).Do()
	if err != nil {
		return nil, a.Failed("get script content", err)
	}
	return toFiles(resp.Files), nil
}

// updateContent sends each file as { name, type, source }, an empty source
// included.
func (a *api) updateContent(scriptID string, files []file) ([]file, error) {
	body := &script.Content{Files: []*script.File{}}
	for _, f := range files {
		body.Files = append(body.Files, &script.File{Name: f.Name, Type: f.Type, Source: f.Source, ForceSendFields: []string{"Name", "Type", "Source"}})
	}
	resp, err := a.script.Projects.UpdateContent(scriptID, body).Context(a.Ctx).Do()
	if err != nil {
		return nil, a.Failed("update script content", err)
	}
	return toFiles(resp.Files), nil
}

// toFiles defaults a missing name and source to "" and a missing type to SERVER_JS.
func toFiles(files []*script.File) []file {
	out := []file{}
	for _, f := range files {
		if f == nil {
			f = &script.File{}
		}
		item := file{Name: f.Name, Type: f.Type, Source: f.Source}
		if item.Type == "" {
			item.Type = "SERVER_JS"
		}
		out = append(out, item)
	}
	return out
}

func toProject(p *script.Project) *project {
	out := &project{
		ScriptID:   p.ScriptId,
		Title:      p.Title,
		ParentID:   p.ParentId,
		CreateTime: p.CreateTime,
		UpdateTime: p.UpdateTime,
		URL:        editorURL + p.ScriptId + "/edit",
	}
	if out.Title == "" {
		out.Title = "Untitled"
	}
	if p.Creator != nil {
		out.Creator = p.Creator.Email
	}
	if p.LastModifyUser != nil {
		out.LastModifyUser = p.LastModifyUser.Email
	}
	return out
}
