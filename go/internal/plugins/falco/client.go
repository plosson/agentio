package falco

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
)

// Falco (Horus Software): the internal API the Electron desktop app uses, not
// the Partner API. Three hosts: accounts for auth, api.my-falco.be for Peppol
// and invoices, and a separate billing host for outbound sales documents.
const (
	authURL       = "https://accounts.horus-software.be"
	apiURL        = "https://api.my-falco.be"
	billingAPIURL = "https://horusapi-billing.azurewebsites.net"
	brand         = "falco"
	// maxPages stops a cursor walk long before it could loop forever.
	maxPages = 500
)

// Login asks for four scopes; the refresh exchange only ever returns three.
var (
	loginScopes   = []string{"myhorus", "billing", "falco", "oclaf"}
	refreshScopes = []string{"myhorus", "billing", "oclaf"}
)

type fetchFunc func(context.Context, *http.Request) (*http.Response, error)

// apiError is Bun's CliError thrown by the client. Commands hand it to Fail.
type apiError struct {
	code       plugins.ErrorCode
	message    string
	suggestion string
}

func (e *apiError) Error() string { return e.message }

// failed turns a client error into the host error Bun's handleError prints.
func failed(fail func(plugins.ErrorCode, string, string) error, err error) error {
	if ae, ok := err.(*apiError); ok {
		return fail(ae.code, ae.message, ae.suggestion)
	}
	return err
}

// client is FalcoClient: one access token scoped to one organization.
type client struct {
	ctx            context.Context
	fetch          fetchFunc
	accessToken    string
	organizationID string
}

func newClient(ctx context.Context, creds plugins.Credentials, fetch fetchFunc) *client {
	if fetch == nil {
		fetch = plugins.Fetch
	}
	// The host refreshes before handing credentials over, so an access token is
	// present in practice; an empty one simply fails the first call as 401.
	token, _ := creds.Value("accessToken").(string)
	return &client{ctx: ctx, fetch: fetch, accessToken: token, organizationID: jsvalue.String(orNull(creds.Value("organizationId")))}
}

// orNull keeps String(undefined) out of a URL: a missing id reads as "undefined".
func orNull(v any) any {
	if v == nil {
		return "undefined"
	}
	return v
}

// response keeps a body read failure for the caller: Bun reads some bodies
// with .catch(() => ""), so a failed read is an empty body, and others without.
type response struct {
	status      int
	contentType string
	body        []byte
	readErr     error
}

func (r response) ok() bool { return r.status >= 200 && r.status < 300 }

func (c *client) send(method, url string, headers [][2]string, body []byte, what string) (response, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(c.ctx, method, url, reader)
	if err != nil {
		return response{}, &apiError{code: "NETWORK_ERROR", message: fmt.Sprintf("Could not reach Falco while %s: %s", what, err.Error())}
	}
	req.Header.Set("Authorization", "Bearer "+c.accessToken)
	req.Header.Set("Accept", "application/json")
	for _, h := range headers {
		req.Header.Set(h[0], h[1])
	}
	resp, err := c.fetch(c.ctx, req)
	if err != nil {
		return response{}, &apiError{code: "NETWORK_ERROR", message: fmt.Sprintf("Could not reach Falco while %s: %s", what, err.Error())}
	}
	defer resp.Body.Close()
	raw, readErr := io.ReadAll(resp.Body)
	if readErr != nil {
		// A failed read keeps nothing: an error body read with .catch(() => "").
		raw = nil
	}
	return response{status: resp.StatusCode, contentType: resp.Header.Get("Content-Type"), body: raw, readErr: readErr}, nil
}

func (c *client) fail(status int, body, what string) error {
	detail := ""
	if jsvalue.Trim(body) != "" {
		detail = ": " + jsvalue.Slice(body, 200)
	}
	suggestion := ""
	if status == 401 {
		suggestion = "Run: agentio reauth"
	}
	return &apiError{
		code:       plugins.HTTPStatusToErrorCode(status),
		message:    fmt.Sprintf("Falco request failed while %s (HTTP %d)%s", what, status, detail),
		suggestion: suggestion,
	}
}

func malformed(what, text string) error {
	return &apiError{code: "API_ERROR", message: fmt.Sprintf("Falco returned malformed JSON while %s: %s", what, jsvalue.Slice(text, 200))}
}

// getJSON returns nil for an empty body, as Bun's getJson returns null.
func (c *client) getJSON(pathAndQuery, what string) (any, error) {
	resp, err := c.send(http.MethodGet, apiURL+pathAndQuery, nil, nil, what)
	if err != nil {
		return nil, err
	}
	if resp.readErr != nil {
		return nil, resp.readErr
	}
	text := jsvalue.DecodeUTF8(resp.body)
	if !resp.ok() {
		return nil, c.fail(resp.status, text, what)
	}
	if text == "" {
		return nil, nil
	}
	v, err := jsvalue.Parse([]byte(text))
	if err != nil {
		return nil, malformed(what, text)
	}
	return v, nil
}

// objects reads a JSON array of records. A non-array reads as empty.
func objects(v any) []*jsvalue.Object {
	arr, _ := v.([]any)
	out := make([]*jsvalue.Object, 0, len(arr))
	for _, e := range arr {
		o, _ := e.(*jsvalue.Object)
		if o == nil {
			o = jsvalue.NewObject()
		}
		out = append(out, o)
	}
	return out
}

// --- User ---------------------------------------------------------------------

type organization struct {
	id, name  string
	vatNumber *string
}

type userMe struct {
	raw                            *jsvalue.Object
	id, email, firstName, lastName string
	organizations                  []organization
}

func (c *client) getUserMe() (userMe, error) {
	v, err := c.getJSON("/user/me", "reading the account")
	if err != nil {
		return userMe{}, err
	}
	o, _ := v.(*jsvalue.Object)
	me := userMe{raw: o}
	if o == nil {
		return me, nil
	}
	me.id = jsvalue.String(orNull(valueOf(o, "id")))
	me.email = jsvalue.String(orNull(valueOf(o, "email")))
	me.firstName = jsvalue.String(orNull(valueOf(o, "firstName")))
	me.lastName = jsvalue.String(orNull(valueOf(o, "lastName")))
	orgs, _ := valueOf(o, "organizations").([]any)
	for _, e := range orgs {
		org, _ := e.(*jsvalue.Object)
		if org == nil {
			continue
		}
		id, _ := org.Str("id")
		me.organizations = append(me.organizations, organization{
			id: id, name: jsvalue.String(orNull(valueOf(org, "name"))), vatNumber: org.Text("vatNumber"),
		})
	}
	return me, nil
}

func valueOf(o *jsvalue.Object, key string) any {
	v, _ := o.Get(key)
	return v
}

// --- Peppol inbox ---------------------------------------------------------------

// listPeppolDocuments requests every state; narrowing happens client-side.
func (c *client) listPeppolDocuments(last *cursor) ([]*jsvalue.Object, error) {
	q := jsvalue.NewSearchParams()
	for _, k := range []string{"showNotImported", "showImported", "showProcessing", "showAccepted", "showRejected", "showNoResponse"} {
		q.Set(k, "true")
	}
	q.Set("selfBilling", "false")
	// Bun skips only undefined and "": a null id is sent as "null".
	if last != nil && last.present {
		if s := jsvalue.String(last.value); s != "" {
			q.Set("last", s)
		}
	}
	v, err := c.getJSON("/peppol/documents/"+c.organizationID+"?"+q.String(), "listing Peppol documents")
	if err != nil {
		return nil, err
	}
	return objects(v), nil
}

type pageProgress func(page, added, total int)

// cursor is the id of the oldest record on the previous page, as JavaScript
// holds it: absent (undefined), null, or a value.
type cursor struct {
	value   any
	present bool
}

// walk follows the `last=<id>` cursor until the server stops returning new
// records. A page of records already seen means the cursor is not advancing.
func walk(fetchPage func(last *cursor) ([]*jsvalue.Object, error), onPage pageProgress) ([]*jsvalue.Object, error) {
	var all []*jsvalue.Object
	seen := map[string]bool{}
	var last *cursor
	for page := 0; page < maxPages; page++ {
		chunk, err := fetchPage(last)
		if err != nil {
			return nil, err
		}
		if len(chunk) == 0 {
			break
		}
		added := 0
		for _, rec := range chunk {
			id, _ := rec.Get("id")
			key := string(jsvalue.Stringify(id))
			if seen[key] {
				continue
			}
			seen[key] = true
			all = append(all, rec)
			added++
		}
		if onPage != nil {
			onPage(page, added, len(all))
		}
		if added == 0 {
			break
		}
		oldest := chunk[len(chunk)-1]
		last = &cursor{}
		last.value, last.present = oldest.Get("id")
	}
	return all, nil
}

func (c *client) listAllPeppolDocuments(onPage pageProgress) ([]*jsvalue.Object, error) {
	return walk(c.listPeppolDocuments, onPage)
}

var htmlType = regexp.MustCompile(`(?i)html`)

// downloadPeppolDocumentUbl returns the raw UBL XML for one Peppol document.
func (c *client) downloadPeppolDocumentUbl(documentID string) ([]byte, error) {
	what := "downloading document " + documentID
	resp, err := c.send(http.MethodGet, apiURL+"/peppol/document/"+jsvalue.EncodeURIComponent(documentID),
		[][2]string{{"Accept", "application/xml"}}, nil, what)
	if err != nil {
		return nil, err
	}
	if !resp.ok() {
		return nil, c.fail(resp.status, jsvalue.DecodeUTF8(resp.body), what)
	}
	if resp.readErr != nil {
		return nil, resp.readErr
	}
	contentType := resp.contentType
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	// Falco can answer 200 with an HTML error page. Writing that to <id>.xml
	// produces a file that looks like a document and parses as nothing.
	if htmlType.MatchString(contentType) {
		return nil, &apiError{
			code:       "API_ERROR",
			message:    fmt.Sprintf("Falco returned a web page instead of UBL XML for %s", documentID),
			suggestion: "The document may not be available yet. Run: agentio falco peppol list",
		}
	}
	return resp.body, nil
}

// --- Invoices (the payment-status view) ----------------------------------------

func (c *client) listInvoices(last *cursor) ([]*jsvalue.Object, error) {
	q := jsvalue.NewSearchParams()
	q.Set("organizationId", c.organizationID)
	q.Set("take", "100")
	q.Set("sortBy", "createdAt")
	q.Set("sortDirection", "desc")
	if last != nil && jsvalue.Truthy(last.value) {
		q.Set("last", jsvalue.String(last.value))
	}
	v, err := c.getJSON("/document/invoices?"+q.String(), "listing invoices")
	if err != nil {
		return nil, err
	}
	return objects(v), nil
}

func (c *client) listAllInvoices() ([]*jsvalue.Object, error) {
	return walk(c.listInvoices, nil)
}

func jsonBody(pairs ...string) []byte {
	var b bytes.Buffer
	b.WriteByte('{')
	for i := 0; i+1 < len(pairs); i += 2 {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(jsvalue.Quote(pairs[i]))
		b.WriteByte(':')
		b.WriteString(jsvalue.Quote(pairs[i+1]))
	}
	b.WriteByte('}')
	return b.Bytes()
}

var jsonContent = [][2]string{{"Content-Type", "application/json"}}

// setInvoicePaymentStatus flips the payment flag. documentID is the invoice id
// from listInvoices, not the Peppol document id.
func (c *client) setInvoicePaymentStatus(documentID, status string) error {
	what := "updating payment status for " + documentID
	resp, err := c.send(http.MethodPut, apiURL+"/document/invoices/status", jsonContent,
		jsonBody("DocumentId", documentID, "PaymentStatus", status), what)
	if err != nil {
		return err
	}
	if !resp.ok() {
		return c.fail(resp.status, jsvalue.DecodeUTF8(resp.body), what)
	}
	return nil
}

// setPeppolDocumentPaymentStatus flips the flag on a Peppol inbox row. The body
// is { Status }, not { PaymentStatus }, matching UpdatePeppolInvoiceStatus.
func (c *client) setPeppolDocumentPaymentStatus(documentID, status string) error {
	what := "updating Peppol payment status for " + documentID
	resp, err := c.send(http.MethodPut, apiURL+"/peppol/document/"+jsvalue.EncodeURIComponent(documentID)+"/status", jsonContent,
		jsonBody("Status", status), what)
	if err != nil {
		return err
	}
	if !resp.ok() {
		return c.fail(resp.status, jsvalue.DecodeUTF8(resp.body), what)
	}
	return nil
}

var alreadyImported = regexp.MustCompile(`(?i)already_imported`)

// importPeppolDocumentToFalco is the desktop transferToFalcoDocument call.
// Falco answers an already-imported document with HTTP 400 already_imported.
func (c *client) importPeppolDocumentToFalco(documentID string) (*jsvalue.Object, error) {
	what := fmt.Sprintf("importing Peppol document %s into the invoice register", documentID)
	resp, err := c.send(http.MethodPost, apiURL+"/peppol/transfer-falco", jsonContent,
		jsonBody("PeppolDocumentId", documentID), what)
	if err != nil {
		return nil, err
	}
	text := jsvalue.DecodeUTF8(resp.body)
	if !resp.ok() {
		if resp.status == 400 && alreadyImported.MatchString(text) {
			return nil, &apiError{
				code:       "INVALID_PARAMS",
				message:    fmt.Sprintf("Peppol document %s is already imported", documentID),
				suggestion: "Nothing to do. Run: agentio falco peppol list",
			}
		}
		return nil, c.fail(resp.status, text, what)
	}
	if text == "" {
		return nil, &apiError{code: "API_ERROR", message: "Falco returned an empty body while " + what}
	}
	v, err := jsvalue.Parse([]byte(text))
	if err != nil {
		return nil, malformed(what, text)
	}
	o, _ := v.(*jsvalue.Object)
	if o == nil {
		o = jsvalue.NewObject()
	}
	return o, nil
}

// --- Billing (outbound sales documents, a separate host) -----------------------

type billingTypes struct {
	invoices, creditNotes, estimates, advancePayments, proformas bool
}

func (c *client) listBillingDocuments(t billingTypes) ([]*jsvalue.Object, error) {
	what := "listing billing documents"
	body, _ := json.Marshal(struct {
		Invoices        bool
		CreditNotes     bool
		Estimates       bool
		AdvancePayments bool
		Proformas       bool
		Offset          int
	}{t.invoices, t.creditNotes, t.estimates, t.advancePayments, t.proformas, 0})
	resp, err := c.send(http.MethodPost, billingAPIURL+"/api.billing/billing-documents/period/"+jsvalue.EncodeURIComponent(c.organizationID),
		jsonContent, body, what)
	if err != nil {
		return nil, err
	}
	if resp.readErr != nil {
		return nil, resp.readErr
	}
	text := jsvalue.DecodeUTF8(resp.body)
	if !resp.ok() {
		return nil, c.fail(resp.status, text, what)
	}
	v, err := jsvalue.Parse([]byte(text))
	if err != nil || v == nil {
		// JSON.parse failing and reading a property of null both land in the
		// same catch in Bun.
		return nil, malformed(what, text)
	}
	o, _ := v.(*jsvalue.Object)
	docs, _ := valueOf(o, "BillingDocuments").([]any)
	return objects(docs), nil
}

func (c *client) downloadBillingDocumentPdf(documentID string) ([]byte, error) {
	what := "downloading billing document " + documentID
	resp, err := c.send(http.MethodGet, billingAPIURL+"/api.billing/billing-documents/src/"+jsvalue.EncodeURIComponent(documentID), nil, nil, what)
	if err != nil {
		return nil, err
	}
	if !resp.ok() {
		return nil, c.fail(resp.status, jsvalue.DecodeUTF8(resp.body), what)
	}
	if resp.readErr != nil {
		return nil, resp.readErr
	}
	return resp.body, nil
}

// validate is FalcoClient.validate. A profile is an (account, organization)
// pair, so credentials that no longer reach the organization are not valid.
func (c *client) validate() plugins.ValidationResult {
	me, err := c.getUserMe()
	if err != nil {
		return plugins.ValidationResult{Valid: false, Error: err.Error()}
	}
	for _, org := range me.organizations {
		if org.id == c.organizationID {
			return plugins.ValidationResult{Valid: true, Info: me.email + " — " + org.name}
		}
	}
	return plugins.ValidationResult{Valid: false, Error: fmt.Sprintf("%s is no longer a member of organization %s", me.email, c.organizationID)}
}

func validate(ctx context.Context, run *plugins.RunContext) (plugins.ValidationResult, error) {
	return newClient(ctx, run.Credentials, run.Fetch).validate(), nil
}
