package gscript

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/plugins/google"
)

// claspFile is the clasp project file pull writes and push reads.
const claspFile = ".clasp.json"

var (
	// extToType is EXT_TO_TYPE: the local extensions push and put map to an API type.
	extToType = map[string]string{".gs": "SERVER_JS", ".html": "HTML", ".json": "JSON"}
	// typeToExt is TYPE_TO_EXT: the extension pull writes for an API type.
	typeToExt = map[string]string{"SERVER_JS": ".gs", "HTML": ".html", "JSON": ".json"}
)

// localFilename is localFilenameForApiFile: an unknown type appends
// "undefined", as the Bun template does.
func localFilename(f file) string {
	ext, ok := typeToExt[f.Type]
	if !ok {
		ext = "undefined"
	}
	return f.Name + ext
}

// stripExt is Bun stripExt: "Code.gs" and "Code" both name "Code". A name
// with an extension loses its directory too (Node basename).
func stripExt(name string) string {
	ext := google.Extname(name)
	if ext == "" {
		return name
	}
	return strings.TrimSuffix(filepath.Base(name), ext)
}

// targetDir is Node resolve(dir || process.cwd()).
func targetDir(dir string) (string, error) {
	return filepath.Abs(dir)
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// claspScriptID is JSON.parse(readFile(path, 'utf8'))[.scriptId]: nil when
// the parsed value has no scriptId. A JSON null throws Bun's TypeError, which
// names the variable the command reads it into.
func claspScriptID(path, variable string) (any, error) {
	raw, err := google.ReadFile(path)
	if err != nil {
		return nil, err
	}
	text := []byte(jsvalue.BufferString(raw))
	parsed, err := jsvalue.Parse(text)
	if err != nil {
		return nil, errors.New(jsvalue.ParseErrorMessage(text))
	}
	switch v := parsed.(type) {
	case nil:
		return nil, errors.New("null is not an object (evaluating '" + variable + ".scriptId')")
	case *jsvalue.Object:
		id, _ := v.Get("scriptId")
		return id, nil
	}
	return nil, nil
}

// claspJSON is JSON.stringify({ scriptId, rootDir: '.' }, null, 2) + '\n'.
func claspJSON(scriptID string) []byte {
	o := jsvalue.NewObject()
	o.Set("scriptId", scriptID)
	o.Set("rootDir", ".")
	return append(jsvalue.StringifyIndent(o), '\n')
}

// preparePull is what Bun pull does before it resolves the profile: create
// the directory and refuse one whose .clasp.json names another script unless
// force is set. It returns the directory and its .clasp.json path.
func preparePull(dir, scriptID string, force bool, fail google.FailFunc) (string, string, error) {
	root, err := targetDir(dir)
	if err != nil {
		return "", "", err
	}
	if err := google.MkdirAll(root); err != nil {
		return "", "", err
	}
	claspPath := filepath.Join(root, claspFile)
	if exists(claspPath) && !force {
		existing, err := claspScriptID(claspPath, "existing")
		if err != nil {
			return "", "", err
		}
		if s, ok := existing.(string); jsvalue.Truthy(existing) && (!ok || s != scriptID) {
			return "", "", fail("INVALID_PARAMS", claspPath+" already points to scriptId "+jsvalue.String(existing),
				"Pass --force to overwrite, or pull into a different directory")
		}
	}
	return root, claspPath, nil
}

// writePull writes each file under root with its local name, then .clasp.json.
func writePull(root, claspPath, scriptID string, files []file) (*pulled, error) {
	out := &pulled{RootDir: root, ScriptID: scriptID, Files: []pulledFile{}}
	for _, f := range files {
		localPath := filepath.Join(root, localFilename(f))
		if err := os.WriteFile(localPath, []byte(f.Source), 0o666); err != nil {
			return nil, google.NodeFSError("open", localPath, err)
		}
		out.Files = append(out.Files, pulledFile{LocalPath: localPath, Type: f.Type})
	}
	if err := os.WriteFile(claspPath, claspJSON(scriptID), 0o666); err != nil {
		return nil, google.NodeFSError("open", claspPath, err)
	}
	return out, nil
}

// localProject is what Bun push reads before it resolves the profile: the
// script id (--id, else .clasp.json) and every .gs, .html and .json file of
// the directory, in directory order, hidden files skipped.
func localProject(in plugins.CommandInput, fail google.FailFunc) (string, []file, error) {
	root, err := targetDir(in.Arg("dir"))
	if err != nil {
		return "", nil, err
	}
	scriptID := in.Option("id")
	if scriptID == "" {
		claspPath := filepath.Join(root, claspFile)
		if !exists(claspPath) {
			return "", nil, fail("INVALID_PARAMS", "No .clasp.json found in "+root, "Pass --id <scriptId>, or run `agentio gscript pull` first")
		}
		id, err := claspScriptID(claspPath, "config")
		if err != nil {
			return "", nil, err
		}
		if !jsvalue.Truthy(id) {
			return "", nil, fail("INVALID_PARAMS", ".clasp.json missing scriptId field", "")
		}
		scriptID = jsvalue.String(id)
	}
	names, err := readdirNames(root)
	if err != nil {
		return "", nil, err
	}
	files := []file{}
	manifest := false
	for _, name := range names {
		if strings.HasPrefix(name, ".") {
			continue
		}
		fullPath := filepath.Join(root, name)
		info, err := os.Stat(fullPath)
		if err != nil {
			return "", nil, google.NodeFSError("stat", fullPath, err)
		}
		if !info.Mode().IsRegular() {
			continue
		}
		ext := strings.ToLower(google.Extname(name))
		typ, ok := extToType[ext]
		if !ok {
			continue
		}
		raw, err := google.ReadFile(fullPath)
		if err != nil {
			return "", nil, err
		}
		// basename(entry, ext) with the lowercased ext: "Code.GS" keeps its suffix.
		bare := strings.TrimSuffix(name, ext)
		files = append(files, file{Name: bare, Type: typ, Source: jsvalue.BufferString(raw)})
		manifest = manifest || (typ == "JSON" && bare == "appsscript")
	}
	if !manifest {
		return "", nil, fail("INVALID_PARAMS", "Apps Script API requires an appsscript.json manifest in "+root,
			"Pull the project first, or create appsscript.json manually")
	}
	return scriptID, files, nil
}

// readdirNames is fs.promises.readdir: the entries in the order the OS
// returns them, not sorted.
func readdirNames(dir string) ([]string, error) {
	f, err := os.Open(dir)
	if err != nil {
		return nil, google.NodeFSError("scandir", dir, err)
	}
	defer f.Close()
	names, err := f.Readdirnames(-1)
	if err != nil {
		return nil, google.NodeFSError("scandir", dir, err)
	}
	return names, nil
}

// putSource is the content Bun put reads before it resolves the profile:
// --source, else the --from file, else stdin trimmed.
func putSource(in plugins.CommandInput, fail google.FailFunc) (string, error) {
	source, from := in.Option("source"), in.Option("from")
	if source != "" && from != "" {
		return "", fail("INVALID_PARAMS", "--source and --from are mutually exclusive", "")
	}
	if source != "" {
		return source, nil
	}
	if from != "" {
		raw, err := google.ReadFile(from)
		if err != nil {
			return "", err
		}
		return jsvalue.BufferString(raw), nil
	}
	if _, ok := in.Stdin.(string); !ok {
		return "", fail("INVALID_PARAMS", "No content provided", "Pass --source <text>, --from <path>, or pipe content via stdin")
	}
	return google.Stdin(in), nil
}

// pushInputError and putInputError are the input rejections Bun reports
// before enforceWriteAccess (google.WriteUnlessInvalid).
func pushInputError(in plugins.CommandInput, fail google.FailFunc) error {
	_, _, err := localProject(in, fail)
	return err
}

func putInputError(in plugins.CommandInput, fail google.FailFunc) error {
	_, err := putSource(in, fail)
	return err
}
