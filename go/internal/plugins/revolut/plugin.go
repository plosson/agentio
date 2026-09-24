// Package revolut is the Revolut Business service.
package revolut

import (
	"context"
	"crypto/rand"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/nodefs"
	"github.com/plosson/agentio/go/internal/plugins"
)

func New() *plugins.Plugin {
	return &plugins.Plugin{
		APIVersion:  plugins.APIVersion,
		ID:          "revolut",
		DisplayName: "Revolut",
		Description: "Use when interacting with Revolut Business via the agentio CLI.",
		Profile: &plugins.ProfileSpec{
			Setup:          setup,
			Validate:       validate,
			Reauthenticate: reauth,
			ListInfo:       listInfo,
			SetupOptions: []plugins.OptionSpec{
				{Flags: "--environment <env>", Description: "production or sandbox"},
				{Flags: "--client-id <id>", Description: "Client ID issued by Revolut"},
				{Flags: "--private-key <path>", Description: "Path to the PEM private key matching your uploaded certificate"},
				{Flags: "--redirect-uri <uri>", Description: "OAuth redirect URI registered with Revolut"},
			},
			Refresh: &plugins.RefreshSpec{
				// The private key signs every token request: whoever holds it
				// and the refresh token can mint access tokens.
				SecretFields: []string{"refreshToken", "privateKey"},
				Applies:      applies,
				IsStale:      stale,
				Run:          refresh,
			},
		},
		Commands: []plugins.CommandSpec{
			accountsCmd(), transactionsCmd(), transactionCmd(), expensesCmd(), expenseCmd(), receiptCmd(), payCmd(),
			counterpartiesListCmd(), counterpartiesGetCmd(), counterpartiesAddCmd(), counterpartiesDeleteCmd(),
			draftsListCmd(), draftsGetCmd(), draftsDeleteCmd(),
			linksListCmd(), linksGetCmd(), linksCancelCmd(),
		},
	}
}

// --- credential lifecycle -------------------------------------------------------

func applies(creds map[string]any) bool {
	return creds != nil && truthy(credential(creds, "refreshToken"))
}

// stale is `expiryDate === undefined || now + bufferMs >= expiryDate`.
// Access tokens live 40 minutes.
func stale(creds map[string]any, nowMs, bufferMs int64) bool {
	expiry := credential(creds, "expiryDate")
	return expiry == undefined || float64(nowMs+bufferMs) >= num(expiry)
}

// refresh keeps the refresh token: Revolut does not rotate it.
func refresh(ctx context.Context, creds map[string]any) (map[string]any, error) {
	t, err := refreshRevolutToken(ctx, defaultFetch, creds)
	if err != nil {
		return nil, err
	}
	return withTokens(creds, t, true, time.Now().UnixMilli()), nil
}

// listInfo is getExtraInfo: " - <environment>".
func listInfo(creds map[string]any) string {
	if creds == nil {
		return ""
	}
	return " - " + text(credential(creds, "environment"))
}

// --- profile add and reauthentication -------------------------------------------

// promptText is Bun's prompt(): the answer trimmed, a closed stdin empty.
func promptText(setup *plugins.SetupContext, question string) string {
	answer, _ := setup.Prompt(question, false)
	return jsvalue.Trim(answer)
}

func parseEnvironment(value string) (string, error) {
	switch strings.ToLower(jsvalue.Trim(value)) {
	case "production", "prod":
		return "production", nil
	case "sandbox":
		return "sandbox", nil
	}
	return "", &apiError{code: "INVALID_PARAMS", message: fmt.Sprintf(`Unknown environment "%s"`, value), suggestion: "Use production or sandbox"}
}

func expandPath(path string) string {
	home, _ := os.UserHomeDir()
	if path == "~" {
		return home
	}
	if strings.HasPrefix(path, "~/") {
		return home + "/" + path[2:]
	}
	return path
}

// readPrivateKey reads the PEM and refuses anything that is not a private key.
func readPrivateKey(path string) (string, error) {
	raw, err := nodefs.ReadFile(expandPath(path))
	if err != nil {
		return "", &apiError{code: "INVALID_PARAMS", message: "Could not read the private key: " + err.Error()}
	}
	pemText := jsvalue.BufferString(raw)
	if _, err := signingKey(pemText); err != nil {
		return "", &apiError{
			code:       "INVALID_PARAMS",
			message:    fmt.Sprintf(`The file "%s" is not a valid PEM private key`, path),
			suggestion: "Point --private-key at the key you generated alongside the certificate uploaded to Revolut",
		}
	}
	return pemText, nil
}

func setup(ctx context.Context, opts plugins.SetupOptions, setup *plugins.SetupContext) (*plugins.SetupResult, error) {
	res, err := runSetup(ctx, opts, setup)
	if err != nil {
		return nil, failed(setup.Fail, err)
	}
	return res, nil
}

// orPrompt is `option || await prompt(question)`.
func orPrompt(setup *plugins.SetupContext, value, question string) string {
	if value != "" {
		return value
	}
	return promptText(setup, question)
}

func runSetup(ctx context.Context, opts plugins.SetupOptions, setup *plugins.SetupContext) (*plugins.SetupResult, error) {
	setup.Log("\nRevolut Business Setup\n")
	setup.Log("Prerequisite: in the Revolut Business app, go to Settings > APIs > Business API,")
	setup.Log("upload your X.509 public certificate, and register an OAuth redirect URI.\n")

	envAnswer := orPrompt(setup, opts.Option("environment"), "? Environment (production/sandbox) [production]: ")
	if envAnswer == "" {
		envAnswer = "production"
	}
	environment, err := parseEnvironment(envAnswer)
	if err != nil {
		return nil, err
	}
	clientID := jsvalue.Trim(orPrompt(setup, opts.Option("client-id"), "? Client ID: "))
	if clientID == "" {
		return nil, &apiError{code: "INVALID_PARAMS", message: "Client ID is required"}
	}
	keyPath := orPrompt(setup, opts.Option("private-key"), "? Path to private key (PEM): ")
	if keyPath == "" {
		return nil, &apiError{code: "INVALID_PARAMS", message: "Private key path is required"}
	}
	privateKey, err := readPrivateKey(keyPath)
	if err != nil {
		return nil, err
	}
	redirectURI := jsvalue.Trim(orPrompt(setup, opts.Option("redirect-uri"), "? OAuth redirect URI: "))
	if redirectURI == "" {
		return nil, &apiError{code: "INVALID_PARAMS", message: "Redirect URI is required"}
	}
	if _, err := issuerFromRedirectURI(redirectURI); err != nil {
		return nil, err
	}
	consentURL, err := buildConsentURL(environment, clientID, redirectURI)
	if err != nil {
		return nil, err
	}

	setup.Log("\nAuthorise the app in your browser:")
	setup.Log("  " + consentURL + "\n")
	setup.Log(fmt.Sprintf(`After approving, the browser is redirected to %s with a "code" parameter.`, redirectURI))
	setup.Log("That page does not need to load - copy the address bar contents.\n")
	setup.Log("The code expires about two minutes after it is issued.\n")
	setup.OpenURL(consentURL)

	code, err := extractAuthorizationCode(promptText(setup, "? Paste the redirect URL (or just the code): "))
	if err != nil {
		return nil, err
	}
	setup.Log("\nExchanging the authorisation code...")
	cfg := clientConfig{environment: environment, clientID: clientID, privateKey: privateKey, redirectURI: redirectURI}
	t, err := exchangeCodeForTokens(ctx, setup.Fetch, code, cfg)
	if err != nil {
		return nil, err
	}
	creds := withTokens(map[string]any{
		"environment": environment,
		"clientId":    clientID,
		"privateKey":  privateKey,
		"redirectUri": redirectURI,
	}, t, false, time.Now().UnixMilli())

	setup.Log("Validating access...")
	validation := newClient(ctx, creds, setup.Fetch).validate()
	if !validation.Valid {
		return nil, &apiError{code: "AUTH_FAILED", message: "Could not read accounts: " + validation.Error}
	}
	setup.Log("\nConnected to Revolut " + environment)
	setup.Log(validation.Info + "\n")
	return &plugins.SetupResult{Credentials: creds, SuggestedProfileName: environment, Info: "Test with: agentio revolut accounts"}, nil
}

// reauth runs the consent flow again with the stored client configuration.
func reauth(ctx context.Context, creds map[string]any, profileName string, setup *plugins.SetupContext) (map[string]any, error) {
	replacement, err := runReauth(ctx, creds, profileName, setup)
	if err != nil {
		return nil, failed(setup.Fail, err)
	}
	return replacement, nil
}

func runReauth(ctx context.Context, creds map[string]any, profileName string, setup *plugins.SetupContext) (map[string]any, error) {
	if creds == nil {
		return nil, &apiError{code: "AUTH_FAILED", message: "Revolut client configuration is missing"}
	}
	setup.Log(fmt.Sprintf("\nRe-authenticating revolut / %s...", profileName))
	cfg := configOf(creds)
	consentURL, err := buildConsentURL(cfg.environment, text(cfg.clientID), cfg.redirectURI)
	if err != nil {
		return nil, err
	}
	setup.Log("  " + consentURL + "\n")
	setup.OpenURL(consentURL)
	code, err := extractAuthorizationCode(promptText(setup, "? Paste the redirect URL (or just the code): "))
	if err != nil {
		return nil, err
	}
	t, err := exchangeCodeForTokens(ctx, setup.Fetch, code, cfg)
	if err != nil {
		return nil, err
	}
	replacement := withTokens(creds, t, false, time.Now().UnixMilli())
	validation := newClient(ctx, replacement, setup.Fetch).validate()
	if !validation.Valid {
		return nil, &apiError{code: "AUTH_FAILED", message: "Could not read accounts: " + validation.Error}
	}
	setup.Log(fmt.Sprintf("  Done (%s)", validation.Info))
	return replacement, nil
}

// --- commands ---------------------------------------------------------------------

func clientOf(ctx context.Context, run *plugins.RunContext) *client {
	return newClient(ctx, run.Credentials, run.Fetch)
}

var formatOption = plugins.OptionSpec{Flags: "--format <format>", Description: "Output format: text or json", DefaultValue: "text"}

// positiveInt is `parseInt(value, 10)` refusing NaN and anything below 1.
func positiveInt(fail plugins.FailFunc, flag, value string) (float64, error) {
	n := jsvalue.ParseInt(value)
	if math.IsNaN(n) || n < 1 {
		return 0, fail("INVALID_PARAMS", flag+" must be a positive number", "")
	}
	return n, nil
}

// confirmed asks before a destructive call. A closed stdin never answers in
// Bun, so the process ends without acting or printing "Cancelled".
func confirmed(run *plugins.RunContext, question string) bool {
	ok, err := run.Confirm(question)
	if err != nil {
		return false
	}
	if !ok {
		run.Log("Cancelled")
	}
	return ok
}

func accountsCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "accounts",
		Description: "List accounts and balances",
		Access:      "read",
		Options:     []plugins.OptionSpec{formatOption},
		Examples: []string{
			"# all accounts with balances",
			"agentio revolut accounts",
			"# machine-readable balances",
			"agentio revolut accounts --format json",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			accounts, err := clientOf(ctx, run).listAccounts()
			if err != nil {
				return nil, failed(run.Fail, err)
			}
			return &view{value: values(accounts), asJSON: in.Option("format") == "json", text: func() string { return accountListText(accounts) }}, nil
		},
		Format: formatView,
	}
}

func transactionsCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "transactions",
		Description: "List transactions",
		Access:      "read",
		Options: []plugins.OptionSpec{
			{Flags: "--from <date>", Description: "Start date (YYYY-MM-DD)"},
			{Flags: "--to <date>", Description: "End date (YYYY-MM-DD)"},
			{Flags: "--account <id>", Description: "Filter by account ID"},
			{Flags: "--counterparty <id>", Description: "Filter by counterparty ID"},
			{Flags: "--type <type>", Description: "Filter by type (e.g. card_payment, transfer, exchange)"},
			{Flags: "--count <number>", Description: "Maximum transactions to return (max 1000)", DefaultValue: "100"},
			{Flags: "--format <format>", Description: "Output format: text, json, or csv", DefaultValue: "text"},
		},
		Examples: []string{
			"# most recent transactions",
			"agentio revolut transactions",
			"# a date range, one leg per CSV row",
			"agentio revolut transactions --from 2026-04-01 --to 2026-06-30 --format csv",
			"# card payments only, on one account",
			"agentio revolut transactions --type card_payment --account 8f9d1e2a-0000-4c3b-9f21-7a5e6d4c3b2a",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			count, err := positiveInt(run.Fail, "--count", in.Option("count"))
			if err != nil {
				return nil, err
			}
			transactions, err := clientOf(ctx, run).listTransactions(transactionFilter{
				from: in.Option("from"), to: in.Option("to"), account: in.Option("account"),
				counterparty: in.Option("counterparty"), kind: in.Option("type"), count: count,
			})
			if err != nil {
				return nil, failed(run.Fail, err)
			}
			format := in.Option("format")
			return &view{value: values(transactions), asJSON: format == "json", text: func() string {
				if format == "csv" {
					return transactionsCSV(transactions)
				}
				return transactionListText(transactions)
			}}, nil
		},
		Format: formatView,
	}
}

func transactionCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "transaction",
		Description: "Get one transaction with its legs",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{{Name: "id", Description: "Transaction ID", Required: true}},
		Options:     []plugins.OptionSpec{formatOption},
		Examples: []string{
			"# full detail for one transaction",
			"agentio revolut transaction 6b8e1f30-1c2d-4a5b-8e9f-0a1b2c3d4e5f",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			t, err := clientOf(ctx, run).getTransaction(in.Arg("id"))
			if err != nil {
				return nil, failed(run.Fail, err)
			}
			return &view{value: t, asJSON: in.Option("format") == "json", text: func() string { return transactionText(t) }}, nil
		},
		Format: formatView,
	}
}

// uniqueFilename keeps two receipts that report the same file name from
// clobbering each other.
func uniqueFilename(used map[string]bool, filename string) string {
	if !used[filename] {
		used[filename] = true
		return filename
	}
	stem, extension := filename, ""
	if dot := strings.LastIndex(filename, "."); dot > 0 {
		stem, extension = filename[:dot], filename[dot:]
	}
	for suffix := 2; ; suffix++ {
		candidate := fmt.Sprintf("%s-%d%s", stem, suffix, extension)
		if !used[candidate] {
			used[candidate] = true
			return candidate
		}
	}
}

// writeFile is Bun.write: missing parent directories are created.
func writeFile(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o777); err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o666)
}

// downloadReceipts is the bulk export behind expenses --receipts. Progress
// goes to stderr so the listing on stdout stays pipeable, and one unreachable
// receipt does not abandon the rest.
func downloadReceipts(c *client, run *plugins.RunContext, expenses []*jsvalue.Object, directory string) {
	var withReceipts []*jsvalue.Object
	for _, e := range expenses {
		if len(receiptIDs(e)) > 0 {
			withReceipts = append(withReceipts, e)
		}
	}
	if len(withReceipts) == 0 {
		run.Log("No receipts to download")
		return
	}
	used := map[string]bool{}
	downloaded, failedCount := 0, 0
	for _, e := range withReceipts {
		expenseID := text(field(e, "id"))
		for _, id := range receiptIDs(e) {
			receiptID := text(id)
			r, err := c.getReceipt(expenseID, receiptID)
			if err == nil {
				err = writeFile(filepath.Join(directory, uniqueFilename(used, expenseID+"-"+r.filename)), r.data)
			}
			if err != nil {
				failedCount++
				run.Log(fmt.Sprintf("Failed to download receipt %s of expense %s: %s", receiptID, expenseID, err.Error()))
				continue
			}
			downloaded++
		}
	}
	summary := fmt.Sprintf("Downloaded %d receipt(s) to %s", downloaded, directory)
	if failedCount > 0 {
		summary += fmt.Sprintf(", %d failed", failedCount)
	}
	run.Log(summary)
}

func expensesCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "expenses",
		Description: "List expenses and their receipt counts",
		Access:      "read",
		Options: []plugins.OptionSpec{
			{Flags: "--from <date>", Description: "Start date (YYYY-MM-DD)"},
			{Flags: "--to <date>", Description: "End date (YYYY-MM-DD)"},
			{Flags: "--count <number>", Description: "Maximum expenses to return (max 500)", DefaultValue: "100"},
			{Flags: "--receipts <dir>", Description: "Also download every receipt into this directory"},
			{Flags: "--format <format>", Description: "Output format: text, json, or csv", DefaultValue: "text"},
		},
		Examples: []string{
			"# this month's expenses",
			"agentio revolut expenses --from 2026-09-01",
			"# a quarter as CSV, for the books",
			"agentio revolut expenses --from 2026-07-01 --to 2026-09-30 --format csv",
			"# the same quarter, with every receipt file alongside it",
			"agentio revolut expenses --from 2026-07-01 --to 2026-09-30 --format csv --receipts ./q3-receipts > q3.csv",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			count, err := positiveInt(run.Fail, "--count", in.Option("count"))
			if err != nil {
				return nil, err
			}
			c := clientOf(ctx, run)
			expenses, err := c.listExpenses(in.Option("from"), in.Option("to"), count)
			if err != nil {
				return nil, failed(run.Fail, err)
			}
			if dir := in.Option("receipts"); dir != "" {
				downloadReceipts(c, run, expenses, dir)
			}
			format := in.Option("format")
			return &view{value: values(expenses), asJSON: format == "json", text: func() string {
				if format == "csv" {
					return expensesCSV(expenses)
				}
				return expenseListText(expenses)
			}}, nil
		},
		Format: formatView,
	}
}

func expenseCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "expense",
		Description: "Get one expense with its receipt IDs",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{{Name: "id", Description: "Expense ID", Required: true}},
		Options:     []plugins.OptionSpec{formatOption},
		Examples: []string{
			"# full detail, including the receipt IDs",
			"agentio revolut expense 4a5b6c7d-8e9f-0a1b-2c3d-4e5f6a7b8c9d",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			e, err := clientOf(ctx, run).getExpense(in.Arg("id"))
			if err != nil {
				return nil, failed(run.Fail, err)
			}
			return &view{value: e, asJSON: in.Option("format") == "json", text: func() string { return expenseText(e) }}, nil
		},
		Format: formatView,
	}
}

// saved is one receipt written by `receipt`.
type saved struct {
	Filename string `json:"filename"`
	Path     string `json:"path"`
	Size     int    `json:"size"`
}

// receipts is the `receipt` output: the files written so far, out of total.
type receipts struct {
	files []saved
	total int
}

func (r *receipts) MarshalJSON() ([]byte, error) { return jsvalue.Stringify(r.files), nil }

func formatReceipts(v any) string {
	r, ok := v.(*receipts)
	if !ok {
		return ""
	}
	if r.total == 0 {
		return "No receipts found"
	}
	var l lines
	if r.total > 1 {
		l.add("Downloading ", itoa(r.total), " receipt(s)...\n")
	}
	for _, f := range r.files {
		downloaded(&l, f.Filename, f.Path, f.Size)
		if r.total > 1 {
			l.add("")
		}
	}
	return l.String()
}

func receiptCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "receipt",
		Description: "Download the receipt files attached to an expense",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{{Name: "expense-id", Description: "Expense ID", Required: true}},
		Options: []plugins.OptionSpec{
			{Flags: "--receipt <id>", Description: "Download one receipt by ID (downloads all if not specified)"},
			{Flags: "--output <dir>", Description: "Output directory", DefaultValue: "."},
		},
		Examples: []string{
			"# every receipt on one expense, into the current directory",
			"agentio revolut receipt 4a5b6c7d-8e9f-0a1b-2c3d-4e5f6a7b8c9d",
			"# one receipt, into a folder",
			"agentio revolut receipt 4a5b6c7d-8e9f-0a1b-2c3d-4e5f6a7b8c9d \\",
			"  --receipt 9f8e7d6c-5b4a-3210-9876-543210fedcba --output ./receipts",
		},
		Run:    runReceipt,
		Format: formatReceipts,
	}
}

func runReceipt(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
	expenseID, only := in.Arg("expense-id"), in.Option("receipt")
	c := clientOf(ctx, run)
	e, err := c.getExpense(expenseID)
	if err != nil {
		return nil, failed(run.Fail, err)
	}
	var ids []string
	for _, id := range receiptIDs(e) {
		if only == "" || strictEqual(id, only) {
			ids = append(ids, text(id))
		}
	}
	if only != "" && len(ids) == 0 {
		return nil, run.Fail("NOT_FOUND", fmt.Sprintf(`Expense %s has no receipt "%s"`, expenseID, only), "Run: agentio revolut expense "+expenseID)
	}
	// Bun prints the header before the first download and each file as it
	// lands, so a failure part-way keeps what was already on stdout.
	res := &receipts{total: len(ids)}
	used := map[string]bool{}
	for _, receiptID := range ids {
		r, err := c.getReceipt(expenseID, receiptID)
		if err == nil {
			name := uniqueFilename(used, r.filename)
			path := filepath.Join(in.Option("output"), name)
			if err = writeFile(path, r.data); err == nil {
				res.files = append(res.files, saved{Filename: name, Path: path, Size: len(r.data)})
				continue
			}
		}
		if len(res.files) == 0 && res.total < 2 {
			return nil, failed(run.Fail, err)
		}
		return res, failed(run.Fail, err)
	}
	return res, nil
}

// --- pay ----------------------------------------------------------------------------

var isoDate = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// payInput is what Bun checks before resolving the profile.
type payInput struct {
	amount       float64
	currency     string
	chargeBearer string
}

func payInputOf(in plugins.CommandInput, fail plugins.FailFunc) (payInput, error) {
	if err := plugins.RequireOptions(in, fail, "--from <account-id>", "--to <id>", "--amount <number>", "--currency <code>"); err != nil {
		return payInput{}, err
	}
	if on := in.Option("on"); on != "" && !isoDate.MatchString(on) {
		return payInput{}, fail("INVALID_PARAMS", fmt.Sprintf(`--on must be a date as YYYY-MM-DD, got "%s"`, on), "")
	}
	value := in.Option("amount")
	amount := jsvalue.Number(value)
	if math.IsNaN(amount) || math.IsInf(amount, 0) || amount <= 0 {
		return payInput{}, fail("INVALID_PARAMS", fmt.Sprintf(`--amount must be a positive number, got "%s"`, value), "")
	}
	p := payInput{amount: amount, currency: strings.ToUpper(jsvalue.Trim(in.Option("currency")))}
	if bearer := in.Option("charge-bearer"); bearer != "" {
		normalized := strings.ToLower(jsvalue.Trim(bearer))
		if normalized != "shared" && normalized != "debtor" {
			return payInput{}, fail("INVALID_PARAMS", fmt.Sprintf(`Unknown charge bearer "%s"`, bearer),
				"Use shared (SHA, fees split) or debtor (OUR, you pay all fees)")
		}
		p.chargeBearer = normalized
	}
	return p, nil
}

func payCheck(in plugins.CommandInput, fail plugins.FailFunc) error {
	_, err := payInputOf(in, fail)
	return err
}

func describeAccount(a *jsvalue.Object) string {
	if name := field(a, "name"); truthy(name) {
		return `"` + text(name) + `"`
	}
	return text(field(a, "id"))
}

func findAccount(accounts []*jsvalue.Object, id string) *jsvalue.Object {
	for _, a := range accounts {
		if s, ok := field(a, "id").(string); ok && s == id {
			return a
		}
	}
	return nil
}

// randomUUID is crypto.randomUUID(): a version 4 UUID.
func randomUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func payCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "pay",
		Description: "Draft a payment to a counterparty, or move money between your own accounts",
		Access:      "write",
		AccessFor:   plugins.WriteUnlessInvalid(payCheck),
		Operation:   "move money",
		Options: []plugins.OptionSpec{
			{Flags: "--from <account-id>", Description: "Your account to pay from"},
			{Flags: "--to <id>", Description: "Counterparty ID, or one of your own account IDs to move money internally"},
			{Flags: "--amount <number>", Description: "Amount to send"},
			{Flags: "--currency <code>", Description: "Currency, ISO 4217 (e.g. EUR)"},
			{Flags: "--reference <text>", Description: "Reference shown to you and the recipient (required for a counterparty)"},
			{Flags: "--to-account <id>", Description: "Counterparty's receiving account (when it has more than one)"},
			{Flags: "--to-card <id>", Description: "Counterparty's card, for a card transfer"},
			{Flags: "--title <text>", Description: "Title for the draft"},
			{Flags: "--on <date>", Description: "Schedule the draft for a date, YYYY-MM-DD"},
			{Flags: "--charge-bearer <who>", Description: "Who pays the route fees: shared (SHA) or debtor (OUR)"},
			{Flags: "--reason-code <code>", Description: "Transfer reason code, required by some corridors"},
			{Flags: "--request-id <id>", Description: "Idempotency key for an own-account move (a UUID is generated when omitted)"},
			{Flags: "--force", Description: "Skip the confirmation prompt on an own-account move"},
			formatOption,
		},
		Examples: []string{
			"# draft a payment - nothing moves until it is approved in the Revolut Business app",
			"agentio revolut pay --from 8f9d1e2a-0000-4c3b-9f21-7a5e6d4c3b2a \\",
			"  --to 3c4d5e6f-7a8b-9c0d-1e2f-3a4b5c6d7e8f \\",
			`  --amount 250 --currency EUR --reference "Invoice 42"`,
			"# draft it for the 1st of next month",
			"agentio revolut pay --from 8f9d1e2a-0000-4c3b-9f21-7a5e6d4c3b2a \\",
			"  --to 3c4d5e6f-7a8b-9c0d-1e2f-3a4b5c6d7e8f \\",
			`  --amount 1200 --currency EUR --reference "Rent" --title "October rent" --on 2026-10-01`,
			"# move money between two of your own accounts (detected from --to, executes now)",
			"agentio revolut pay --from 8f9d1e2a-0000-4c3b-9f21-7a5e6d4c3b2a \\",
			"  --to 1b2c3d4e-5f6a-7b8c-9d0e-1f2a3b4c5d6e --amount 500 --currency EUR",
			"# then review and discard what was drafted",
			"agentio revolut drafts list",
			"agentio revolut drafts delete <draft-id>",
		},
		Run:    runPay,
		Format: formatView,
	}
}

// runPay: paying a counterparty always produces a payment draft, never a
// transfer, so nothing leaves the business until a human approves it. The one
// destination that acts immediately is another of your own accounts.
func runPay(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
	p, err := payInputOf(in, run.Fail)
	if err != nil {
		return nil, err
	}
	from, to, reference := in.Option("from"), in.Option("to"), in.Option("reference")
	on, title, reasonCode := in.Option("on"), in.Option("title"), in.Option("reason-code")
	asJSON := in.Option("format") == "json"
	c := clientOf(ctx, run)

	accounts, err := c.listAccounts()
	if err != nil {
		return nil, failed(run.Fail, err)
	}
	source := findAccount(accounts, from)
	if source == nil {
		return nil, run.Fail("NOT_FOUND", fmt.Sprintf(`--from "%s" is not one of your accounts`, from), "Run: agentio revolut accounts")
	}

	if target := findAccount(accounts, to); target != nil {
		if in.Option("to-account") != "" || in.Option("to-card") != "" {
			return nil, run.Fail("INVALID_PARAMS", "--to-account and --to-card only apply to counterparty payments", "")
		}
		if p.chargeBearer != "" || reasonCode != "" {
			return nil, run.Fail("INVALID_PARAMS", "--charge-bearer and --reason-code only apply to counterparty payments", "")
		}
		if on != "" || title != "" {
			return nil, run.Fail("INVALID_PARAMS", "--on and --title only apply to counterparty payments",
				fmt.Sprintf(`"%s" is your own account, so the money moves immediately and there is no draft to schedule or name`, to))
		}
		sourceCurrency, targetCurrency := field(source, "currency"), field(target, "currency")
		if !strictEqual(sourceCurrency, p.currency) || !strictEqual(targetCurrency, p.currency) {
			return nil, run.Fail("INVALID_PARAMS",
				fmt.Sprintf("Moving money between your own accounts needs a single currency: %s holds %s, %s holds %s, and --currency is %s",
					describeAccount(source), text(sourceCurrency), describeAccount(target), text(targetCurrency), p.currency),
				"Exchange the funds in the Revolut Business app first")
		}
		// Revolut de-duplicates a repeated request ID for two weeks, so a
		// retry after a network error cannot move the money twice.
		requestID := jsvalue.Trim(in.Option("request-id"))
		if requestID == "" {
			requestID = randomUUID()
		}
		summary := fmt.Sprintf("Move %s from %s to %s (your own account)",
			formatAmount(p.amount, p.currency), describeAccount(source), describeAccount(target))
		// The only path that acts straight away, so it is the only one that asks.
		if !in.Flag("force") && !confirmed(run, summary+"?") {
			return nil, nil
		}
		result, err := c.createTransfer(transferInput{
			requestID: requestID, sourceAccountID: text(field(source, "id")), targetAccountID: text(field(target, "id")),
			amount: p.amount, currency: p.currency, reference: reference,
		})
		if err != nil {
			return nil, failed(run.Fail, err)
		}
		return &view{value: result, asJSON: asJSON, text: func() string { return transferText(result, summary) }}, nil
	}

	if reference == "" {
		return nil, run.Fail("INVALID_PARAMS", "A payment draft requires --reference", "")
	}
	// Resolve the payee up front so the summary names it and a wrong ID fails
	// before the draft is written.
	counterparty, err := c.getCounterparty(to)
	if err != nil {
		return nil, failed(run.Fail, err)
	}
	id, err := c.createPaymentDraft(draftInput{
		title: title, scheduleFor: on, accountID: text(field(source, "id")), counterpartyID: field(counterparty, "id"),
		counterpartyAccountID: in.Option("to-account"), counterpartyCard: in.Option("to-card"),
		amount: p.amount, currency: p.currency, reference: reference,
		chargeBearer: p.chargeBearer, transferReasonCode: reasonCode,
	})
	if err != nil {
		return nil, failed(run.Fail, err)
	}
	created := jsvalue.NewObject()
	put(created, "id", id)
	when := ""
	if on != "" {
		when = ", scheduled for " + on
	}
	summary := fmt.Sprintf("Drafted %s to %s%s, from %s", formatAmount(p.amount, p.currency), text(field(counterparty, "name")), when, describeAccount(source))
	return &view{value: created, asJSON: asJSON, text: func() string { return draftCreatedText(id, summary) }}, nil
}

// --- counterparties -------------------------------------------------------------------

func counterpartiesListCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "counterparties list",
		Description: "List counterparties",
		Access:      "read",
		Options:     []plugins.OptionSpec{formatOption},
		Examples: []string{
			"# every saved payee with its account numbers",
			"agentio revolut counterparties list",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			list, err := clientOf(ctx, run).listCounterparties()
			if err != nil {
				return nil, failed(run.Fail, err)
			}
			return &view{value: values(list), asJSON: in.Option("format") == "json", text: func() string { return counterpartyListText(list) }}, nil
		},
		Format: formatView,
	}
}

func counterpartiesGetCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "counterparties get",
		Description: "Get one counterparty",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{{Name: "id", Description: "Counterparty ID", Required: true}},
		Options:     []plugins.OptionSpec{formatOption},
		Examples: []string{
			"# full bank details for one payee",
			"agentio revolut counterparties get 3c4d5e6f-7a8b-9c0d-1e2f-3a4b5c6d7e8f",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			cp, err := clientOf(ctx, run).getCounterparty(in.Arg("id"))
			if err != nil {
				return nil, failed(run.Fail, err)
			}
			return &view{value: cp, asJSON: in.Option("format") == "json", text: func() string { return counterpartyText(cp) }}, nil
		},
		Format: formatView,
	}
}

func counterpartyCheck(in plugins.CommandInput, fail plugins.FailFunc) error {
	if err := plugins.RequireOptions(in, fail, "--bank-country <code>", "--currency <code>"); err != nil {
		return err
	}
	if in.Option("company-name") == "" && (in.Option("first-name") == "" || in.Option("last-name") == "") {
		return fail("INVALID_PARAMS", "A counterparty needs a name", "Pass --company-name, or both --first-name and --last-name")
	}
	if in.Option("iban") == "" && in.Option("account-no") == "" {
		return fail("INVALID_PARAMS", "Pass --iban or --account-no", "")
	}
	return nil
}

func counterpartiesAddCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "counterparties add",
		Description: "Add a counterparty",
		Access:      "write",
		AccessFor:   plugins.WriteUnlessInvalid(counterpartyCheck),
		Operation:   "add a counterparty",
		Options: []plugins.OptionSpec{
			{Flags: "--company-name <name>", Description: "Company name (use instead of --first-name/--last-name)"},
			{Flags: "--first-name <name>", Description: "Individual first name"},
			{Flags: "--last-name <name>", Description: "Individual last name"},
			{Flags: "--bank-country <code>", Description: "Bank country, ISO 3166-1 alpha-2 (e.g. BE)"},
			{Flags: "--currency <code>", Description: "Account currency (e.g. EUR)"},
			{Flags: "--iban <iban>", Description: "IBAN"},
			{Flags: "--bic <bic>", Description: "BIC/SWIFT"},
			{Flags: "--account-no <number>", Description: "Account number (non-IBAN)"},
			{Flags: "--sort-code <code>", Description: "Sort code (UK)"},
			{Flags: "--routing-number <number>", Description: "Routing number (US)"},
			{Flags: "--email <email>", Description: "Contact email"},
			{Flags: "--phone <phone>", Description: "Contact phone"},
		},
		Examples: []string{
			"# a Belgian company payee",
			`agentio revolut counterparties add --company-name "Acme Supplies BV" \`,
			"  --bank-country BE --currency EUR --iban BE68539007547034",
			"# an individual payee",
			`agentio revolut counterparties add --first-name Jane --last-name Doe \`,
			"  --bank-country BE --currency EUR --iban BE68539007547034",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			if err := counterpartyCheck(in, run.Fail); err != nil {
				return nil, err
			}
			cp, err := clientOf(ctx, run).createCounterparty(counterpartyInput{
				companyName: in.Option("company-name"), firstName: in.Option("first-name"), lastName: in.Option("last-name"),
				bankCountry: in.Option("bank-country"), currency: in.Option("currency"),
				iban: in.Option("iban"), bic: in.Option("bic"), accountNo: in.Option("account-no"), sortCode: in.Option("sort-code"),
				routingNumber: in.Option("routing-number"), email: in.Option("email"), phone: in.Option("phone"),
			})
			if err != nil {
				return nil, failed(run.Fail, err)
			}
			return &view{value: cp, text: func() string { return counterpartyText(cp) }}, nil
		},
		Format: formatView,
	}
}

// removed is the one line a delete or cancel prints.
func removed(label string, id string) *view {
	o := jsvalue.NewObject()
	o.Set("id", id)
	return &view{value: o, text: func() string { return label + id }}
}

var forceOption = plugins.OptionSpec{Flags: "--force", Description: "Skip the confirmation prompt"}

func counterpartiesDeleteCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "counterparties delete",
		Description: "Delete a counterparty",
		Access:      "write",
		Operation:   "delete a counterparty",
		Arguments:   []plugins.ArgumentSpec{{Name: "id", Description: "Counterparty ID", Required: true}},
		Options:     []plugins.OptionSpec{forceOption},
		Examples: []string{
			"# delete with a confirmation prompt",
			"agentio revolut counterparties delete 3c4d5e6f-7a8b-9c0d-1e2f-3a4b5c6d7e8f",
			"# delete without prompting",
			"agentio revolut counterparties delete 3c4d5e6f-7a8b-9c0d-1e2f-3a4b5c6d7e8f --force",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			id := in.Arg("id")
			c := clientOf(ctx, run)
			if !in.Flag("force") {
				cp, err := c.getCounterparty(id)
				if err != nil {
					return nil, failed(run.Fail, err)
				}
				if !confirmed(run, fmt.Sprintf(`Delete counterparty "%s" (%s)?`, text(field(cp, "name")), id)) {
					return nil, nil
				}
			}
			if err := c.deleteCounterparty(id); err != nil {
				return nil, failed(run.Fail, err)
			}
			return removed("Deleted counterparty: ", id), nil
		},
		Format: formatView,
	}
}

// --- payment drafts -----------------------------------------------------------------

func draftsListCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "drafts list",
		Description: "List payment drafts awaiting approval",
		Access:      "read",
		Options: []plugins.OptionSpec{
			{Flags: "--source <source>", Description: "Filter by origin: api, integration, email, or all", DefaultValue: "api"},
			formatOption,
		},
		Examples: []string{
			"# drafts created through the API",
			"agentio revolut drafts list",
			"# every draft, including ones raised in the Revolut Business app",
			"agentio revolut drafts list --source all",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			drafts, err := clientOf(ctx, run).listPaymentDrafts(in.Option("source"))
			if err != nil {
				return nil, failed(run.Fail, err)
			}
			return &view{value: values(drafts), asJSON: in.Option("format") == "json", text: func() string { return draftListText(drafts) }}, nil
		},
		Format: formatView,
	}
}

func draftsGetCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "drafts get",
		Description: "Get one payment draft with its payments",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{{Name: "id", Description: "Payment draft ID", Required: true}},
		Options:     []plugins.OptionSpec{formatOption},
		Examples: []string{
			"# full detail for one draft",
			"agentio revolut drafts get e7e54cb2-861a-4a1f-80e9-3e6600f3db10",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			id := in.Arg("id")
			d, err := clientOf(ctx, run).getPaymentDraft(id)
			if err != nil {
				return nil, failed(run.Fail, err)
			}
			return &view{value: d, asJSON: in.Option("format") == "json", text: func() string { return draftText(id, d) }}, nil
		},
		Format: formatView,
	}
}

func draftsDeleteCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "drafts delete",
		Description: "Delete a payment draft that has not been sent for processing",
		Access:      "write",
		Operation:   "delete a payment draft",
		Arguments:   []plugins.ArgumentSpec{{Name: "id", Description: "Payment draft ID", Required: true}},
		Options:     []plugins.OptionSpec{forceOption},
		Examples: []string{
			"# delete with a confirmation prompt",
			"agentio revolut drafts delete e7e54cb2-861a-4a1f-80e9-3e6600f3db10",
			"# delete without prompting",
			"agentio revolut drafts delete e7e54cb2-861a-4a1f-80e9-3e6600f3db10 --force",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			id := in.Arg("id")
			c := clientOf(ctx, run)
			if !in.Flag("force") {
				d, err := c.getPaymentDraft(id)
				if err != nil {
					return nil, failed(run.Fail, err)
				}
				title := id
				if t := field(d, "title"); truthy(t) {
					title = `"` + text(t) + `"`
				}
				question := fmt.Sprintf("Delete payment draft %s (%d payment(s))?", title, len(array(field(d, "payments"))))
				if !confirmed(run, question) {
					return nil, nil
				}
			}
			if err := c.deletePaymentDraft(id); err != nil {
				return nil, failed(run.Fail, err)
			}
			return removed("Deleted payment draft: ", id), nil
		},
		Format: formatView,
	}
}

// --- payout links -----------------------------------------------------------------------

func linksListCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "links list",
		Description: "List payout links",
		Access:      "read",
		Options: []plugins.OptionSpec{
			{Flags: "--created-before <timestamp>", Description: "Only links created before this ISO 8601 timestamp"},
			{Flags: "--limit <number>", Description: "Maximum links to return (max 1000)", DefaultValue: "100"},
			formatOption,
		},
		Examples: []string{
			"# most recent payout links",
			"agentio revolut links list",
			"# the next page, using the created_at of the last link on this one",
			"agentio revolut links list --created-before 2026-07-11T13:55:54.834963Z",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			limit, err := positiveInt(run.Fail, "--limit", in.Option("limit"))
			if err != nil {
				return nil, err
			}
			links, err := clientOf(ctx, run).listPayoutLinks(in.Option("created-before"), limit)
			if err != nil {
				return nil, failed(run.Fail, err)
			}
			return &view{value: values(links), asJSON: in.Option("format") == "json", text: func() string { return payoutLinkListText(links) }}, nil
		},
		Format: formatView,
	}
}

func linksGetCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "links get",
		Description: "Get one payout link",
		Access:      "read",
		Arguments:   []plugins.ArgumentSpec{{Name: "id", Description: "Payout link ID", Required: true}},
		Options:     []plugins.OptionSpec{formatOption},
		Examples: []string{
			"# check whether a link has been claimed",
			"agentio revolut links get 12dcd8c2-6408-458f-98a9-3f4abc180898",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			link, err := clientOf(ctx, run).getPayoutLink(in.Arg("id"))
			if err != nil {
				return nil, failed(run.Fail, err)
			}
			return &view{value: link, asJSON: in.Option("format") == "json", text: func() string { return payoutLinkText(link) }}, nil
		},
		Format: formatView,
	}
}

func linksCancelCmd() plugins.CommandSpec {
	return plugins.CommandSpec{
		Path:        "links cancel",
		Description: "Cancel a payout link that has not been claimed",
		Access:      "write",
		Operation:   "cancel a payout link",
		Arguments:   []plugins.ArgumentSpec{{Name: "id", Description: "Payout link ID", Required: true}},
		Options:     []plugins.OptionSpec{forceOption},
		Examples: []string{
			"# cancel with a confirmation prompt",
			"agentio revolut links cancel 12dcd8c2-6408-458f-98a9-3f4abc180898",
			"# cancel without prompting",
			"agentio revolut links cancel 12dcd8c2-6408-458f-98a9-3f4abc180898 --force",
		},
		Run: func(ctx context.Context, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
			id := in.Arg("id")
			c := clientOf(ctx, run)
			if !in.Flag("force") {
				link, err := c.getPayoutLink(id)
				if err != nil {
					return nil, failed(run.Fail, err)
				}
				question := fmt.Sprintf("Cancel the %s payout link to %s?",
					formatAmount(field(link, "amount"), field(link, "currency")), text(field(link, "counterpartyName")))
				if !confirmed(run, question) {
					return nil, nil
				}
			}
			if err := c.cancelPayoutLink(id); err != nil {
				return nil, failed(run.Fail, err)
			}
			return removed("Cancelled payout link: ", id), nil
		},
		Format: formatView,
	}
}
