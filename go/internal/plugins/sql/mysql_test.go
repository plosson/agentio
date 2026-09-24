package sql

import (
	"bytes"
	"context"
	"encoding/binary"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/jsvalue"
)

// myCol is a column definition the fake server sends.
type myCol struct {
	name    string
	typ     byte
	flags   uint16
	charset uint16
	length  uint32
}

// myResult is one statement result: a result set, an OK packet, or an error.
type myResult struct {
	cols    []myCol
	rows    [][]*string
	ok      bool
	errCode uint16
	errMsg  string
}

func s(v string) *string { return &v }

// fakeMySQL is an in-process MySQL text-protocol endpoint (protocol 4.1,
// EOF packets, multi-statements): it accepts any login and answers each
// COM_QUERY from a script.
type fakeMySQL struct {
	port    string
	mu      sync.Mutex
	user    string
	db      string
	queries []string
	reply   func(query string) []myResult
	reject  *myResult
}

func newFakeMySQL(t *testing.T) *fakeMySQL {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeMySQL{port: strconv.Itoa(ln.Addr().(*net.TCPAddr).Port)}
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

func (f *fakeMySQL) seen() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.queries...)
}

type packets struct {
	conn net.Conn
	seq  byte
}

func (p *packets) write(payload []byte) {
	head := []byte{byte(len(payload)), byte(len(payload) >> 8), byte(len(payload) >> 16), p.seq}
	p.seq++
	_, _ = p.conn.Write(append(head, payload...))
}

func (p *packets) read() ([]byte, error) {
	head := make([]byte, 4)
	if _, err := io.ReadFull(p.conn, head); err != nil {
		return nil, err
	}
	body := make([]byte, int(head[0])|int(head[1])<<8|int(head[2])<<16)
	if _, err := io.ReadFull(p.conn, body); err != nil {
		return nil, err
	}
	p.seq = head[3] + 1
	return body, nil
}

func lenenc(b []byte) []byte {
	if len(b) < 251 {
		return append([]byte{byte(len(b))}, b...)
	}
	return append([]byte{0xfc, byte(len(b)), byte(len(b) >> 8)}, b...)
}

func u16(v uint16) []byte { return binary.LittleEndian.AppendUint16(nil, v) }

const (
	statusAutocommit  = 0x0002
	statusMoreResults = 0x0008
)

func okPacket(status uint16) []byte {
	return append(append([]byte{0x00, 0x00, 0x00}, u16(status)...), 0, 0)
}

func eofPacket(status uint16) []byte {
	return append([]byte{0xfe, 0, 0}, u16(status)...)
}

func errPacket(code uint16, msg string) []byte {
	return append(append(append([]byte{0xff}, u16(code)...), []byte("#HY000")...), msg...)
}

func (f *fakeMySQL) serve(conn net.Conn) {
	defer conn.Close()
	p := &packets{conn: conn}
	caps := uint32(0x1 | 0x2 | 0x4 | 0x8 | 0x200 | 0x2000 | 0x8000 | 0x10000 | 0x20000 | 0x80000)
	hs := []byte{0x0a}
	hs = append(hs, "8.0.36-fake\x00"...)
	hs = append(hs, 1, 0, 0, 0)
	hs = append(hs, "abcdefgh"...)
	hs = append(hs, 0)
	hs = append(hs, u16(uint16(caps))...)
	hs = append(hs, 255)
	hs = append(hs, u16(statusAutocommit)...)
	hs = append(hs, u16(uint16(caps>>16))...)
	hs = append(hs, 21)
	hs = append(hs, make([]byte, 10)...)
	hs = append(hs, "ijklmnopqrst\x00"...)
	hs = append(hs, "mysql_native_password\x00"...)
	p.write(hs)
	login, err := p.read()
	if err != nil || len(login) < 32 {
		return
	}
	rest := login[32:]
	user, rest, _ := bytes.Cut(rest, []byte{0})
	if len(rest) > 0 {
		rest = rest[1+int(rest[0]):]
	}
	db, _, _ := bytes.Cut(rest, []byte{0})
	f.mu.Lock()
	f.user, f.db = string(user), string(db)
	reject, reply := f.reject, f.reply
	f.mu.Unlock()
	if reject != nil {
		p.write(errPacket(reject.errCode, reject.errMsg))
		return
	}
	p.write(okPacket(statusAutocommit))
	for {
		cmd, err := p.read()
		if err != nil || len(cmd) == 0 || cmd[0] != 0x03 {
			return
		}
		q := string(cmd[1:])
		f.mu.Lock()
		f.queries = append(f.queries, q)
		f.mu.Unlock()
		var results []myResult
		if reply != nil {
			results = reply(q)
		}
		if results == nil {
			results = []myResult{{ok: true}}
		}
		for i, r := range results {
			status := uint16(statusAutocommit)
			if i < len(results)-1 {
				status |= statusMoreResults
			}
			switch {
			case r.errMsg != "":
				p.write(errPacket(r.errCode, r.errMsg))
			case r.ok:
				p.write(okPacket(status))
			default:
				p.write([]byte{byte(len(r.cols))})
				for _, c := range r.cols {
					def := []byte{}
					for _, part := range []string{"def", "", "", "", c.name, c.name} {
						def = append(def, lenenc([]byte(part))...)
					}
					def = append(def, 0x0c)
					def = append(def, u16(c.charset)...)
					def = binary.LittleEndian.AppendUint32(def, c.length)
					def = append(def, c.typ)
					def = append(def, u16(c.flags)...)
					def = append(def, 0, 0, 0)
					p.write(def)
				}
				p.write(eofPacket(statusAutocommit))
				for _, row := range r.rows {
					var b []byte
					for _, v := range row {
						if v == nil {
							b = append(b, 0xfb)
						} else {
							b = append(b, lenenc([]byte(*v))...)
						}
					}
					p.write(b)
				}
				p.write(eofPacket(status))
			}
		}
	}
}

const utf8mb4 = 255

func TestMySQLTextValuesMatchBun(t *testing.T) {
	for _, c := range []struct {
		col  mysqlColumn
		v    any
		want string
	}{
		{mysqlColumn{fieldType: myTiny}, int64(-5), "-5"},
		{mysqlColumn{fieldType: myYear, flags: myFlagUnsigned}, int64(2024), "2024"},
		{mysqlColumn{fieldType: myLong, flags: myFlagUnsigned}, int64(4294967295), "4294967295"},
		{mysqlColumn{fieldType: myLongLong}, int64(2147483647), "2147483647"},
		{mysqlColumn{fieldType: myLongLong}, int64(2147483648), `"2147483648"`},
		{mysqlColumn{fieldType: myLongLong}, int64(-2147483649), `"-2147483649"`},
		{mysqlColumn{fieldType: myLongLong, flags: myFlagUnsigned}, uint64(4294967295), "4294967295"},
		{mysqlColumn{fieldType: myLongLong, flags: myFlagUnsigned}, uint64(18446744073709551615), `"18446744073709551615"`},
		{mysqlColumn{fieldType: myFloat}, float32(1.1), "1.1"},
		{mysqlColumn{fieldType: myDouble}, 0.30000000000000004, "0.30000000000000004"},
		{mysqlColumn{fieldType: myNewDecimal, flags: myFlagBinary, charset: binaryCharset}, []byte("12.50"), `"12.50"`},
		{mysqlColumn{fieldType: myJSON, charset: binaryCharset, flags: myFlagBinary}, []byte(`{"b":1,"a":2}`), `{"b":1,"a":2}`},
		{mysqlColumn{fieldType: myTime}, []byte("-838:59:59"), `"-838:59:59"`},
		{mysqlColumn{fieldType: myDate}, []byte("2024-02-29"), `"2024-02-29T00:00:00.000Z"`},
		{mysqlColumn{fieldType: myDateTime}, []byte("2024-01-02 03:04:05.678901"), `"2024-01-02T03:04:05.678Z"`},
		{mysqlColumn{fieldType: myTimestamp}, []byte("0000-00-00 00:00:00"), "null"},
		{mysqlColumn{fieldType: myDate}, []byte("2023-02-29"), "null"},
		{mysqlColumn{fieldType: myBit, length: 1}, []byte{1}, "true"},
		{mysqlColumn{fieldType: myBit, length: 1}, []byte{0}, "false"},
		{mysqlColumn{fieldType: myBit, length: 8}, []byte{1}, `{"type":"Buffer","data":[1]}`},
		{mysqlColumn{fieldType: 252, flags: myFlagBinary, charset: binaryCharset}, []byte{0, 255}, `{"type":"Buffer","data":[0,255]}`},
		// A _bin collation sets BINARY without the binary character set.
		{mysqlColumn{fieldType: 253, flags: myFlagBinary, charset: 46}, []byte("héllo"), `"héllo"`},
		{mysqlColumn{fieldType: 254, charset: utf8mb4}, []byte("enum"), `"enum"`},
		{mysqlColumn{fieldType: myLong}, nil, "null"},
	} {
		v, err := decodeMySQL(c.col, c.v)
		if got := string(jsvalue.Stringify(v)); err != nil || got != c.want {
			t.Errorf("%#v %#v: %s %v, want %s", c.col, c.v, got, err, c.want)
		}
	}
	if _, err := decodeMySQL(mysqlColumn{fieldType: myJSON}, []byte("[1")); err == nil || err.Error() != "JSON Parse error: Expected ']'" {
		t.Fatal(err)
	}
}

func TestMySQLQueriesTheTextProtocol(t *testing.T) {
	srv := newFakeMySQL(t)
	srv.reply = func(q string) []myResult {
		switch q {
		case "SELECT * FROM t":
			return []myResult{{
				cols: []myCol{
					{name: "id", typ: myLong, charset: binaryCharset},
					{name: "big", typ: myLongLong, flags: myFlagUnsigned, charset: binaryCharset},
					{name: "on", typ: myBit, length: 1, charset: binaryCharset, flags: myFlagBinary},
					{name: "raw", typ: 253, charset: binaryCharset, flags: myFlagBinary},
					{name: "name", typ: 253, charset: utf8mb4},
					{name: "at", typ: myDateTime, charset: binaryCharset, flags: myFlagBinary},
					{name: "id", typ: myFloat, charset: binaryCharset},
				},
				rows: [][]*string{
					{s("1"), s("18446744073709551615"), s("\x01"), s("\x00\xff"), s("bøb"), s("2024-01-02 03:04:05"), s("1.1")},
					{s("2"), s("7"), s("\x00"), nil, nil, s("0000-00-00 00:00:00"), nil},
				},
			}}
		case "INSERT INTO t VALUES (1); SELECT 2 AS `2`; UPDATE t SET x = 1":
			return []myResult{{ok: true}, {cols: []myCol{{name: "2", typ: myLongLong, charset: binaryCharset}}, rows: [][]*string{{s("2")}}}, {ok: true}}
		case "INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)":
			return []myResult{{ok: true}, {ok: true}}
		case "SELEC":
			return []myResult{{errCode: 1064, errMsg: "You have an error in your SQL syntax"}}
		case "DELETE FROM t":
			return []myResult{{errCode: 1792, errMsg: "Cannot execute statement in a READ ONLY transaction."}}
		case "SELECT 1":
			return []myResult{{cols: []myCol{{name: "1", typ: myLongLong, charset: binaryCharset}}, rows: [][]*string{{s("1")}}}}
		}
		return nil
	}
	c, err := newClient(map[string]any{"url": "mysql://root:pw@127.0.0.1:" + srv.port + "/shop", "displayName": "root@127.0.0.1/shop"})
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
		{"SELECT * FROM t", false, `[{"big":"18446744073709551615","on":true,"raw":{"type":"Buffer","data":[0,255]},"name":"bøb","at":"2024-01-02T03:04:05.000Z","id":1.1},` +
			`{"big":7,"on":false,"raw":null,"name":null,"at":null,"id":null}]`},
		{"INSERT INTO t VALUES (1); SELECT 2 AS `2`; UPDATE t SET x = 1", false, `[[],[{"2":2}],[]]`},
		{"INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)", false, `[[],[]]`},
		{"UPDATE t SET x = 2", false, `[]`},
		{"SELECT 1", true, `[{"1":1}]`},
	} {
		res, err := c.query(ctx, tc.query, defaultLimit, tc.readOnly, fail)
		if err != nil || string(jsvalue.Stringify(res.Rows)) != tc.want {
			t.Errorf("%s: %s %v", tc.query, jsvalue.Stringify(res), err)
		}
	}
	for _, tc := range []struct {
		query    string
		readOnly bool
		msg      string
	}{
		{"SELEC", false, "Query failed: You have an error in your SQL syntax"},
		{"DELETE FROM t", true, "Query failed: Cannot execute statement in a READ ONLY transaction."},
	} {
		_, err := c.query(ctx, tc.query, defaultLimit, tc.readOnly, fail)
		if ce := cliErr(t, err); ce.Code != clierr.APIError || ce.Message != tc.msg {
			t.Errorf("%s: %#v", tc.query, ce)
		}
	}
	if v := c.validate(ctx); !v.Valid || v.Info != "root@127.0.0.1/shop" {
		t.Fatalf("%#v", v)
	}
	srv.mu.Lock()
	user, db := srv.user, srv.db
	srv.mu.Unlock()
	if user != "root" || db != "shop" {
		t.Fatalf("login %q %q", user, db)
	}
	want := "SELECT * FROM t|INSERT INTO t VALUES (1); SELECT 2 AS `2`; UPDATE t SET x = 1|INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)|UPDATE t SET x = 2|" +
		"START TRANSACTION read only|SELECT 1|COMMIT|SELEC|START TRANSACTION read only|DELETE FROM t|ROLLBACK|SELECT 1"
	if got := strings.Join(srv.seen(), "|"); got != want {
		t.Fatalf("queries\n got %s\nwant %s", got, want)
	}
}

func TestMySQLLoginFailureIsAnAuthFailure(t *testing.T) {
	srv := newFakeMySQL(t)
	srv.reject = &myResult{errCode: 1045, errMsg: "Access denied for user 'root'@'localhost' (using password: YES)"}
	_, err := query(t, "mysql://root:bad@127.0.0.1:"+srv.port+"/shop", "SELECT 1", false)
	if ce := cliErr(t, err); ce.Code != clierr.AuthFailed || ce.Message != "Database authentication failed: Access denied for user 'root'@'localhost' (using password: YES)" {
		t.Fatalf("%#v", ce)
	}
}
