package nodefs

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestExtnameAndFSErrorsMatchNode(t *testing.T) {
	// Printed by Node's path.extname.
	for in, want := range map[string]string{
		"a.TXT": ".TXT", ".bashrc": "", "a.": ".", "...": ".", "..a": ".a", "x/.b.c": ".c",
		"dir/": "", "a.b.c": ".c", "..": "", ".": "", "/": "", "noext": "", "a.b/": ".b",
	} {
		if got := Extname(in); got != want {
			t.Errorf("%q: %q want %q", in, got, want)
		}
	}
	for _, c := range []struct {
		err  error
		want string
	}{
		{&os.PathError{Op: "stat", Path: "x", Err: syscall.ENOENT}, "ENOENT: no such file or directory, stat './x'"},
		{&os.PathError{Op: "open", Path: "x", Err: syscall.EACCES}, "EACCES: permission denied, stat './x'"},
		{&os.PathError{Op: "open", Path: "x", Err: syscall.ENOTDIR}, "ENOTDIR: not a directory, stat './x'"},
		{&os.PathError{Op: "mkdir", Path: "x", Err: syscall.EEXIST}, "EEXIST: file already exists, stat './x'"},
	} {
		if got := NodeFSError("stat", "./x", c.err).Error(); got != c.want {
			t.Errorf("%q", got)
		}
	}
	other := errors.New("disk on fire")
	if NodeFSError("stat", "x", other) != other {
		t.Fatal("an unknown error is kept")
	}
}

// Messages printed by Bun's fs.promises for the same failures.
func TestReadFileAndMkdirAllFailLikeNode(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "f.txt")
	if err := os.WriteFile(file, []byte("x"), 0o666); err != nil {
		t.Fatal(err)
	}
	if b, err := ReadFile(file); err != nil || string(b) != "x" {
		t.Fatalf("%q %v", b, err)
	}
	missing := filepath.Join(dir, "missing")
	for _, c := range []struct {
		err  error
		want string
	}{
		{func() error { _, err := ReadFile(missing); return err }(), "ENOENT: no such file or directory, open '" + missing + "'"},
		{func() error { _, err := ReadFile(dir); return err }(), "EISDIR: illegal operation on a directory, read"},
		{MkdirAll(file), "EEXIST: file already exists, mkdir '" + file + "'"},
		{MkdirAll(filepath.Join(file, "sub")), "ENOTDIR: not a directory, mkdir '" + filepath.Join(file, "sub") + "'"},
	} {
		if c.err == nil || c.err.Error() != c.want {
			t.Errorf("got %v, want %q", c.err, c.want)
		}
	}
	nested := filepath.Join(dir, "a", "b")
	if err := MkdirAll(nested); err != nil {
		t.Fatal(err)
	}
	if err := MkdirAll(nested); err != nil {
		t.Fatalf("an existing directory is fine: %v", err)
	}
}
