package sql

import (
	"context"
	"crypto/tls"
	"database/sql/driver"
	"errors"
	"io"
	"math"
	"net"
	"reflect"
	"strconv"
	"time"

	"github.com/go-sql-driver/mysql"

	"github.com/plosson/agentio/go/internal/jsvalue"
)

// mysqlDB is Bun.SQL's MySQL/MariaDB adapter for sql.unsafe(query) with no
// parameters: a COM_QUERY text-protocol query with multi-statements on.
type mysqlDB struct {
	opts serverOptions
	conn driver.Conn
}

func newMySQL(opts serverOptions) *mysqlDB { return &mysqlDB{opts: opts} }

func (m *mysqlDB) close() {
	if m.conn != nil {
		_ = m.conn.Close()
		m.conn = nil
	}
}

type quietLogger struct{}

func (quietLogger) Print(...any) {}

// config is the driver configuration for Bun's resolved options.
func (m *mysqlDB) config() *mysql.Config {
	o := m.opts
	cfg := mysql.NewConfig()
	cfg.User, cfg.Passwd, cfg.DBName = o.username, o.password, o.database
	cfg.Net, cfg.Addr = "tcp", net.JoinHostPort(o.hostname, strconv.Itoa(o.port))
	if o.path != "" {
		cfg.Net, cfg.Addr = "unix", o.path
	}
	cfg.MultiStatements = true
	cfg.Timeout = connectTimeout
	cfg.Logger = quietLogger{}
	switch o.sslMode {
	case sslPrefer:
		cfg.TLS = &tls.Config{InsecureSkipVerify: true}
		cfg.AllowFallbackToPlaintext = true
	case sslRequire:
		cfg.TLS = &tls.Config{InsecureSkipVerify: true}
	case sslVerifyCA, sslVerifyFull:
		cfg.TLS = &tls.Config{ServerName: o.hostname}
	}
	return cfg
}

func (m *mysqlDB) connect(ctx context.Context) error {
	if m.conn != nil {
		return nil
	}
	connector, err := mysql.NewConnector(m.config())
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, connectTimeout)
	defer cancel()
	conn, err := connector.Connect(ctx)
	if err != nil {
		return mysqlConnectError(ctx, err)
	}
	m.conn = conn
	return nil
}

func mysqlConnectError(ctx context.Context, err error) error {
	var myErr *mysql.MySQLError
	if errors.As(err, &myErr) {
		return mysqlServerError(myErr)
	}
	if ctx.Err() != nil || errors.Is(err, context.DeadlineExceeded) {
		return errors.New("Connection timeout after 30s")
	}
	var netErr *net.OpError
	var dnsErr *net.DNSError
	if errors.As(err, &netErr) || errors.As(err, &dnsErr) {
		return errors.New("Failed to connect")
	}
	return errors.New("Connection closed")
}

// mysqlServerError is ErrorPacket.toJS: the server's message alone.
func mysqlServerError(e *mysql.MySQLError) error {
	if e.Message == "" {
		return errors.New("MySQL error occurred")
	}
	return errors.New(e.Message)
}

func queryErrorMySQL(err error) error {
	var myErr *mysql.MySQLError
	if errors.As(err, &myErr) {
		return mysqlServerError(myErr)
	}
	if errors.Is(err, driver.ErrBadConn) || errors.Is(err, mysql.ErrInvalidConn) || errors.Is(err, net.ErrClosed) {
		return errors.New("Connection closed")
	}
	return err
}

func (m *mysqlDB) unsafe(ctx context.Context, query string) ([]any, error) {
	if err := m.connect(ctx); err != nil {
		return nil, err
	}
	return m.exec(ctx, query)
}

// readOnly is sql.begin('read only', tx => tx.unsafe(query)) on MySQL:
// START TRANSACTION read only, the query, COMMIT; ROLLBACK when it fails.
func (m *mysqlDB) readOnly(ctx context.Context, query string) ([]any, error) {
	if err := m.connect(ctx); err != nil {
		return nil, err
	}
	if _, err := m.exec(ctx, "START TRANSACTION read only"); err != nil {
		return nil, err
	}
	rows, err := m.exec(ctx, query)
	if err != nil {
		_, _ = m.exec(ctx, "ROLLBACK")
		return nil, err
	}
	if _, err := m.exec(ctx, "COMMIT"); err != nil {
		return nil, err
	}
	return rows, nil
}

// mysqlColumn is a column definition as Bun reads it.
type mysqlColumn struct {
	name      string
	fieldType uint8
	flags     uint16
	charset   uint8
	length    uint32
}

const (
	myTiny       = 1
	myShort      = 2
	myLong       = 3
	myFloat      = 4
	myDouble     = 5
	myTimestamp  = 7
	myLongLong   = 8
	myInt24      = 9
	myDate       = 10
	myTime       = 11
	myDateTime   = 12
	myYear       = 13
	myBit        = 16
	myJSON       = 245
	myNewDecimal = 246

	myFlagUnsigned = 1 << 5
	myFlagBinary   = 1 << 7
	binaryCharset  = 63
)

// driverColumns reads the column definitions the driver keeps unexported
// (type, flags, character set, length), which Bun's decoding needs. ok is
// false if this driver version lays them out differently.
func driverColumns(rows driver.Rows) (cols []mysqlColumn, ok bool) {
	defer func() {
		if recover() != nil {
			cols, ok = nil, false
		}
	}()
	v := reflect.ValueOf(rows)
	if v.Kind() == reflect.Pointer {
		v = v.Elem()
	}
	rs := v.FieldByName("rs")
	if !rs.IsValid() {
		return nil, false
	}
	list := rs.FieldByName("columns")
	if !list.IsValid() || list.Kind() != reflect.Slice {
		return nil, false
	}
	for i := 0; i < list.Len(); i++ {
		c := list.Index(i)
		cols = append(cols, mysqlColumn{
			name:      c.FieldByName("name").String(),
			fieldType: uint8(c.FieldByName("fieldType").Uint()),
			flags:     uint16(c.FieldByName("flags").Uint()),
			charset:   uint8(c.FieldByName("charSet").Uint()),
			length:    uint32(c.FieldByName("length").Uint()),
		})
	}
	return cols, true
}

// resultCount is how many statement results the connection has read for
// the current query (one per OK packet or result set header), or -1 if this
// driver version keeps the count elsewhere.
func resultCount(conn driver.Conn) (n int) {
	defer func() {
		if recover() != nil {
			n = -1
		}
	}()
	v := reflect.ValueOf(conn)
	if v.Kind() != reflect.Pointer || v.IsNil() {
		return -1
	}
	list := v.Elem().FieldByName("result").FieldByName("affectedRows")
	if !list.IsValid() || list.Kind() != reflect.Slice {
		return -1
	}
	return list.Len()
}

// exec runs the text and gathers its results: one statement's rows, or, for
// several statements, one array per statement (empty for a statement that
// returns no rows).
func (m *mysqlDB) exec(ctx context.Context, query string) ([]any, error) {
	queryer, ok := m.conn.(driver.QueryerContext)
	if !ok {
		return nil, errors.New("Connection closed")
	}
	rows, err := queryer.QueryContext(ctx, query, nil)
	if err != nil {
		return nil, queryErrorMySQL(err)
	}
	defer rows.Close()
	var results [][]any
	emitted := 0
	empties := func(n int) {
		for ; n > 0; n-- {
			results = append(results, []any{})
		}
	}
	for {
		names := rows.Columns()
		seen := resultCount(m.conn)
		if len(names) == 0 {
			if seen >= 0 {
				empties(seen - emitted)
				emitted = seen
			} else {
				empties(1)
			}
		} else {
			if seen >= 0 {
				empties(seen - emitted - 1)
				emitted = seen
			}
			set, err := readResultSet(rows, names)
			if err != nil {
				return nil, err
			}
			results = append(results, set)
		}
		next, ok := rows.(driver.RowsNextResultSet)
		if !ok || !next.HasNextResultSet() {
			break
		}
		if err := next.NextResultSet(); err != nil {
			if err == io.EOF {
				break
			}
			return nil, queryErrorMySQL(err)
		}
	}
	if seen := resultCount(m.conn); seen > emitted {
		empties(seen - emitted)
	}
	switch len(results) {
	case 0:
		return []any{}, nil
	case 1:
		return results[0], nil
	}
	out := make([]any, len(results))
	for i, r := range results {
		out[i] = r
	}
	return out, nil
}

func readResultSet(rows driver.Rows, names []string) ([]any, error) {
	defs, ok := driverColumns(rows)
	if !ok || len(defs) != len(names) {
		defs = make([]mysqlColumn, len(names))
		for i, n := range names {
			defs[i] = mysqlColumn{name: n}
		}
	}
	columns := make([]column, len(names))
	for i, n := range names {
		columns[i] = serverColumn(n)
	}
	out := []any{}
	dest := make([]driver.Value, len(names))
	for {
		if err := rows.Next(dest); err != nil {
			if err == io.EOF {
				return out, nil
			}
			return nil, queryErrorMySQL(err)
		}
		values := make([]any, len(dest))
		for i, v := range dest {
			cell, err := decodeMySQL(defs[i], v)
			if err != nil {
				return nil, err
			}
			values[i] = cell
		}
		out = append(out, buildRow(columns, values))
	}
}

// decodeMySQL is ResultSet parse_value_and_set_cell for the text protocol,
// from the value the driver read: integers already parsed, FLOAT as a
// float32, everything else as the text bytes.
func decodeMySQL(col mysqlColumn, v driver.Value) (any, error) {
	if v == nil {
		return nil, nil
	}
	unsigned := col.flags&myFlagUnsigned != 0
	switch col.fieldType {
	case myFloat, myDouble:
		switch n := v.(type) {
		case float32:
			f, _ := strconv.ParseFloat(strconv.FormatFloat(float64(n), 'g', -1, 32), 64)
			return f, nil
		case float64:
			return n, nil
		}
		return parseFloat(bytesOf(v)), nil
	case myTiny, myShort, myYear, myLong, myInt24:
		switch n := v.(type) {
		case int64:
			return float64(n), nil
		case uint64:
			return float64(n), nil
		}
		n, _ := strconv.ParseInt(string(bytesOf(v)), 10, 64)
		return float64(n), nil
	case myLongLong:
		switch n := v.(type) {
		case int64:
			if unsigned && n >= 0 && n <= math.MaxUint32 || !unsigned && n >= math.MinInt32 && n <= math.MaxInt32 {
				return float64(n), nil
			}
			return strconv.FormatInt(n, 10), nil
		case uint64:
			if n <= math.MaxUint32 {
				return float64(n), nil
			}
			return strconv.FormatUint(n, 10), nil
		}
		return jsvalue.BufferString(bytesOf(v)), nil
	case myJSON:
		return parseJSONCell(bytesOf(v))
	case myTime, myNewDecimal:
		return jsvalue.BufferString(bytesOf(v)), nil
	case myDate, myDateTime, myTimestamp:
		return jsDate(mysqlDateTime(bytesOf(v))), nil
	case myBit:
		b := bytesOf(v)
		if col.length == 1 {
			return len(b) > 0 && b[0] == 1, nil
		}
		return jsBuffer(append([]byte{}, b...)), nil
	}
	b := bytesOf(v)
	if col.flags&myFlagBinary != 0 && col.charset == binaryCharset {
		return jsBuffer(append([]byte{}, b...)), nil
	}
	return jsvalue.BufferString(b), nil
}

func bytesOf(v driver.Value) []byte {
	switch t := v.(type) {
	case []byte:
		return t
	case string:
		return []byte(t)
	case time.Time:
		return []byte(t.Format("2006-01-02 15:04:05.999999"))
	}
	return []byte(jsvalue.String(v))
}

// mysqlDateTime is DateTime::from_text then to_js_timestamp: the wall clock
// read as UTC; a zero or impossible date is an Invalid Date.
func mysqlDateTime(text []byte) float64 {
	dt, n, ok := parseWallClock(text, false, true)
	if !ok || n != len(text) {
		return math.NaN()
	}
	if dt.month < 1 || dt.month > 12 || dt.day < 1 || dt.day > daysIn(dt.year, dt.month) ||
		dt.hour > 23 || dt.minute > 59 || dt.second > 59 {
		return math.NaN()
	}
	return dt.msUTC()
}

func daysIn(year, month int) int {
	return time.Date(year, time.Month(month)+1, 0, 0, 0, 0, 0, time.UTC).Day()
}
