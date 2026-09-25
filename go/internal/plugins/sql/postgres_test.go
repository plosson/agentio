package sql

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgproto3"
	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/testbox"
)

// fakePostgres is an in-process PostgreSQL wire endpoint: it accepts any
// startup, records every simple query, and answers from a script.
type fakePostgres struct {
	port    string
	mu      sync.Mutex
	params  map[string]string
	queries []string
	// reply answers one simple query; nil answers "SELECT 1" style with no rows.
	reply func(query string) []pgproto3.BackendMessage
	// reject fails the startup with this error response.
	reject *pgproto3.ErrorResponse
}

func newFakePostgres(t *testing.T) *fakePostgres {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f := &fakePostgres{port: strconv.Itoa(ln.Addr().(*net.TCPAddr).Port)}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go f.serve(conn)
		}
	}()
	return f
}

func (f *fakePostgres) url(path string) string {
	return "postgres://tester:pw@127.0.0.1:" + f.port + path
}

func (f *fakePostgres) startup() map[string]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.params
}

func (f *fakePostgres) seen() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.queries...)
}

func (f *fakePostgres) serve(conn net.Conn) {
	defer conn.Close()
	be := pgproto3.NewBackend(conn, conn)
	msg, err := be.ReceiveStartupMessage()
	if err != nil {
		return
	}
	start, ok := msg.(*pgproto3.StartupMessage)
	if !ok {
		return
	}
	f.mu.Lock()
	f.params = start.Parameters
	reject, reply := f.reject, f.reply
	f.mu.Unlock()
	if reject != nil {
		be.Send(reject)
		_ = be.Flush()
		return
	}
	be.Send(&pgproto3.AuthenticationOk{})
	be.Send(&pgproto3.ReadyForQuery{TxStatus: 'I'})
	if be.Flush() != nil {
		return
	}
	for {
		msg, err := be.Receive()
		if err != nil {
			return
		}
		q, ok := msg.(*pgproto3.Query)
		if !ok {
			return
		}
		f.mu.Lock()
		f.queries = append(f.queries, q.String)
		f.mu.Unlock()
		var out []pgproto3.BackendMessage
		if reply != nil {
			out = reply(q.String)
		}
		if out == nil {
			out = []pgproto3.BackendMessage{&pgproto3.CommandComplete{CommandTag: []byte("OK")}}
		}
		for _, m := range out {
			be.Send(m)
		}
		be.Send(&pgproto3.ReadyForQuery{TxStatus: 'I'})
		if be.Flush() != nil {
			return
		}
	}
}

// resultSet is RowDescription, the text rows (nil is NULL), CommandComplete.
func resultSet(fields []pgproto3.FieldDescription, rows ...[][]byte) []pgproto3.BackendMessage {
	out := []pgproto3.BackendMessage{&pgproto3.RowDescription{Fields: fields}}
	for _, r := range rows {
		out = append(out, &pgproto3.DataRow{Values: r})
	}
	return append(out, &pgproto3.CommandComplete{CommandTag: []byte("SELECT " + strconv.Itoa(len(rows)))})
}

func field(name string, oid uint32) pgproto3.FieldDescription {
	return pgproto3.FieldDescription{Name: []byte(name), DataTypeOID: oid}
}

func text(values ...string) [][]byte {
	out := make([][]byte, len(values))
	for i, v := range values {
		if v != "\x00NULL" {
			out[i] = []byte(v)
		}
	}
	return out
}

func TestPostgresTextValuesMatchBun(t *testing.T) {
	for _, c := range []struct {
		oid  uint32
		text string
		want string
	}{
		{oidInt4, "42", "42"},
		{oidInt2, "-7", "-7"},
		{oidOid, "4294967295", "4294967295"},
		{oidInt8, "9223372036854775807", `"9223372036854775807"`},
		{oidNumeric, "12.50", `"12.50"`},
		{oidFloat8, "0.30000000000000004", "0.30000000000000004"},
		{oidFloat4, "1.1", "1.1"},
		{oidFloat8, "NaN", "null"},
		{oidFloat8, "Infinity", "null"},
		{oidFloat8, "1e+300", "1e+300"},
		{oidBool, "t", "true"},
		{oidBool, "f", "false"},
		{oidJSONB, `{"b": 1, "a": [1, 2.50]}`, `{"b":1,"a":[1,2.5]}`},
		{oidJSON, `"str"`, `"str"`},
		{oidDate, "2024-01-02", `"2024-01-02T00:00:00.000Z"`},
		{oidTimestamp, "2024-01-02 03:04:05.123456", `"2024-01-02T03:04:05.123Z"`},
		{oidTimestamptz, "2024-01-02 03:04:05+01", `"2024-01-02T02:04:05.000Z"`},
		{oidTimestamptz, "2024-01-02 03:04:05.5-03:30", `"2024-01-02T06:34:05.500Z"`},
		{oidTimestamp, "infinity", "null"},
		{oidDate, "-infinity", "null"},
		{oidTime, "10:11:12", `"10:11:12"`},
		{oidTimetz, "10:11:12+02", `"10:11:12+02"`},
		{oidBytea, `\x00ff10`, `{"type":"Buffer","data":[0,255,16]}`},
		{oidBytea, `\x`, `{"type":"Buffer","data":[]}`},
		{oidText, "héllo <&>", `"héllo <&>"`},
		{2950, "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11", `"a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"`},
		{40000, "any", `"any"`},
		{oidTextArray, `{a,"b c","d\"e",NULL,"NULL",""}`, `["a","b c","d\"e",null,"NULL",""]`},
		{oidInt4Array, `{1,-2,3}`, `[1,-2,3]`},
		{oidInt4Array, `{{1,2},{3,4}}`, `[[1,2],[3,4]]`},
		{oidInt8Array, `{9223372036854775807,1}`, `["9223372036854775807","1"]`},
		{oidFloat8Array, `{1.5,NaN,Infinity,-Infinity,2}`, `[1.5,null,null,null,2]`},
		{oidBoolArray, `{t,f,NULL}`, `[true,false,null]`},
		{oidJSONBArray, `{"{\"a\": 1}","[1, 2]"}`, `[{"a":1},[1,2]]`},
		{oidByteaArray, `{"\\x00ff"}`, `[{"type":"Buffer","data":[0,255]}]`},
		{oidDateArray, `{2024-01-02,infinity}`, `["2024-01-02T00:00:00.000Z",null]`},
		{oidTimestampA, `{"2024-01-02 03:04:05"}`, `["2024-01-02T03:04:05.000Z"]`},
		{oidNumericArr, `{1.50,NaN}`, `["1.50","NaN"]`},
		{oidTextArray, `{}`, `[]`},
	} {
		v, err := decodePostgresText(c.oid, []byte(c.text))
		if got := string(jsvalue.Stringify(v)); err != nil || got != c.want {
			t.Errorf("%d %q: %s %v, want %s", c.oid, c.text, got, err, c.want)
		}
	}
	for _, c := range []struct {
		oid  uint32
		text string
		msg  string
	}{
		{oidBytea, "escape", "Failed to bind query: UnsupportedByteaFormat"},
		{oidBytea, `\xzz`, "Failed to bind query: InvalidByteSequence"},
		{oidInt4Array, `{1,x}`, "Failed to bind query: UnsupportedArrayFormat"},
		{oidInt4Array, `{1,2`, "Failed to bind query: UnsupportedArrayFormat"},
		{oidJSON, `{bad`, "JSON Parse error: Expected '}'"},
	} {
		if _, err := decodePostgresText(c.oid, []byte(c.text)); err == nil || err.Error() != c.msg {
			t.Errorf("%d %q: %v, want %s", c.oid, c.text, err, c.msg)
		}
	}
}

// Digit-only names are array indexes in Bun's row objects: they come first,
// in ascending order, and a repeated name keeps its last value.
func TestServerRowsFollowBunsColumnIdentifiers(t *testing.T) {
	names := []string{"b", "10", "a", "2", "007", "b", "4294967295"}
	cols := make([]column, len(names))
	values := make([]any, len(names))
	for i, n := range names {
		cols[i] = serverColumn(n)
		values[i] = float64(i)
	}
	if got := string(jsvalue.Stringify(buildRow(cols, values))); got != `{"2":3,"7":4,"10":1,"a":2,"b":5,"4294967295":6}` {
		t.Fatal(got)
	}
}

func TestPostgresQueriesTheSimpleProtocol(t *testing.T) {
	srv := newFakePostgres(t)
	srv.reply = func(q string) []pgproto3.BackendMessage {
		switch q {
		case "SELECT 1":
			return resultSet([]pgproto3.FieldDescription{field("?column?", oidInt4)}, text("1"))
		case "SELECT * FROM t":
			return resultSet([]pgproto3.FieldDescription{field("id", oidInt4), field("big", oidInt8), field("at", oidTimestamptz), field("n", oidText), field("id", oidBool)},
				text("1", "9007199254740993", "2024-01-02 03:04:05+00", "\x00NULL", "t"),
				text("2", "-1", "2024-06-30 23:59:59.999+02", "x", "f"))
		case "INSERT INTO t VALUES (1); SELECT 2 AS two":
			return append([]pgproto3.BackendMessage{&pgproto3.CommandComplete{CommandTag: []byte("INSERT 0 1")}},
				resultSet([]pgproto3.FieldDescription{field("two", oidInt4)}, text("2"))...)
		case "SELEC":
			return []pgproto3.BackendMessage{&pgproto3.ErrorResponse{Severity: "ERROR", Code: "42601", Message: `syntax error at or near "SELEC"`}}
		case "DELETE FROM t":
			return []pgproto3.BackendMessage{&pgproto3.ErrorResponse{Severity: "ERROR", Code: "25006", Message: "cannot execute DELETE in a read-only transaction"}}
		case "SELECT '[1'::json":
			return resultSet([]pgproto3.FieldDescription{field("j", oidJSON)}, text("[1"))
		}
		return nil
	}
	creds := map[string]any{"url": srv.url("/app?application_name=agentio"), "displayName": "tester@127.0.0.1/app"}
	c, err := newClient(testbox.Object(creds))
	if err != nil {
		t.Fatal(err)
	}
	defer c.close()
	ctx := context.Background()
	for _, tc := range []struct {
		query    string
		readOnly bool
		want     string
	}{
		{"SELECT * FROM t", false, `[{"big":"9007199254740993","at":"2024-01-02T03:04:05.000Z","n":null,"id":true},{"big":"-1","at":"2024-06-30T21:59:59.999Z","n":"x","id":false}]`},
		// Several statements: one array per statement, empty for a command.
		{"INSERT INTO t VALUES (1); SELECT 2 AS two", false, `[[],[{"two":2}]]`},
		{"SELECT 1", true, `[{"?column?":1}]`},
	} {
		res, err := c.query(ctx, tc.query, defaultLimit, tc.readOnly, fail)
		if err != nil || string(jsvalue.Stringify(res.Rows)) != tc.want {
			t.Errorf("%s: %#v %v", tc.query, res, err)
		}
	}
	for _, tc := range []struct {
		query    string
		readOnly bool
		msg      string
	}{
		{"SELEC", false, `Query failed: syntax error at or near "SELEC"`},
		{"DELETE FROM t", true, "Query failed: cannot execute DELETE in a read-only transaction"},
		{"SELECT '[1'::json", false, "Query failed: JSON Parse error: Expected ']'"},
	} {
		_, err := c.query(ctx, tc.query, defaultLimit, tc.readOnly, fail)
		if ce := cliErr(t, err); ce.Code != clierr.APIError || ce.Message != tc.msg {
			t.Errorf("%s: %#v", tc.query, ce)
		}
	}
	if v := c.validate(ctx); !v.Valid || v.Info != "tester@127.0.0.1/app" {
		t.Fatalf("%#v", v)
	}
	// One connection, Bun's startup parameters, and the read-only
	// transaction around each read-only query.
	p := srv.startup()
	if p["user"] != "tester" || p["database"] != "app" || p["client_encoding"] != "UTF8" || p["DateStyle"] != "ISO, MDY" || p["application_name"] != "agentio" {
		t.Fatalf("startup %v", p)
	}
	want := "SELECT * FROM t|INSERT INTO t VALUES (1); SELECT 2 AS two|BEGIN read only|SELECT 1|COMMIT|SELEC|BEGIN read only|DELETE FROM t|ROLLBACK|SELECT '[1'::json|SELECT 1"
	if got := strings.Join(srv.seen(), "|"); got != want {
		t.Fatalf("queries\n got %s\nwant %s", got, want)
	}
}

func TestPostgresConnectFailuresMatchBun(t *testing.T) {
	srv := newFakePostgres(t)
	srv.reject = &pgproto3.ErrorResponse{Severity: "FATAL", Code: "28P01", Message: `password authentication failed for user "tester"`}
	_, err := query(t, srv.url("/app"), "SELECT 1", false)
	if ce := cliErr(t, err); ce.Code != clierr.AuthFailed || ce.Message != `Database authentication failed: password authentication failed for user "tester"` {
		t.Fatalf("%#v", ce)
	}
	srv.reject = &pgproto3.ErrorResponse{Severity: "FATAL", Code: "3D000", Message: `database "nope" does not exist`}
	_, err = query(t, srv.url("/nope"), "SELECT 1", false)
	if ce := cliErr(t, err); ce.Code != clierr.APIError || ce.Message != `Query failed: database "nope" does not exist` {
		t.Fatalf("%#v", ce)
	}
	if got := pgErrorMessage(&pgconn.PgError{Detail: "d", Hint: "h"}); got != " d\nh" {
		t.Fatalf("%q", got)
	}
}

// Bun's SQL reads only its own PG* variables (connect.go): libpq's others
// (service files, client certificates, target_session_attrs, ...) and the
// files libpq finds under HOME must not reach the connection.
func TestPostgresConfigIgnoresLibpqEnvironment(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.MkdirAll(filepath.Join(home, ".postgresql"), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"postgresql.crt", "postgresql.key", "root.crt"} {
		if err := os.WriteFile(filepath.Join(home, ".postgresql", f), []byte("not a pem"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	for k, v := range map[string]string{
		"PGSERVICE": "nosuch", "PGSERVICEFILE": filepath.Join(home, "missing.conf"),
		"PGSSLROOTCERT": filepath.Join(home, "missing.pem"), "PGSSLCERT": filepath.Join(home, "c.pem"), "PGSSLKEY": filepath.Join(home, "k.pem"),
		"PGSSLSNI": "0", "PGTARGETSESSIONATTRS": "read-write", "PGAPPNAME": "libpq-app", "PGOPTIONS": "-c x=1",
	} {
		t.Setenv(k, v)
	}
	for _, mode := range []sslMode{sslDisable, sslRequire, sslVerifyFull} {
		cfg, err := newPostgres(serverOptions{adapter: adapterPostgres, hostname: "db.example.com", port: 5432, username: "u", database: "d", sslMode: mode}).config()
		if err != nil {
			t.Fatalf("%v: %v", mode, err)
		}
		if cfg.ValidateConnect != nil || cfg.RuntimeParams["application_name"] != "" || cfg.RuntimeParams["options"] != "" {
			t.Fatalf("%v: %#v", mode, cfg.RuntimeParams)
		}
		if tc := cfg.TLSConfig; tc != nil && (len(tc.Certificates) != 0 || tc.RootCAs != nil || (mode == sslVerifyFull && tc.ServerName != "db.example.com")) {
			t.Fatalf("%v: TLS from the environment: %#v", mode, tc)
		}
	}
	if os.Getenv("PGSERVICE") != "nosuch" {
		t.Fatal("the environment was not restored")
	}
}
