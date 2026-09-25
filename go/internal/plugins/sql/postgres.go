package sql

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// connectTimeout is Bun.SQL's default connection timeout.
const connectTimeout = 30 * time.Second

// postgresDB is Bun.SQL's PostgreSQL adapter for sql.unsafe(query) with no
// parameters: the simple query protocol, so every value arrives as text and
// several statements may run in one call.
type postgresDB struct {
	opts serverOptions
	conn *pgconn.PgConn
}

func newPostgres(opts serverOptions) *postgresDB { return &postgresDB{opts: opts} }

func (p *postgresDB) close() {
	if p.conn != nil {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = p.conn.Close(ctx)
		p.conn = nil
	}
}

// pgQuote quotes a keyword/value connection string value.
func pgQuote(s string) string {
	return "'" + strings.NewReplacer(`\`, `\\`, `'`, `\'`).Replace(s) + "'"
}

var pgSSLModes = map[sslMode]string{
	sslDisable: "disable", sslPrefer: "prefer", sslRequire: "require",
	sslVerifyCA: "verify-ca", sslVerifyFull: "verify-full",
}

// config is the pgconn configuration for Bun's resolved options. The
// startup parameters are Bun's: client_encoding UTF8, DateStyle "ISO, MDY",
// and the URL's other query parameters.
func (p *postgresDB) config() (*pgconn.Config, error) {
	o := p.opts
	// Every setting libpq would otherwise take from HOME (client certificates,
	// root.crt) is given, empty; its environment is set aside while parsing.
	dsn := fmt.Sprintf("host=%s port=%d user=%s dbname=%s sslmode=%s connect_timeout=%d "+
		"sslrootcert='' sslcert='' sslkey='' sslpassword='' sslsni='' sslnegotiation='' target_session_attrs=any",
		pgQuote(o.hostname), o.port, pgQuote(o.username), pgQuote(o.database), pgSSLModes[o.sslMode], int(connectTimeout/time.Second))
	cfg, err := parseWithoutLibpqEnv(dsn)
	if err != nil {
		return nil, err
	}
	cfg.Password = o.password
	for _, fb := range cfg.Fallbacks {
		fb.Host, fb.Port = o.hostname, uint16(o.port)
	}
	cfg.RuntimeParams = map[string]string{"client_encoding": "UTF8", "DateStyle": "ISO, MDY"}
	for _, kv := range o.params {
		cfg.RuntimeParams[kv[0]] = kv[1]
	}
	if o.path != "" {
		path := o.path
		cfg.DialFunc = func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", path)
		}
	}
	return cfg, nil
}

// libpqEnv are the variables pgconn.ParseConfig reads (parseEnvSettings).
// Bun's SQL reads only its own list, which serverOptionsFor has applied.
var libpqEnv = []string{
	"PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD", "PGPASSFILE", "PGAPPNAME",
	"PGCONNECT_TIMEOUT", "PGSSLMODE", "PGSSLKEY", "PGSSLCERT", "PGSSLSNI", "PGSSLROOTCERT",
	"PGSSLPASSWORD", "PGSSLNEGOTIATION", "PGTARGETSESSIONATTRS", "PGSERVICE", "PGSERVICEFILE",
	"PGTZ", "PGOPTIONS",
}

var libpqEnvMu sync.Mutex

// parseWithoutLibpqEnv is pgconn.ParseConfig(dsn) in an environment without
// libpqEnv, which is put back afterwards.
func parseWithoutLibpqEnv(dsn string) (*pgconn.Config, error) {
	libpqEnvMu.Lock()
	defer libpqEnvMu.Unlock()
	for _, name := range libpqEnv {
		if v, ok := os.LookupEnv(name); ok {
			os.Unsetenv(name)
			defer os.Setenv(name, v)
		}
	}
	return pgconn.ParseConfig(dsn)
}

func (p *postgresDB) connect(ctx context.Context) error {
	if p.conn != nil {
		return nil
	}
	cfg, err := p.config()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, connectTimeout)
	defer cancel()
	conn, err := pgconn.ConnectConfig(ctx, cfg)
	if err != nil {
		return connectError(ctx, err)
	}
	p.conn = conn
	return nil
}

// connectError is the message Bun rejects with when a connection fails.
func connectError(ctx context.Context, err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return errors.New(pgErrorMessage(pgErr))
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

// pgErrorMessage is ErrorResponse.toJS: the M field, or else the detail and
// hint.
func pgErrorMessage(e *pgconn.PgError) string {
	if e.Message != "" {
		return e.Message
	}
	var b strings.Builder
	for _, part := range []string{e.Detail, e.Hint} {
		if part == "" {
			continue
		}
		if b.Len() > 0 {
			b.WriteString("\n")
		} else {
			b.WriteString(" ")
		}
		b.WriteString(part)
	}
	return b.String()
}

func (p *postgresDB) unsafe(ctx context.Context, query string) ([]any, error) {
	if err := p.connect(ctx); err != nil {
		return nil, err
	}
	return p.exec(ctx, query)
}

// readOnly is sql.begin('read only', tx => tx.unsafe(query)): BEGIN read
// only, the query, COMMIT; ROLLBACK when the query fails.
func (p *postgresDB) readOnly(ctx context.Context, query string) ([]any, error) {
	if err := p.connect(ctx); err != nil {
		return nil, err
	}
	if _, err := p.exec(ctx, "BEGIN read only"); err != nil {
		return nil, err
	}
	rows, err := p.exec(ctx, query)
	if err != nil {
		_, _ = p.exec(ctx, "ROLLBACK")
		return nil, err
	}
	if _, err := p.exec(ctx, "COMMIT"); err != nil {
		return nil, err
	}
	return rows, nil
}

// exec runs the text and gathers its results: one statement's rows, or, for
// several statements, one array of rows per statement.
func (p *postgresDB) exec(ctx context.Context, query string) ([]any, error) {
	var results [][]any
	var firstErr error
	mrr := p.conn.Exec(ctx, query)
	for mrr.NextResult() {
		rr := mrr.ResultReader()
		fields := rr.FieldDescriptions()
		columns := make([]column, len(fields))
		for i, f := range fields {
			columns[i] = serverColumn(f.Name)
		}
		rows := []any{}
		for rr.NextRow() {
			if firstErr != nil {
				continue
			}
			raw := rr.Values()
			values := make([]any, len(raw))
			for i, b := range raw {
				if b == nil || i >= len(fields) {
					continue
				}
				v, err := decodePostgresText(fields[i].DataTypeOID, b)
				if err != nil {
					firstErr = err
					break
				}
				values[i] = v
			}
			rows = append(rows, buildRow(columns, values))
		}
		if _, err := rr.Close(); err != nil && firstErr == nil {
			firstErr = queryError(err)
		}
		results = append(results, rows)
	}
	if err := mrr.Close(); err != nil && firstErr == nil {
		firstErr = queryError(err)
	}
	if firstErr != nil {
		return nil, firstErr
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

func queryError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return errors.New(pgErrorMessage(pgErr))
	}
	if pgconn.SafeToRetry(err) || errors.Is(err, net.ErrClosed) {
		return errors.New("Connection closed")
	}
	return err
}
