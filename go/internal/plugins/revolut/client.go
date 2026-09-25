package revolut

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
)

var apiBase = map[string]string{
	"production": "https://b2b.revolut.com/api/1.0",
	"sandbox":    "https://sandbox-b2b.revolut.com/api/1.0",
}

// apiBaseURL is API_BASE[environment]; an unknown one interpolates as
// "undefined", as in Bun.
func apiBaseURL(environment any) string {
	if s, ok := environment.(string); ok {
		if base, ok := apiBase[s]; ok {
			return base
		}
	}
	return "undefined"
}

type fetchFunc func(context.Context, *http.Request) (*http.Response, error)

func defaultFetch(ctx context.Context, req *http.Request) (*http.Response, error) {
	return http.DefaultClient.Do(req.WithContext(ctx))
}

// apiError is the CliError Bun's client throws. Commands hand it to Fail.
type apiError struct {
	code       plugins.ErrorCode
	message    string
	suggestion string
}

func (e *apiError) Error() string { return e.message }

// failed turns a client error into the host error Bun's handleError prints.
func failed(fail func(plugins.ErrorCode, string, string) error, err error) error {
	var ae *apiError
	if errors.As(err, &ae) {
		return fail(ae.code, ae.message, ae.suggestion)
	}
	return err
}

const reauthorise = "Run: agentio revolut profile add to re-authorise"

// parseJSONBody is Response#json(): the body decoded as UTF-8, then JSON.parse.
func parseJSONBody(raw []byte) (any, error) {
	text := jsvalue.DecodeUTF8(raw)
	if text == "" {
		return nil, errors.New("Unexpected end of JSON input")
	}
	v, err := jsvalue.Parse([]byte(text))
	if err != nil {
		return nil, errors.New(jsvalue.ParseErrorMessage([]byte(text)))
	}
	return v, nil
}

// client is RevolutClient: one access token against one environment.
type client struct {
	ctx         context.Context
	fetch       fetchFunc
	baseURL     string
	environment any
	accessToken any
}

func newClient(ctx context.Context, creds map[string]any, fetch fetchFunc) *client {
	if fetch == nil {
		fetch = defaultFetch
	}
	env := credential(creds, "environment")
	return &client{ctx: ctx, fetch: fetch, baseURL: apiBaseURL(env), environment: env, accessToken: credential(creds, "accessToken")}
}

// credential is `credentials.<key>`: undefined when the key is absent.
func credential(creds map[string]any, key string) any {
	if v, ok := creds[key]; ok {
		return v
	}
	return undefined
}

func (c *client) send(method, path string, headers [][2]string, body []byte) (*http.Response, []byte, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(c.ctx, method, c.baseURL+path, reader)
	if err == nil {
		req.Header.Set("Authorization", "Bearer "+text(c.accessToken))
		for _, h := range headers {
			req.Header.Set(h[0], h[1])
		}
		var resp *http.Response
		if resp, err = c.fetch(c.ctx, req); err == nil {
			defer resp.Body.Close()
			raw, err := plugins.ReadBody(resp.Body)
			if err != nil {
				return nil, nil, err
			}
			return resp, raw, nil
		}
	}
	return nil, nil, &apiError{code: "NETWORK_ERROR", message: "Could not reach the Revolut API: " + err.Error()}
}

// request sends JSON and returns the decoded body; 204 is undefined.
func (c *client) request(method, path string, body any) (any, error) {
	headers := [][2]string{{"Accept", "application/json"}}
	var payload []byte
	if body != nil {
		headers = append(headers, [2]string{"Content-Type", "application/json"})
		payload = jsvalue.Stringify(body)
	}
	resp, raw, err := c.send(method, path, headers, payload)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		suggestion := ""
		if resp.StatusCode == 401 {
			suggestion = reauthorise
		}
		return nil, &apiError{
			code:       plugins.HTTPStatusToErrorCode(resp.StatusCode),
			message:    fmt.Sprintf("Revolut API error (%d): %s", resp.StatusCode, jsvalue.DecodeUTF8(raw)),
			suggestion: suggestion,
		}
	}
	if resp.StatusCode == 204 {
		return undefined, nil
	}
	return parseJSONBody(raw)
}

type binary struct {
	data        []byte
	contentType *string
	disposition *string
}

func header(resp *http.Response, name string) *string {
	values := resp.Header.Values(name)
	if len(values) == 0 {
		return nil
	}
	joined := strings.Join(values, ", ")
	return &joined
}

func (c *client) requestBinary(path string) (binary, error) {
	resp, raw, err := c.send(http.MethodGet, path, [][2]string{{"Accept", "*/*"}}, nil)
	if err != nil {
		return binary{}, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return binary{}, &apiError{
			code:       plugins.HTTPStatusToErrorCode(resp.StatusCode),
			message:    fmt.Sprintf("Revolut API error (%d): %s", resp.StatusCode, jsvalue.DecodeUTF8(raw)),
			suggestion: receiptErrorSuggestion(resp.StatusCode),
		}
	}
	return binary{data: raw, contentType: header(resp, "Content-Type"), disposition: header(resp, "Content-Disposition")}, nil
}

func receiptErrorSuggestion(status int) string {
	switch status {
	case 401:
		return reauthorise
	case 403:
		return "The Revolut API app needs read access to expenses; check its permissions in the Revolut Business app"
	}
	return ""
}

// --- mappers: the Bun map* functions, keeping undefined out of the JSON -------

func mapAccount(raw any) *jsvalue.Object {
	o := jsvalue.NewObject()
	put(o, "id", field(raw, "id"))
	put(o, "name", field(raw, "name"))
	put(o, "balance", field(raw, "balance"))
	put(o, "currency", field(raw, "currency"))
	put(o, "state", field(raw, "state"))
	put(o, "public", field(raw, "public"))
	put(o, "createdAt", field(raw, "created_at"))
	put(o, "updatedAt", field(raw, "updated_at"))
	return o
}

func mapTransaction(raw any) *jsvalue.Object {
	card := field(raw, "card")
	var names []string
	for _, part := range []any{field(card, "first_name"), field(card, "last_name")} {
		if truthy(part) {
			names = append(names, text(part))
		}
	}
	cardHolder := strings.Join(names, " ")

	o := jsvalue.NewObject()
	for _, k := range [][2]string{
		{"id", "id"}, {"type", "type"}, {"state", "state"}, {"requestId", "request_id"}, {"reference", "reference"},
		{"reasonCode", "reason_code"}, {"createdAt", "created_at"}, {"updatedAt", "updated_at"}, {"completedAt", "completed_at"},
	} {
		put(o, k[0], field(raw, k[1]))
	}
	if merchant := field(raw, "merchant"); truthy(merchant) {
		m := jsvalue.NewObject()
		put(m, "name", field(merchant, "name"))
		put(m, "city", field(merchant, "city"))
		put(m, "categoryCode", field(merchant, "category_code"))
		put(m, "country", field(merchant, "country"))
		o.Set("merchant", m)
	}
	if cardHolder != "" {
		o.Set("cardHolder", cardHolder)
	}
	legs := []any{}
	for _, leg := range array(field(raw, "legs")) {
		l := jsvalue.NewObject()
		for _, k := range [][2]string{
			{"legId", "leg_id"}, {"accountId", "account_id"}, {"amount", "amount"}, {"currency", "currency"},
			{"billAmount", "bill_amount"}, {"billCurrency", "bill_currency"}, {"description", "description"}, {"balance", "balance"},
		} {
			put(l, k[0], field(leg, k[1]))
		}
		counterparty := field(leg, "counterparty")
		put(l, "counterpartyId", field(counterparty, "id"))
		put(l, "counterpartyAccountId", field(counterparty, "account_id"))
		put(l, "counterpartyType", field(counterparty, "type"))
		legs = append(legs, l)
	}
	o.Set("legs", legs)
	return o
}

// personName is Bun personName: a string, or an object's name, or its first
// and last names joined.
func personName(value any) any {
	if s, ok := value.(string); ok {
		if s == "" {
			return undefined
		}
		return s
	}
	if !truthy(value) {
		return undefined
	}
	full := field(value, "name")
	if !truthy(full) {
		var parts []string
		for _, p := range []any{field(value, "first_name"), field(value, "last_name")} {
			if truthy(p) {
				parts = append(parts, text(p))
			}
		}
		full = strings.Join(parts, " ")
	}
	if !truthy(full) {
		return undefined
	}
	return full
}

func mapExpense(raw any) *jsvalue.Object {
	// Revolut Business returns money under `spent_amount` ({amount, currency}).
	// Older shapes used a top-level `amount`, a bare number or the same wrapper.
	rawAmount := field(raw, "amount")
	money := field(raw, "spent_amount")
	if nullish(money) {
		money = undefined
		if isObject(rawAmount) {
			money = rawAmount
		}
	}
	amount := field(money, "amount")
	if nullish(amount) {
		amount = undefined
		if isNumber(rawAmount) {
			amount = rawAmount
		}
	}
	category := field(raw, "category")
	if nullish(category) {
		category = undefined
		for _, split := range splits(field(raw, "splits")) {
			if name := field(field(split, "category"), "name"); truthy(name) {
				category = name
				break
			}
		}
	}
	merchant := field(raw, "merchant")
	if s, ok := merchant.(string); ok {
		merchant = or(s, undefined)
	} else {
		merchant = field(merchant, "name")
	}
	receipts := field(raw, "receipt_ids")
	if nullish(receipts) {
		receipts = []any{}
	}

	o := jsvalue.NewObject()
	put(o, "id", field(raw, "id"))
	put(o, "state", field(raw, "state"))
	put(o, "expenseDate", field(raw, "expense_date"))
	put(o, "completedAt", field(raw, "completed_at"))
	if isNumber(amount) {
		o.Set("amount", amount)
	}
	put(o, "currency", coalesce(field(money, "currency"), field(raw, "currency")))
	put(o, "description", field(raw, "description"))
	put(o, "category", category)
	put(o, "merchant", merchant)
	put(o, "transactionId", field(raw, "transaction_id"))
	put(o, "spender", personName(coalesce(field(raw, "payer"), field(raw, "spender"))))
	o.Set("receiptIds", receipts)
	return o
}

// splits is `raw.splits?.map(...)`: only an array is walked.
func splits(v any) []any {
	arr, _ := v.([]any)
	return arr
}

func mapCounterparty(raw any) *jsvalue.Object {
	o := jsvalue.NewObject()
	for _, k := range [][2]string{
		{"id", "id"}, {"name", "name"}, {"phone", "phone"}, {"profileType", "profile_type"}, {"country", "country"},
		{"state", "state"}, {"createdAt", "created_at"}, {"updatedAt", "updated_at"},
	} {
		put(o, k[0], field(raw, k[1]))
	}
	accounts := []any{}
	for _, account := range array(field(raw, "accounts")) {
		a := jsvalue.NewObject()
		for _, k := range [][2]string{
			{"id", "id"}, {"name", "name"}, {"bankCountry", "bank_country"}, {"currency", "currency"}, {"type", "type"},
			{"accountNo", "account_no"}, {"iban", "iban"}, {"sortCode", "sort_code"}, {"routingNumber", "routing_number"},
			{"bic", "bic"}, {"recipientCharges", "recipient_charges"},
		} {
			put(a, k[0], field(account, k[1]))
		}
		accounts = append(accounts, a)
	}
	o.Set("accounts", accounts)
	return o
}

func mapTransferResult(raw any) *jsvalue.Object {
	o := jsvalue.NewObject()
	put(o, "id", field(raw, "id"))
	put(o, "state", field(raw, "state"))
	put(o, "createdAt", field(raw, "created_at"))
	put(o, "completedAt", field(raw, "completed_at"))
	return o
}

func mapDraftPayment(raw any) *jsvalue.Object {
	amount := field(raw, "amount")
	receiver := field(raw, "receiver")
	o := jsvalue.NewObject()
	put(o, "id", field(raw, "id"))
	put(o, "amount", coalesce(field(amount, "amount"), float64(0)))
	put(o, "currency", coalesce(field(amount, "currency"), field(raw, "currency")))
	put(o, "accountId", field(raw, "account_id"))
	put(o, "counterpartyId", field(receiver, "counterparty_id"))
	put(o, "counterpartyAccountId", field(receiver, "account_id"))
	put(o, "counterpartyCardId", field(receiver, "card_id"))
	put(o, "state", field(raw, "state"))
	put(o, "reason", field(raw, "reason"))
	put(o, "errorMessage", field(raw, "error_message"))
	put(o, "reference", field(raw, "reference"))
	put(o, "transferReasonCode", field(raw, "transfer_reason_code"))
	if charge := field(raw, "current_charge_options"); truthy(charge) {
		c := jsvalue.NewObject()
		put(c, "fromAmount", field(field(charge, "from"), "amount"))
		put(c, "fromCurrency", field(field(charge, "from"), "currency"))
		put(c, "toAmount", field(field(charge, "to"), "amount"))
		put(c, "toCurrency", field(field(charge, "to"), "currency"))
		put(c, "rate", field(charge, "rate"))
		put(c, "feeAmount", field(field(charge, "fee"), "amount"))
		put(c, "feeCurrency", field(field(charge, "fee"), "currency"))
		o.Set("charge", c)
	}
	return o
}

func mapPayoutLink(raw any) *jsvalue.Object {
	o := jsvalue.NewObject()
	for _, k := range [][2]string{
		{"id", "id"}, {"state", "state"}, {"createdAt", "created_at"}, {"updatedAt", "updated_at"},
		{"counterpartyName", "counterparty_name"},
	} {
		put(o, k[0], field(raw, k[1]))
	}
	put(o, "saveCounterparty", coalesce(field(raw, "save_counterparty"), false))
	put(o, "requestId", field(raw, "request_id"))
	put(o, "expiryDate", field(raw, "expiry_date"))
	put(o, "payoutMethods", coalesce(field(raw, "payout_methods"), []any{}))
	for _, k := range [][2]string{
		{"accountId", "account_id"}, {"amount", "amount"}, {"currency", "currency"}, {"url", "url"}, {"reference", "reference"},
		{"transferReasonCode", "transfer_reason_code"}, {"counterpartyId", "counterparty_id"},
		{"transactionId", "transaction_id"}, {"cancellationReason", "cancellation_reason"},
	} {
		put(o, k[0], field(raw, k[1]))
	}
	return o
}

func mapAll(raw any, mapper func(any) *jsvalue.Object) []*jsvalue.Object {
	rows := array(raw)
	out := make([]*jsvalue.Object, len(rows))
	for i, r := range rows {
		out[i] = mapper(r)
	}
	return out
}

// --- receipts --------------------------------------------------------------------

var receiptExtensions = map[string]string{
	"application/pdf": ".pdf",
	"image/jpeg":      ".jpg",
	"image/jpg":       ".jpg",
	"image/png":       ".png",
	"image/heic":      ".heic",
	"image/heif":      ".heif",
	"image/webp":      ".webp",
	"image/gif":       ".gif",
	"image/tiff":      ".tiff",
}

var (
	pathSeparators  = regexp.MustCompile(`[\\/]`)
	encodedFilename = regexp.MustCompile(`(?i)filename\*\s*=\s*[^']*'[^']*'([^;]+)`)
	plainFilename   = regexp.MustCompile(`(?i)filename\s*=\s*"?([^";]+)"?`)
	dotNames        = map[string]bool{".": true, "..": true}
)

// basename strips any directory component so a crafted header cannot escape
// the output directory.
func basename(name string) string {
	parts := pathSeparators.Split(name, -1)
	tail := parts[len(parts)-1]
	if dotNames[tail] {
		return ""
	}
	return tail
}

func filenameFromDisposition(disposition *string) string {
	if disposition == nil || *disposition == "" {
		return ""
	}
	// RFC 5987 form wins when present: filename*=UTF-8''receipt%20jan.pdf
	if m := encodedFilename.FindStringSubmatch(*disposition); m != nil && m[1] != "" {
		if decoded, ok := jsvalue.DecodeURIComponent(jsvalue.Trim(m[1])); ok {
			if name := basename(decoded); name != "" {
				return name
			}
		}
	}
	if m := plainFilename.FindStringSubmatch(*disposition); m != nil && m[1] != "" {
		return basename(jsvalue.Trim(m[1]))
	}
	return ""
}

// receiptFilename falls back to the receipt ID with an extension guessed from
// the content type; `.bin` keeps an unknown type honest.
func receiptFilename(receiptID string, contentType, disposition *string) string {
	if provided := filenameFromDisposition(disposition); provided != "" {
		return provided
	}
	kind := ""
	if contentType != nil {
		kind = strings.ToLower(jsvalue.Trim(strings.SplitN(*contentType, ";", 2)[0]))
	}
	ext, ok := receiptExtensions[kind]
	if !ok {
		ext = ".bin"
	}
	return receiptID + ext
}

type receipt struct {
	filename string
	data     []byte
}

// --- endpoints -----------------------------------------------------------------

func escape(s string) string { return jsvalue.EncodeURIComponent(s) }

func withQuery(path string, q *jsvalue.SearchParams) string {
	if query := q.String(); query != "" {
		return path + "?" + query
	}
	return path
}

func (c *client) listAccounts() ([]*jsvalue.Object, error) {
	raw, err := c.request(http.MethodGet, "/accounts", nil)
	if err != nil {
		return nil, err
	}
	return mapAll(raw, mapAccount), nil
}

type transactionFilter struct {
	from, to, counterparty, account, kind string
	count                                 float64
}

func (c *client) listTransactions(f transactionFilter) ([]*jsvalue.Object, error) {
	q := jsvalue.NewSearchParams()
	for _, p := range [][2]string{{"from", f.from}, {"to", f.to}, {"counterparty", f.counterparty}, {"account", f.account}, {"type", f.kind}} {
		if p[1] != "" {
			q.Set(p[0], p[1])
		}
	}
	q.Set("count", jsvalue.NumberString(f.count))
	raw, err := c.request(http.MethodGet, withQuery("/transactions", q), nil)
	if err != nil {
		return nil, err
	}
	return mapAll(raw, mapTransaction), nil
}

func (c *client) getTransaction(id string) (*jsvalue.Object, error) {
	raw, err := c.request(http.MethodGet, "/transaction/"+escape(id), nil)
	if err != nil {
		return nil, err
	}
	return mapTransaction(raw), nil
}

func (c *client) listCounterparties() ([]*jsvalue.Object, error) {
	raw, err := c.request(http.MethodGet, "/counterparties", nil)
	if err != nil {
		return nil, err
	}
	return mapAll(raw, mapCounterparty), nil
}

func (c *client) getCounterparty(id string) (*jsvalue.Object, error) {
	raw, err := c.request(http.MethodGet, "/counterparty/"+escape(id), nil)
	if err != nil {
		return nil, err
	}
	return mapCounterparty(raw), nil
}

type counterpartyInput struct {
	companyName, firstName, lastName, bankCountry, currency string
	iban, bic, accountNo, sortCode, routingNumber           string
	email, phone                                            string
}

func (c *client) createCounterparty(in counterpartyInput) (*jsvalue.Object, error) {
	body := jsvalue.NewObject()
	body.Set("bank_country", in.bankCountry)
	body.Set("currency", in.currency)
	if in.companyName != "" {
		body.Set("company_name", in.companyName)
	} else {
		// The command only gets here with both names given.
		name := jsvalue.NewObject()
		name.Set("first_name", in.firstName)
		name.Set("last_name", in.lastName)
		body.Set("individual_name", name)
	}
	for _, p := range [][2]string{
		{"iban", in.iban}, {"bic", in.bic}, {"account_no", in.accountNo}, {"sort_code", in.sortCode},
		{"routing_number", in.routingNumber}, {"email", in.email}, {"phone", in.phone},
	} {
		if p[1] != "" {
			body.Set(p[0], p[1])
		}
	}
	raw, err := c.request(http.MethodPost, "/counterparty", body)
	if err != nil {
		return nil, err
	}
	return mapCounterparty(raw), nil
}

func (c *client) deleteCounterparty(id string) error {
	_, err := c.request(http.MethodDelete, "/counterparty/"+escape(id), nil)
	return err
}

type transferInput struct {
	requestID, sourceAccountID, targetAccountID string
	amount                                      float64
	currency, reference                         string
}

// createTransfer moves money between two of the business's own accounts.
func (c *client) createTransfer(in transferInput) (*jsvalue.Object, error) {
	body := jsvalue.NewObject()
	body.Set("request_id", in.requestID)
	body.Set("source_account_id", in.sourceAccountID)
	body.Set("target_account_id", in.targetAccountID)
	body.Set("amount", in.amount)
	body.Set("currency", in.currency)
	if in.reference != "" {
		body.Set("reference", in.reference)
	}
	raw, err := c.request(http.MethodPost, "/transfer", body)
	if err != nil {
		return nil, err
	}
	return mapTransferResult(raw), nil
}

type draftInput struct {
	title, scheduleFor, accountID           string
	counterpartyID                          any
	counterpartyAccountID, counterpartyCard string
	amount                                  float64
	currency, reference                     string
	chargeBearer, transferReasonCode        string
}

// createPaymentDraft writes a draft; nothing moves until someone approves it
// in the Revolut Business app. It returns the draft ID.
func (c *client) createPaymentDraft(in draftInput) (any, error) {
	receiver := jsvalue.NewObject()
	put(receiver, "counterparty_id", in.counterpartyID)
	if in.counterpartyAccountID != "" {
		receiver.Set("account_id", in.counterpartyAccountID)
	}
	if in.counterpartyCard != "" {
		receiver.Set("card_id", in.counterpartyCard)
	}
	payment := jsvalue.NewObject()
	payment.Set("account_id", in.accountID)
	payment.Set("receiver", receiver)
	payment.Set("amount", in.amount)
	payment.Set("currency", in.currency)
	payment.Set("reference", in.reference)
	if in.chargeBearer != "" {
		payment.Set("charge_bearer", in.chargeBearer)
	}
	if in.transferReasonCode != "" {
		payment.Set("transfer_reason_code", in.transferReasonCode)
	}
	body := jsvalue.NewObject()
	body.Set("payments", []any{payment})
	if in.title != "" {
		body.Set("title", in.title)
	}
	if in.scheduleFor != "" {
		body.Set("schedule_for", in.scheduleFor)
	}
	raw, err := c.request(http.MethodPost, "/payment-drafts", body)
	if err != nil {
		return nil, err
	}
	return field(raw, "id"), nil
}

func (c *client) listPaymentDrafts(source string) ([]*jsvalue.Object, error) {
	query := ""
	if source != "" {
		query = "?source=" + escape(source)
	}
	raw, err := c.request(http.MethodGet, "/payment-drafts"+query, nil)
	if err != nil {
		return nil, err
	}
	return mapAll(field(raw, "payment_orders"), func(order any) *jsvalue.Object {
		o := jsvalue.NewObject()
		put(o, "id", field(order, "id"))
		put(o, "title", field(order, "title"))
		put(o, "scheduledFor", field(order, "scheduled_for"))
		put(o, "paymentsCount", field(order, "payments_count"))
		put(o, "source", field(order, "source"))
		return o
	}), nil
}

func (c *client) getPaymentDraft(id string) (*jsvalue.Object, error) {
	raw, err := c.request(http.MethodGet, "/payment-drafts/"+escape(id), nil)
	if err != nil {
		return nil, err
	}
	o := jsvalue.NewObject()
	put(o, "title", field(raw, "title"))
	put(o, "scheduledFor", field(raw, "scheduled_for"))
	put(o, "source", field(raw, "source"))
	payments := []any{}
	for _, p := range mapAll(field(raw, "payments"), mapDraftPayment) {
		payments = append(payments, p)
	}
	o.Set("payments", payments)
	return o, nil
}

func (c *client) deletePaymentDraft(id string) error {
	_, err := c.request(http.MethodDelete, "/payment-drafts/"+escape(id), nil)
	return err
}

func (c *client) listPayoutLinks(createdBefore string, limit float64) ([]*jsvalue.Object, error) {
	q := jsvalue.NewSearchParams()
	if createdBefore != "" {
		q.Set("created_before", createdBefore)
	}
	q.Set("limit", jsvalue.NumberString(limit))
	raw, err := c.request(http.MethodGet, withQuery("/payout-links", q), nil)
	if err != nil {
		return nil, err
	}
	return mapAll(raw, mapPayoutLink), nil
}

func (c *client) getPayoutLink(id string) (*jsvalue.Object, error) {
	raw, err := c.request(http.MethodGet, "/payout-links/"+escape(id), nil)
	if err != nil {
		return nil, err
	}
	return mapPayoutLink(raw), nil
}

// cancelPayoutLink works only on links that have not been claimed yet.
func (c *client) cancelPayoutLink(id string) error {
	_, err := c.request(http.MethodPost, "/payout-links/"+escape(id)+"/cancel", nil)
	return err
}

// listExpenses pages on time, not page number. The envelope is either a bare
// array or `{expenses: [...]}`.
func (c *client) listExpenses(from, to string, count float64) ([]*jsvalue.Object, error) {
	q := jsvalue.NewSearchParams()
	if from != "" {
		q.Set("from", from)
	}
	if to != "" {
		q.Set("to", to)
	}
	q.Set("count", jsvalue.NumberString(count))
	raw, err := c.request(http.MethodGet, withQuery("/expenses", q), nil)
	if err != nil {
		return nil, err
	}
	if _, isArray := raw.([]any); !isArray {
		raw = field(raw, "expenses")
	}
	return mapAll(raw, mapExpense), nil
}

func (c *client) getExpense(id string) (*jsvalue.Object, error) {
	raw, err := c.request(http.MethodGet, "/expenses/"+escape(id), nil)
	if err != nil {
		return nil, err
	}
	return mapExpense(raw), nil
}

// getReceipt downloads the receipt file itself (PDF or image), not JSON.
func (c *client) getReceipt(expenseID, receiptID string) (receipt, error) {
	path := "/expenses/" + escape(expenseID) + "/receipts/" + escape(receiptID) + "/content"
	b, err := c.requestBinary(path)
	if err != nil {
		return receipt{}, err
	}
	return receipt{filename: receiptFilename(receiptID, b.contentType, b.disposition), data: b.data}, nil
}

// validate lists the accounts and summarises their currencies.
func (c *client) validate() plugins.ValidationResult {
	accounts, err := c.listAccounts()
	if err != nil {
		return plugins.ValidationResult{Valid: false, Error: err.Error()}
	}
	seen := map[string]bool{}
	var currencies []string
	for _, a := range accounts {
		// Array#join renders a missing currency as "".
		s := ""
		if cur := field(a, "currency"); !nullish(cur) {
			s = text(cur)
		}
		if !seen[s] {
			seen[s] = true
			currencies = append(currencies, s)
		}
	}
	sort.Strings(currencies)
	summary := "no accounts"
	if len(currencies) > 0 {
		summary = strings.Join(currencies, ", ")
	}
	return plugins.ValidationResult{Valid: true, Info: fmt.Sprintf("%s - %d account(s): %s", text(c.environment), len(accounts), summary)}
}

func validate(ctx context.Context, run *plugins.RunContext) (plugins.ValidationResult, error) {
	return newClient(ctx, run.Credentials, run.Fetch).validate(), nil
}
