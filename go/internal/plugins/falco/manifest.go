package falco

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/nodefs"
)

// manifest is the sync directory's .manifest.json: the Falco document id
// mapped to the basename used on disk (no extension). It is what makes a
// re-run incremental, since the id cannot be recovered from the filename.
// The file is shared with the Bun CLI, so its shape and key order are Bun's.
type manifest struct {
	updatedAt string
	ids       []string // insertion order, as a JavaScript object keeps it
	entries   map[string]string
}

const manifestName = ".manifest.json"

func manifestPath(dir string) string { return filepath.Join(dir, manifestName) }

func isoNow() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }

func emptyManifest() *manifest {
	return &manifest{updatedAt: isoNow(), entries: map[string]string{}}
}

func (m *manifest) set(id, basename string) {
	if _, ok := m.entries[id]; !ok {
		m.ids = append(m.ids, id)
	}
	m.entries[id] = basename
}

// loadManifest treats a missing or unreadable manifest as empty rather than
// failing the sync.
func loadManifest(dir string) *manifest {
	raw, err := os.ReadFile(manifestPath(dir))
	if err != nil {
		return emptyManifest()
	}
	parsed, err := jsvalue.Parse(raw)
	if err != nil {
		return emptyManifest()
	}
	o, _ := parsed.(*jsvalue.Object)
	if o == nil {
		return emptyManifest()
	}
	version, _ := o.Get("version")
	if n, ok := version.(json.Number); !ok || toNumber(n) != 1 {
		return emptyManifest()
	}
	entries, _ := valueOf(o, "entries").(*jsvalue.Object)
	if entries == nil {
		return emptyManifest()
	}
	m := &manifest{updatedAt: isoNow(), entries: map[string]string{}}
	if s, ok := o.Str("updated_at"); ok {
		m.updatedAt = s
	}
	for _, id := range entries.Keys() {
		if basename, ok := entries.Str(id); ok {
			m.set(id, basename)
		}
	}
	return m
}

// saveManifest writes JSON.stringify({ version, updated_at, entries }, null, 2)
// with a fresh timestamp, readable by the owner only.
func saveManifest(dir string, m *manifest) error {
	m.updatedAt = isoNow()
	entries := jsvalue.NewObject()
	for _, id := range m.ids {
		entries.Set(id, m.entries[id])
	}
	out := jsvalue.NewObject()
	out.Set("version", 1)
	out.Set("updated_at", m.updatedAt)
	out.Set("entries", entries)
	path := manifestPath(dir)
	if err := nodefs.WriteFile(path, jsvalue.StringifyIndent(out)); err != nil {
		return err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return nodefs.NodeFSError("chmod", path, err)
	}
	return nil
}

// indexManifest maps each basename back to its document id.
func indexManifest(m *manifest) map[string]string {
	index := make(map[string]string, len(m.ids))
	for _, id := range m.ids {
		index[m.entries[id]] = id
	}
	return index
}

// resolveBasename resolves the on-disk basename for a document, creating or
// correcting its manifest entry. Upstream metadata can change (a corrected
// date or counterparty), which changes the derived name; the files are moved
// rather than orphaned.
func resolveBasename(id, proposed string, m *manifest, basenameToID map[string]string, onRename func(from, to string) error) (string, bool, error) {
	taken := func(candidate string) bool {
		owner, ok := basenameToID[candidate]
		return ok && owner != id
	}
	existing, ok := m.entries[id]
	if !ok || existing == "" {
		basename := uniqueBasename(proposed, taken)
		m.set(id, basename)
		basenameToID[basename] = id
		return basename, false, nil
	}
	target := uniqueBasename(proposed, taken)
	if target == existing {
		return existing, false, nil
	}
	delete(basenameToID, existing)
	basenameToID[target] = id
	if err := onRename(existing, target); err != nil {
		return "", false, err
	}
	m.set(id, target)
	return target, true, nil
}
