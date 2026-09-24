package google

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// Extname is Node path.extname: the last "." of the basename onward, except a
// leading dot (".bashrc") or "..".
func Extname(p string) string {
	base := filepath.Base(p)
	if base == ".." || base == "/" {
		return ""
	}
	i := strings.LastIndex(base, ".")
	if i <= 0 {
		return ""
	}
	return base[i:]
}

// NodeFSError gives a local file failure the message Node's fs throws
// ("ENOENT: no such file or directory, stat './x'"). It carries no numeric
// code, so a product that wraps it maps it to API_ERROR as in Bun, and one
// that returns it prints "Error: <message>". An errno Node names differently
// is returned unchanged.
func NodeFSError(syscallName, path string, err error) error {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return err
	}
	var code, text string
	switch {
	case errors.Is(errno, fs.ErrNotExist):
		code, text = "ENOENT", "no such file or directory"
	case errno == syscall.EACCES || errno == syscall.EPERM:
		code, text = "EACCES", "permission denied"
	case errno == syscall.EISDIR:
		code, text = "EISDIR", "illegal operation on a directory"
	case errno == syscall.ENOTDIR:
		code, text = "ENOTDIR", "not a directory"
	case errno == syscall.EEXIST:
		code, text = "EEXIST", "file already exists"
	default:
		return err
	}
	message := code + ": " + text + ", " + syscallName
	if path != "" {
		message += " '" + path + "'"
	}
	return errors.New(message)
}

// ReadFile is fs.promises.readFile(path): an open failure names the path, a
// read failure (a directory) does not, as in Node.
func ReadFile(path string) ([]byte, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		var pe *fs.PathError
		if errors.As(err, &pe) && pe.Op == "read" {
			return nil, NodeFSError("read", "", err)
		}
		return nil, NodeFSError("open", path, err)
	}
	return b, nil
}

// MkdirAll is fs.promises.mkdir(path, { recursive: true }): an existing
// non-directory at path is EEXIST, a file in the way above it ENOTDIR, both
// naming path.
func MkdirAll(path string) error {
	if info, err := os.Stat(path); err == nil && !info.IsDir() {
		return NodeFSError("mkdir", path, syscall.EEXIST)
	}
	if err := os.MkdirAll(path, 0o777); err != nil {
		return NodeFSError("mkdir", path, err)
	}
	return nil
}
