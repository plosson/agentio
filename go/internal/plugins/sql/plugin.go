// Package sql is the SQL service: a profile stores one connection URL
// (PostgreSQL, MySQL/MariaDB or SQLite, as Bun.SQL reads it) and `query` runs
// a statement against it. A read-only profile runs its query inside a
// read-only scope instead of being refused.
package sql

import (
	"context"
	"fmt"
	"math"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
)

func New() *plugins.Plugin {
	return &plugins.Plugin{
		APIVersion:  plugins.APIVersion,
		ID:          "sql",
		DisplayName: "SQL",
		Description: "Use when running SQL queries via the agentio CLI.",
		Profile: &plugins.ProfileSpec{
			Setup:    setup,
			Validate: validate,
			// A connection URL does not expire: no refresh lifecycle, no
			// secret fields, and the hub serves the whole credential map.
			ListInfo: listInfo,
			SetupOptions: []plugins.OptionSpec{
				{Flags: "--interactive", Description: "Interactive mode: prompt for individual connection components"},
			},
		},
		Commands: []plugins.CommandSpec{queryCmd()},
	}
}

// listInfo is Bun getExtraInfo.
func listInfo(creds map[string]any) string {
	if name := creds["displayName"]; jsvalue.Truthy(name) {
		return " - " + jsvalue.String(name)
	}
	return ""
}

// validate is SqlClient.validate: `SELECT 1` on the stored connection.
func validate(ctx context.Context, run *plugins.RunContext) (plugins.ValidationResult, error) {
	c, err := newClient(run.Credentials)
	if err != nil {
		return plugins.ValidationResult{}, err
	}
	defer c.close()
	return c.validate(ctx), nil
}

func queryCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "query",
		Description: "Execute a SQL query",
		// No enforceWriteAccess: a read-only profile runs the query in a
		// read-only scope (RunContext.ReadOnly).
		Access:    "read",
		Input:     "text",
		Arguments: []plugins.ArgumentSpec{{Name: "query", Description: "SQL query (or pipe via stdin)"}},
		Options: []plugins.OptionSpec{
			{Flags: "--limit <n>", Description: "Maximum rows to return", DefaultValue: "100"},
		},
		Examples: []string{
			"# one-shot SELECT against the default profile",
			`agentio sql query "SELECT id, email FROM users LIMIT 10"`,
			"# cap rows for an exploratory query",
			`agentio sql query "SELECT * FROM events" --limit 25`,
			"# pipe a multi-line query via stdin",
			"cat report.sql | agentio sql query",
			"# run against a specific profile",
			`agentio sql query --profile prod "SELECT count(*) FROM orders"`,
		},
		Prepare: plugins.Parse(readQuery),
		Run:     runQuery,
		Format:  formatResult,
	}
}

// queryInput is the query and --limit, read before getSqlClient as in Bun.
type queryInput struct {
	text  string
	limit float64
}

func readQuery(in plugins.CommandInput, fail plugins.FailFunc) (queryInput, error) {
	query := in.Arg("query")
	if query == "" {
		query = plugins.Stdin(in)
	}
	if query == "" {
		return queryInput{}, fail("INVALID_PARAMS", "Query is required. Provide as argument or pipe via stdin.", "")
	}
	limit := jsvalue.ParseInt(in.Option("limit"))
	if math.IsNaN(limit) || limit <= 0 {
		return queryInput{}, fail("INVALID_PARAMS", "Limit must be a positive number", "")
	}
	return queryInput{text: query, limit: limit}, nil
}

func runQuery(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
	q := plugins.Prepared[queryInput](run)
	c, err := newClient(run.Credentials)
	if err != nil {
		return nil, err
	}
	defer c.close()
	return plugins.Result(c.query(ctx, q.text, q.limit, run.ReadOnly, run.Fail))
}

// setup is sqlProfileAdd: the URL is checked with `SELECT 1` before the
// profile is saved, and the suggested name is the connection's display name.
func setup(ctx context.Context, opts plugins.SetupOptions, setup *plugins.SetupContext) (*plugins.SetupResult, error) {
	var url string
	if opts.Flag("interactive") {
		var err error
		if url, err = promptInteractiveConnection(setup); err != nil {
			return nil, err
		}
	} else {
		setup.Log("\nSQL Database Setup\n")
		setup.Log("Enter your database connection URL.")
		setup.Log("Supported formats:")
		setup.Log("  PostgreSQL: postgres://user:password@host:5432/database")
		setup.Log("  MySQL:      mysql://user:password@host:3306/database")
		setup.Log("  SQLite:     sqlite:///path/to/database.db\n")
		setup.Log("Tip: Use --interactive to enter components separately (handles special characters)\n")
		url = ask(setup, "? Connection URL: ")
		if url == "" {
			return nil, setup.Fail("INVALID_PARAMS", "Connection URL is required", "")
		}
	}

	setup.Log("\nValidating connection...")
	c, err := newClient(map[string]any{"url": url})
	if err != nil {
		return nil, err
	}
	_, err = c.query(ctx, "SELECT 1", defaultLimit, false, setup.Fail)
	c.close()
	if err != nil {
		return nil, err
	}

	displayName := extractDisplayName(url)
	setup.Log(fmt.Sprintf("\nConnected to: %s\n", displayName))
	return &plugins.SetupResult{
		Credentials:          map[string]any{"url": url, "displayName": displayName},
		SuggestedProfileName: displayName,
		Info:                 `Test with: agentio sql query "SELECT 1"`,
	}, nil
}

// ask is Bun prompt(): the answer trimmed; no answer is "".
func ask(setup *plugins.SetupContext, question string) string {
	answer, _ := setup.Prompt(question, false)
	return jsvalue.Trim(answer)
}

// extractDisplayName is user@host/database from the URL, or its first 30
// characters when new URL() throws.
func extractDisplayName(url string) string {
	u, err := parseURL(url)
	if err != nil {
		return jsvalue.Slice(url, 30)
	}
	username := ""
	if u.username != "" {
		decoded, ok := jsvalue.DecodeURIComponent(u.username)
		if !ok {
			return jsvalue.Slice(url, 30)
		}
		username = decoded
	}
	host := u.hostname
	if host == "" {
		host = "localhost"
	}
	db := strings.TrimPrefix(u.pathname, "/")
	if db == "" {
		db = "database"
	}
	if username != "" {
		return username + "@" + host + "/" + db
	}
	return host + "/" + db
}

var dbTypes = []struct{ value, name, description, port string }{
	{"postgres", "PostgreSQL", "Default port 5432", "5432"},
	{"mysql", "MySQL", "Default port 3306", "3306"},
	{"sqlite", "SQLite", "Local file database", ""},
}

// promptInteractiveConnection asks for each part and builds the URL with
// encodeURIComponent. Bun's arrow-key select is a numbered prompt here, as
// the other ported selects are.
func promptInteractiveConnection(setup *plugins.SetupContext) (string, error) {
	setup.Log("\nSQL Database Setup (Interactive)\n")
	question := "Select database type:"
	for i, t := range dbTypes {
		question += fmt.Sprintf("\n  %d) %s — %s", i+1, t.name, t.description)
	}
	answer, err := setup.Prompt(question, false)
	answer = strings.ToLower(strings.TrimSpace(answer))
	if err != nil || answer == "" {
		return "", setup.Fail("INVALID_PARAMS", "Interactive input required but not running in terminal", "Run this command in an interactive terminal")
	}
	chosen := -1
	for i, t := range dbTypes {
		if answer == fmt.Sprint(i+1) || answer == t.value || answer == strings.ToLower(t.name) {
			chosen = i
		}
	}
	if chosen < 0 {
		return "", setup.Fail("INVALID_PARAMS", fmt.Sprintf("Unknown database type %q", answer), "Choose one of the listed types")
	}
	dbType := dbTypes[chosen]

	if dbType.value == "sqlite" {
		path := ask(setup, "? Database file path: ")
		if path == "" {
			return "", setup.Fail("INVALID_PARAMS", "Database path is required", "")
		}
		return "sqlite://" + path, nil
	}

	host := ask(setup, "? Host (e.g., localhost): ")
	if host == "" {
		return "", setup.Fail("INVALID_PARAMS", "Host is required", "")
	}
	port := ask(setup, fmt.Sprintf("? Port [%s]: ", dbType.port))
	if port == "" {
		port = dbType.port
	}
	database := ask(setup, "? Database name: ")
	if database == "" {
		return "", setup.Fail("INVALID_PARAMS", "Database name is required", "")
	}
	username := ask(setup, "? Username: ")
	if username == "" {
		return "", setup.Fail("INVALID_PARAMS", "Username is required", "")
	}
	password := ask(setup, "? Password: ")

	userinfo := jsvalue.EncodeURIComponent(username)
	if password != "" {
		userinfo += ":" + jsvalue.EncodeURIComponent(password)
	}
	return fmt.Sprintf("%s://%s@%s:%s/%s", dbType.value, userinfo, host, port, jsvalue.EncodeURIComponent(database)), nil
}
