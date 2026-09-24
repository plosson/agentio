package sql

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
)

// This file is new SQL(url) from Bun's internal/sql/shared.ts: which adapter a
// connection string selects and the options it resolves to.

type adapter string

const (
	adapterSQLite   adapter = "sqlite"
	adapterPostgres adapter = "postgres"
	adapterMySQL    adapter = "mysql"
	adapterMariaDB  adapter = "mariadb"
)

type sslMode int

const (
	sslDisable sslMode = iota
	sslPrefer
	sslRequire
	sslVerifyCA
	sslVerifyFull
)

type sqliteOptions struct {
	filename string
	readonly bool
	create   bool
}

// serverOptions are the resolved PostgreSQL/MySQL/MariaDB connection options.
type serverOptions struct {
	adapter  adapter
	hostname string
	port     int
	username string
	password string
	database string
	sslMode  sslMode
	// params are the other query parameters, in order (PostgreSQL startup
	// parameters in Bun).
	params [][2]string
	// path is a Unix socket, when the URL names one that exists.
	path string
}

type connection struct {
	adapter adapter
	sqlite  sqliteOptions
	server  serverOptions
}

var sqliteMemory = []string{":memory:", "sqlite://:memory:", "sqlite:memory"}

// parseDefinitelySqliteURL is the file name of a connection string that can
// only be SQLite, and false otherwise.
func parseDefinitelySqliteURL(s string) (string, bool) {
	for _, m := range sqliteMemory {
		if s == m {
			return ":memory:", true
		}
	}
	switch {
	case strings.HasPrefix(s, "sqlite://"):
		return s[9:], true
	case strings.HasPrefix(s, "sqlite:"):
		return s[7:], true
	case strings.HasPrefix(s, "file://"):
		if p, ok := fileURLToPath(s); ok {
			return p, true
		}
		return s[7:], true
	case strings.HasPrefix(s, "file:"):
		return s[5:], true
	}
	return "", false
}

// fileURLToPath is Bun.fileURLToPath on a POSIX host: a local file URL's path,
// percent-decoded.
func fileURLToPath(s string) (string, bool) {
	u, err := parseURL(s)
	if err != nil || u.scheme != "file" || (u.hostname != "" && u.hostname != "localhost") {
		return "", false
	}
	if strings.Contains(strings.ToLower(u.pathname), "%2f") {
		return "", false
	}
	path, ok := percentDecode(u.pathname)
	return path, ok
}

// parseSQLiteOptions: the query string is cut at the first "?", and mode=ro
// opens read-only. Bun does not honour mode=rw's "no create".
func parseSQLiteOptions(url string) sqliteOptions {
	opts := sqliteOptions{create: true}
	filename, query, hasQuery := strings.Cut(url, "?")
	if parsed, ok := parseDefinitelySqliteURL(filename); ok {
		filename = parsed
	}
	opts.filename = filename
	if opts.filename == "" {
		opts.filename = ":memory:"
	}
	if hasQuery && query != "" {
		if mode, ok := searchParam(query, "mode"); ok && mode == "ro" {
			opts.readonly = true
		}
	}
	return opts
}

// parseConnection resolves a stored connection URL as new SQL(url) does. Its
// errors are the ones Bun's constructor throws, before any query.
func parseConnection(raw string) (connection, error) {
	if _, ok := parseDefinitelySqliteURL(raw); ok {
		return connection{adapter: adapterSQLite, sqlite: parseSQLiteOptions(raw)}, nil
	}
	target := raw
	if !strings.Contains(raw, "://") {
		target = "postgres://" + raw
	}
	u, err := parseURL(target)
	if err != nil {
		return connection{}, err
	}
	var a adapter
	switch u.scheme {
	case "http", "https", "ftp", "postgres", "postgresql":
		a = adapterPostgres
	case "mysql", "mysql2":
		a = adapterMySQL
	case "mariadb":
		a = adapterMariaDB
	case "file", "sqlite":
		// A scheme in another case: the URL's own serialization is the name.
		return connection{adapter: adapterSQLite, sqlite: parseSQLiteOptions(u.href())}, nil
	default:
		return connection{}, fmt.Errorf(`Unsupported protocol: %s. Supported adapters: "postgres", "sqlite", "mysql", "mariadb"`, u.scheme)
	}
	opts, err := serverOptionsFor(a, u)
	if err != nil {
		return connection{}, err
	}
	return connection{adapter: a, server: opts}, nil
}

func env(names ...string) string {
	for _, n := range names {
		if v := os.Getenv(n); v != "" {
			return v
		}
	}
	return ""
}

// serverOptionsFor is the PostgreSQL/MySQL half of parseOptions: URL parts
// first, then the adapter's environment variables, then its defaults.
func serverOptionsFor(a adapter, u *whatwgURL) (serverOptions, error) {
	opts := serverOptions{adapter: a}
	mode := sslDisable
	if a == adapterPostgres {
		if v := env("PG_SSLMODE", "PGSSLMODE"); v != "" {
			m, err := normalizeSSLMode(v)
			if err != nil {
				return opts, err
			}
			mode = m
		}
	}
	username, err := decodeIfValid(u.username)
	if err != nil {
		return opts, err
	}
	password, err := decodeIfValid(u.password)
	if err != nil {
		return opts, err
	}
	path := ""
	if u.hostname == "" {
		path = u.pathname
	}
	tls := false
	for _, kv := range searchParams(u.query) {
		key, value := kv[0], kv[1]
		switch strings.ToLower(key) {
		case "sslmode", "ssl-mode", "ssl_mode":
			if mode, err = normalizeSSLMode(value); err != nil {
				return opts, err
			}
		case "ssl", "tls":
			switch v := strings.ToLower(value); {
			case v == "true" || v == "1":
				tls = true
				if mode == sslDisable {
					mode = sslPrefer
				}
			case v == "false" || v == "0":
				mode = sslDisable
			case v != "":
				if mode, err = normalizeSSLMode(v); err != nil {
					return opts, err
				}
			}
		case "path":
			path = value
		default:
			if strings.Contains(key, "\x00") || strings.Contains(value, "\x00") {
				return opts, fmt.Errorf("The argument 'options.%s' must not contain null bytes. Received %s", key, jsvalue.Quote(value))
			}
			opts.params = append(opts.params, [2]string{key, value})
		}
	}

	host := u.hostname
	port := u.port
	database, err := decodeIfValid(strings.TrimPrefix(u.pathname, "/"))
	if err != nil {
		return opts, err
	}
	switch a {
	case adapterPostgres:
		host = first(host, env("PG_HOST", "PGHOST"), "localhost")
		port = first(port, env("PG_PORT", "PGPORT"), "5432")
		username = first(username, env("PG_USER", "PGUSER", "USER"), "postgres")
		password = first(password, env("PG_PASSWORD", "PGPASSWORD", "PASSWORD"))
		database = first(env("PG_DATABASE", "PGDATABASE"), database, username)
	case adapterMySQL:
		host = first(host, env("MYSQL_HOST", "MYSQLHOST"), "localhost")
		port = first(port, env("MYSQL_PORT", "MYSQLPORT"), "3306")
		username = first(username, env("MYSQL_USER", "MYSQLUSER", "USER"), "root")
		password = first(password, env("MYSQL_PASSWORD", "MYSQLPASSWORD", "PASSWORD"))
		database = first(env("MYSQL_DATABASE", "MYSQLDATABASE"), database, "mysql")
	case adapterMariaDB:
		host = first(host, env("MARIADB_HOST", "MARIADBHOST"), "localhost")
		port = first(port, env("MARIADB_PORT", "MARIADBPORT"), "3306")
		username = first(username, env("MARIADB_USER", "MARIADBUSER", "USER"), "root")
		password = first(password, env("MARIADB_PASSWORD", "MARIADBPASSWORD", "PASSWORD"))
		database = first(env("MARIADB_DATABASE", "MARIADBDATABASE"), database, "mariadb")
	}
	n := jsvalue.Number(port)
	if n != float64(int(n)) || n < 1 || n > 65535 {
		return opts, fmt.Errorf("The argument 'port' must be a non-negative integer between 1 and 65535. Received %s", jsvalue.NumberString(n))
	}
	if a == adapterPostgres && path != "" && !strings.Contains(path, "/.s.PGSQL.") {
		if socket := fmt.Sprintf("%s/.s.PGSQL.%d", path, int(n)); exists(socket) {
			path = socket
		}
	}
	// ?ssl=true asks for an encrypted connection: it may not fall back.
	if tls && mode <= sslPrefer {
		mode = sslRequire
	}
	if path != "" && !exists(path) {
		path = ""
	}
	opts.hostname = strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")
	opts.port = int(n)
	opts.username, opts.password, opts.database = username, password, database
	opts.sslMode = mode
	opts.path = path
	return opts, nil
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// first is `a || b || c`.
func first(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// decodeIfValid is decodeURIComponent on a non-empty value; a malformed
// escape throws URIError "URI error".
func decodeIfValid(s string) (string, error) {
	if s == "" {
		return "", nil
	}
	out, ok := jsvalue.DecodeURIComponent(s)
	if !ok {
		return "", errors.New("URI error")
	}
	return out, nil
}

func normalizeSSLMode(value string) (sslMode, error) {
	if value == "" {
		return sslDisable, nil
	}
	switch v := strings.ToLower(value); v {
	case "disable", "disabled":
		return sslDisable, nil
	case "allow", "prefer", "preferred":
		return sslPrefer, nil
	case "require", "required":
		return sslRequire, nil
	case "verify-ca", "verify_ca":
		return sslVerifyCA, nil
	case "verify-full", "verify_full", "verify-identity", "verify_identity":
		return sslVerifyFull, nil
	default:
		return sslDisable, fmt.Errorf("The argument 'sslmode' must be one of: disable, allow, prefer, require, verify-ca, verify-full. Received '%s'", v)
	}
}

// whatwgURL is the part of a WHATWG URL Bun reads from a connection string.
// username, password and pathname keep their percent-encoding, as the URL
// getters return them.
type whatwgURL struct {
	scheme   string
	username string
	password string
	hostname string
	port     string
	pathname string
	query    string
	// hasHost is false for a URL with no "//" authority.
	hasHost bool
}

var errInvalidURL = errors.New("Invalid URL")

var specialPorts = map[string]string{"http": "80", "https": "443", "ftp": "21", "ws": "80", "wss": "443", "file": ""}

// parseURL is new URL(s) for the "scheme://user:pass@host:port/path?query"
// shapes a connection string takes. It throws TypeError "Invalid URL" where
// the WHATWG parser does for them: no scheme, a bad port, a forbidden host.
func parseURL(s string) (*whatwgURL, error) {
	s = strings.Trim(s, "\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c\x0d\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f ")
	s = strings.NewReplacer("\t", "", "\n", "", "\r", "").Replace(s)
	colon := strings.IndexByte(s, ':')
	if colon <= 0 || !isAlpha(s[0]) {
		return nil, errInvalidURL
	}
	for i := 1; i < colon; i++ {
		c := s[i]
		if !isAlpha(c) && !(c >= '0' && c <= '9') && c != '+' && c != '-' && c != '.' {
			return nil, errInvalidURL
		}
	}
	u := &whatwgURL{scheme: strings.ToLower(s[:colon])}
	_, special := specialPorts[u.scheme]
	rest := s[colon+1:]
	if hash := strings.IndexByte(rest, '#'); hash >= 0 {
		rest = rest[:hash]
	}
	if q := strings.IndexByte(rest, '?'); q >= 0 {
		u.query = rest[q+1:]
		rest = rest[:q]
	}
	if special {
		rest = strings.ReplaceAll(rest, "\\", "/")
	}
	if strings.HasPrefix(rest, "//") {
		u.hasHost = true
		rest = rest[2:]
		authority := rest
		if slash := strings.IndexByte(rest, '/'); slash >= 0 {
			authority, rest = rest[:slash], rest[slash:]
		} else {
			rest = ""
		}
		if at := strings.LastIndexByte(authority, '@'); at >= 0 {
			user, pass, _ := strings.Cut(authority[:at], ":")
			u.username = percentEncode(user, userinfoSet)
			u.password = percentEncode(pass, userinfoSet)
			authority = authority[at+1:]
		}
		host := authority
		if strings.HasPrefix(host, "[") {
			end := strings.IndexByte(host, ']')
			if end < 0 {
				return nil, errInvalidURL
			}
			host, u.port = host[:end+1], strings.TrimPrefix(host[end+1:], ":")
			if host[end+1:] != "" && !strings.HasPrefix(host[end+1:], ":") {
				return nil, errInvalidURL
			}
		} else if c := strings.LastIndexByte(host, ':'); c >= 0 {
			host, u.port = host[:c], host[c+1:]
		}
		for i := 0; i < len(u.port); i++ {
			if u.port[i] < '0' || u.port[i] > '9' {
				return nil, errInvalidURL
			}
		}
		if u.port != "" {
			p, err := strconv.Atoi(u.port)
			if err != nil || p > 65535 {
				return nil, errInvalidURL
			}
			u.port = strconv.Itoa(p)
			if specialPorts[u.scheme] == u.port {
				u.port = ""
			}
		}
		if strings.ContainsAny(host, " #/<>?@\\^|") || (!strings.HasPrefix(host, "[") && strings.ContainsAny(host, "[]:")) {
			return nil, errInvalidURL
		}
		if special {
			if host == "" && u.scheme != "file" {
				return nil, errInvalidURL
			}
			host = strings.ToLower(host)
		} else {
			host = percentEncode(host, c0ControlSet)
		}
		if host == "" && (u.username != "" || u.password != "" || u.port != "") {
			return nil, errInvalidURL
		}
		u.hostname = host
	}
	if special || u.hasHost {
		u.pathname = normalizePath(percentEncode(rest, pathSet))
		if special && u.pathname == "" {
			u.pathname = "/"
		}
	} else {
		// An opaque path ("sqlite:app.db") keeps everything but controls.
		u.pathname = percentEncode(rest, c0ControlSet)
	}
	return u, nil
}

// href is the URL's serialization.
func (u *whatwgURL) href() string {
	var b strings.Builder
	b.WriteString(u.scheme + ":")
	if u.hasHost {
		b.WriteString("//")
		if u.username != "" || u.password != "" {
			b.WriteString(u.username)
			if u.password != "" {
				b.WriteString(":" + u.password)
			}
			b.WriteString("@")
		}
		b.WriteString(u.hostname)
		if u.port != "" {
			b.WriteString(":" + u.port)
		}
	}
	b.WriteString(u.pathname)
	if u.query != "" {
		b.WriteString("?" + percentEncode(u.query, querySet))
	}
	return b.String()
}

// normalizePath resolves "." and ".." segments of a hierarchical path.
func normalizePath(p string) string {
	if p == "" {
		return p
	}
	var out []string
	segments := strings.Split(p[1:], "/")
	for i, seg := range segments {
		last := i == len(segments)-1
		switch strings.ToLower(seg) {
		case ".", "%2e":
			if last {
				out = append(out, "")
			}
		case "..", ".%2e", "%2e.", "%2e%2e":
			if len(out) > 0 {
				out = out[:len(out)-1]
			}
			if last {
				out = append(out, "")
			}
		default:
			out = append(out, seg)
		}
	}
	return "/" + strings.Join(out, "/")
}

func isAlpha(c byte) bool { return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' }

const (
	c0ControlSet = ""
	pathSet      = " \"#<>?`{}"
	userinfoSet  = pathSet + "/:;=@[\\]^|"
	querySet     = " \"#<>'"
)

// percentEncode leaves existing escapes alone and encodes C0 controls, DEL,
// non-ASCII bytes and the given set.
func percentEncode(s, set string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c < 0x20 || c >= 0x7f || strings.IndexByte(set, c) >= 0 {
			fmt.Fprintf(&b, "%%%02X", c)
			continue
		}
		b.WriteByte(c)
	}
	return b.String()
}

// percentDecode is the URL percent-decode of a path, read as UTF-8.
func percentDecode(s string) (string, bool) {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) && isHex(s[i+1]) && isHex(s[i+2]) {
			v, _ := strconv.ParseUint(s[i+1:i+3], 16, 8)
			out = append(out, byte(v))
			i += 2
			continue
		}
		out = append(out, s[i])
	}
	return jsvalue.BufferString(out), true
}

func isHex(c byte) bool {
	return c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F'
}

// searchParams is new URLSearchParams(query) as ordered key/value pairs.
func searchParams(query string) [][2]string {
	var out [][2]string
	for _, part := range strings.Split(query, "&") {
		if part == "" {
			continue
		}
		k, v, _ := strings.Cut(part, "=")
		key, _ := percentDecode(strings.ReplaceAll(k, "+", " "))
		value, _ := percentDecode(strings.ReplaceAll(v, "+", " "))
		out = append(out, [2]string{key, value})
	}
	return out
}

// searchParam is URLSearchParams#get: the first value for name.
func searchParam(query, name string) (string, bool) {
	for _, kv := range searchParams(query) {
		if kv[0] == name {
			return kv[1], true
		}
	}
	return "", false
}
