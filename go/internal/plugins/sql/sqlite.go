package sql

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"strings"
	"unsafe"

	"modernc.org/libc"
	sqlite3 "modernc.org/sqlite/lib"

	"github.com/plosson/agentio/go/internal/jsvalue"
)

// sqliteDB is Bun.SQL's SQLite adapter over bun:sqlite, driven through the
// SQLite C API (pure Go, no cgo) so statements run exactly as bun:sqlite
// runs them: one prepared statement when the text can return rows, every
// statement in turn otherwise.
type sqliteDB struct {
	tls *libc.TLS
	db  uintptr
	// openErr is the adapter's storedError: opening fails lazily, on the
	// first query.
	openErr error
}

// openSQLite is new Database(filename, options) as the adapter calls it.
func openSQLite(opts sqliteOptions) *sqliteDB {
	s := &sqliteDB{tls: libc.NewTLS()}
	filename := jsvalue.Trim(opts.filename)
	flags := int32(sqlite3.SQLITE_OPEN_READWRITE)
	if opts.readonly {
		flags = sqlite3.SQLITE_OPEN_READONLY
	} else if opts.create {
		flags |= sqlite3.SQLITE_OPEN_CREATE
	}
	anonymous := filename == "" || filename == ":memory:"
	if anonymous && opts.readonly {
		s.openErr = errors.New("Cannot open an anonymous database in read-only mode.")
		return s
	}
	if anonymous {
		filename = ":memory:"
	}
	name, err := libc.CString(filename)
	if err != nil {
		s.openErr = err
		return s
	}
	defer libc.Xfree(s.tls, name)
	pdb := s.tls.Alloc(int(unsafe.Sizeof(uintptr(0))))
	defer s.tls.Free(int(unsafe.Sizeof(uintptr(0))))
	rc := sqlite3.Xsqlite3_open_v2(s.tls, name, pdb, flags, 0)
	s.db = readPtr(pdb)
	if rc != sqlite3.SQLITE_OK {
		s.openErr = s.lastError()
		if s.db != 0 {
			sqlite3.Xsqlite3_close_v2(s.tls, s.db)
			s.db = 0
		}
	}
	return s
}

func (s *sqliteDB) close() {
	if s.db != 0 {
		sqlite3.Xsqlite3_close_v2(s.tls, s.db)
		s.db = 0
	}
	if s.tls != nil {
		s.tls.Close()
		s.tls = nil
	}
}

// lastError is createSQLiteError(db): the message is sqlite3_errmsg.
func (s *sqliteDB) lastError() error {
	return errors.New(libc.GoString(sqlite3.Xsqlite3_errmsg(s.tls, s.db)))
}

func (s *sqliteDB) unsafe(_ context.Context, query string) ([]any, error) {
	return s.exec(query)
}

// exec is sql.unsafe(query) on the SQLite adapter (SQLiteQueryHandle.run).
func (s *sqliteDB) exec(query string) ([]any, error) {
	if s.openErr != nil {
		return nil, s.openErr
	}
	if canReturnRows(query) {
		return s.all(query)
	}
	return []any{}, s.run(query)
}

// readOnly runs the query with PRAGMA query_only on, then turns it off
// whatever happened (SqlClient.executeReadOnly).
func (s *sqliteDB) readOnly(_ context.Context, query string) ([]any, error) {
	defer func() { _, _ = s.exec("PRAGMA query_only = OFF") }()
	if _, err := s.exec("PRAGMA query_only = ON"); err != nil {
		return nil, err
	}
	return s.exec(query)
}

// all is db.prepare(sql).all(): the first statement only, every row.
func (s *sqliteDB) all(query string) ([]any, error) {
	zsql, n, err := cBytes(query)
	if err != nil {
		return nil, err
	}
	defer libc.Xfree(s.tls, zsql)
	pstmt := s.tls.Alloc(int(unsafe.Sizeof(uintptr(0))))
	defer s.tls.Free(int(unsafe.Sizeof(uintptr(0))))
	if rc := sqlite3.Xsqlite3_prepare_v3(s.tls, s.db, zsql, int32(n), 0, pstmt, 0); rc != sqlite3.SQLITE_OK {
		return nil, s.lastError()
	}
	stmt := readPtr(pstmt)
	if stmt == 0 {
		// Only whitespace and comments: bun:sqlite throws a RangeError.
		return nil, errors.New("Invalid SQL statement")
	}
	defer sqlite3.Xsqlite3_finalize(s.tls, stmt)

	count := int(sqlite3.Xsqlite3_column_count(s.tls, stmt))
	columns := make([]column, count)
	for i := range columns {
		columns[i] = sqliteColumn(libc.GoString(sqlite3.Xsqlite3_column_name(s.tls, stmt, int32(i))))
	}
	rows := []any{}
	for {
		switch rc := sqlite3.Xsqlite3_step(s.tls, stmt); rc {
		case sqlite3.SQLITE_ROW:
			values := make([]any, count)
			for i := range values {
				values[i] = s.value(stmt, int32(i))
			}
			rows = append(rows, buildRow(columns, values))
		case sqlite3.SQLITE_DONE:
			return rows, nil
		default:
			return nil, s.lastError()
		}
	}
}

// run is db.run(sql): every statement stepped to completion, in order; the
// first failure stops it (earlier statements stay applied).
func (s *sqliteDB) run(query string) error {
	zsql, n, err := cBytes(query)
	if err != nil {
		return err
	}
	defer libc.Xfree(s.tls, zsql)
	pstmt := s.tls.Alloc(2 * int(unsafe.Sizeof(uintptr(0))))
	defer s.tls.Free(2 * int(unsafe.Sizeof(uintptr(0))))
	ptail := pstmt + unsafe.Sizeof(uintptr(0))
	head, end := zsql, zsql+uintptr(n)
	executed := false
	rc := int32(sqlite3.SQLITE_OK)
	for head < end {
		for head < end && skippedInQuery(libc.GoBytes(head, 1)[0]) {
			head++
		}
		if head >= end {
			break
		}
		rc = sqlite3.Xsqlite3_prepare_v3(s.tls, s.db, head, int32(end-head), 0, pstmt, ptail)
		if rc != sqlite3.SQLITE_OK {
			break
		}
		stmt, tail := readPtr(pstmt), readPtr(ptail)
		if stmt == 0 {
			if tail == head {
				break
			}
			head = tail
			continue
		}
		for rc = sqlite3.Xsqlite3_step(s.tls, stmt); rc == sqlite3.SQLITE_ROW; rc = sqlite3.Xsqlite3_step(s.tls, stmt) {
		}
		// The message is read before finalize resets it.
		var stepErr error
		if rc != sqlite3.SQLITE_DONE {
			stepErr = s.lastError()
		}
		sqlite3.Xsqlite3_finalize(s.tls, stmt)
		executed = true
		if stepErr != nil {
			return stepErr
		}
		head = tail
	}
	if rc != sqlite3.SQLITE_OK && rc != sqlite3.SQLITE_DONE {
		return s.lastError()
	}
	if !executed {
		return errors.New("Query contained no valid SQL statement; likely empty query.")
	}
	return nil
}

// value is bun:sqlite's toJS for one column: integers become JavaScript
// numbers (rounded past 2^53), text is decoded as UTF-8 with replacement, and
// a BLOB is a Uint8Array.
func (s *sqliteDB) value(stmt uintptr, i int32) any {
	switch sqlite3.Xsqlite3_column_type(s.tls, stmt, i) {
	case sqlite3.SQLITE_INTEGER:
		return float64(sqlite3.Xsqlite3_column_int64(s.tls, stmt, i))
	case sqlite3.SQLITE_FLOAT:
		return sqlite3.Xsqlite3_column_double(s.tls, stmt, i)
	case sqlite3.SQLITE_TEXT:
		p := sqlite3.Xsqlite3_column_text(s.tls, stmt, i)
		n := int(sqlite3.Xsqlite3_column_bytes(s.tls, stmt, i))
		if p == 0 || n == 0 {
			return ""
		}
		return jsvalue.BufferString(bytes.Clone(libc.GoBytes(p, n)))
	case sqlite3.SQLITE_BLOB:
		p := sqlite3.Xsqlite3_column_blob(s.tls, stmt, i)
		n := int(sqlite3.Xsqlite3_column_bytes(s.tls, stmt, i))
		if p == 0 || n == 0 {
			return jsUint8Array{}
		}
		return jsUint8Array(bytes.Clone(libc.GoBytes(p, n)))
	}
	return nil
}

// skippedInQuery is bun:sqlite isSkippedInSQLiteQuery: the separators run()
// steps over between statements.
func skippedInQuery(c byte) bool {
	return c == ' ' || c == ';' || c >= '\t' && c <= '\r'
}

// cBytes is the query as the UTF-8 buffer bun:sqlite hands to SQLite.
func cBytes(query string) (uintptr, int, error) {
	p, err := libc.CString(query)
	return p, len(query), err
}

// readPtr reads the pointer an sqlite3 out-parameter received.
func readPtr(p uintptr) uintptr {
	b := libc.GoBytes(p, int(unsafe.Sizeof(uintptr(0))))
	if len(b) == 8 {
		return uintptr(binary.NativeEndian.Uint64(b))
	}
	return uintptr(binary.NativeEndian.Uint32(b))
}

// canReturnRows is parseSQLQuery(sql).canReturnRows in Bun's SQLite adapter:
// a whitespace-separated SELECT, PRAGMA, WITH, EXPLAIN or RETURNING word
// outside quotes, anywhere in the text, sends it through prepare().all().
func canReturnRows(query string) bool {
	text := []rune(strings.ToUpper(jsvalue.Trim(query)))
	token := ""
	var quoted rune
	isRows := func(t string) bool {
		switch t {
		case "SELECT", "PRAGMA", "WITH", "EXPLAIN", "RETURNING":
			return true
		}
		return false
	}
	found := false
	for i := len(text) - 1; i >= 0; i-- {
		c := text[i]
		switch c {
		case ' ', '\n', '\t', '\r', '\f', '\v':
			if isRows(token) {
				found = true
			}
			token = ""
			continue
		}
		if c == '"' || c == '\'' {
			if quoted == c {
				quoted = 0
			} else {
				quoted = c
			}
			continue
		}
		if quoted == 0 {
			token = string(c) + token
		}
	}
	return found || isRows(token)
}
