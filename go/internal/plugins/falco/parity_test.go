package falco_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/plosson/agentio/go/internal/cli"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/profile"
	"github.com/plosson/agentio/go/internal/testbox"
	"github.com/plosson/agentio/go/internal/vault"
)

// The files under testdata/bun are what the Bun CLI printed for the same
// commands, against a mock that behaves like the fixture server below, with the same
// fixture vault. Each scenario resets the mock, as the capture did.

var falcoHosts = map[string]bool{
	"accounts.horus-software.be":         true,
	"api.my-falco.be":                    true,
	"horusapi-billing.azurewebsites.net": true,
}

type rewrite struct {
	target *url.URL
	base   http.RoundTripper
}

func (r rewrite) RoundTrip(req *http.Request) (*http.Response, error) {
	if !falcoHosts[req.URL.Host] {
		return nil, fmt.Errorf("blocked external request to %s", req.URL.Host)
	}
	out := req.Clone(req.Context())
	out.URL.Scheme = r.target.Scheme
	out.URL.Host = r.target.Host
	out.Host = r.target.Host
	out.Header.Set("X-Orig-Host", req.URL.Host)
	return r.base.RoundTrip(out)
}

type fixture struct {
	raw   []byte
	ubl   map[string][]byte
	mu    sync.Mutex
	state map[string]any
	log   []string
}

// orderedJSON re-encodes a fixture record with the key order of data.json,
// which a Go map would lose: the Bun mock serves records in file order.
func (f *fixture) orderedJSON(v any) []byte {
	var b bytes.Buffer
	var enc func(v any)
	enc = func(v any) {
		switch t := v.(type) {
		case map[string]any:
			keys, _ := t["\x00keys"].([]string)
			b.WriteByte('{')
			first := true
			for _, k := range keys {
				val, ok := t[k]
				if !ok {
					continue
				}
				if !first {
					b.WriteByte(',')
				}
				first = false
				kb, _ := json.Marshal(k)
				b.Write(kb)
				b.WriteByte(':')
				enc(val)
			}
			b.WriteByte('}')
		case []any:
			b.WriteByte('[')
			for i, e := range t {
				if i > 0 {
					b.WriteByte(',')
				}
				enc(e)
			}
			b.WriteByte(']')
		default:
			var x bytes.Buffer
			e := json.NewEncoder(&x)
			e.SetEscapeHTML(false)
			_ = e.Encode(t)
			b.Write(bytes.TrimSuffix(x.Bytes(), []byte("\n")))
		}
	}
	enc(v)
	return b.Bytes()
}

// decodeOrdered decodes JSON into maps that remember their key order.
func decodeOrdered(dec *json.Decoder) any {
	tok, _ := dec.Token()
	switch t := tok.(type) {
	case json.Delim:
		if t == '{' {
			m := map[string]any{}
			var keys []string
			for dec.More() {
				k, _ := dec.Token()
				key := k.(string)
				keys = append(keys, key)
				m[key] = decodeOrdered(dec)
			}
			_, _ = dec.Token()
			m["\x00keys"] = keys
			return m
		}
		var arr []any
		for dec.More() {
			arr = append(arr, decodeOrdered(dec))
		}
		_, _ = dec.Token()
		if arr == nil {
			arr = []any{}
		}
		return arr
	default:
		return t
	}
}

func (f *fixture) resetOrdered() {
	f.mu.Lock()
	defer f.mu.Unlock()
	dec := json.NewDecoder(bytes.NewReader(f.raw))
	dec.UseNumber()
	f.state = decodeOrdered(dec).(map[string]any)
	f.log = nil
}

func (f *fixture) list(key string) []any {
	arr, _ := f.state[key].([]any)
	return arr
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	raw, err := os.ReadFile("testdata/data.json")
	if err != nil {
		t.Fatal(err)
	}
	f := &fixture{raw: raw, ubl: map[string][]byte{}}
	for id, file := range map[string]string{"pep-1111-aaaa": "ubl1.xml", "pep-2222-bbbb": "ubl2.xml"} {
		if f.ubl[id], err = os.ReadFile(filepath.Join("testdata", file)); err != nil {
			t.Fatal(err)
		}
	}
	f.resetOrdered()
	srv := httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(srv.Close)
	target, _ := url.Parse(srv.URL)
	prev := http.DefaultTransport
	http.DefaultTransport = rewrite{target: target, base: srv.Client().Transport}
	t.Cleanup(func() { http.DefaultTransport = prev })
	return f
}

var (
	statusPath   = regexp.MustCompile(`^/peppol/document/([^/]+)/status$`)
	documentPath = regexp.MustCompile(`^/peppol/document/([^/]+)$`)
	billingPath  = regexp.MustCompile(`^/api\.billing/billing-documents/src/([^/]+)$`)
)

func (f *fixture) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	raw, _ := io.ReadAll(r.Body)
	body := string(raw)
	if mt, params, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); mt == "multipart/form-data" {
		mr := multipart.NewReader(bytes.NewReader(raw), params["boundary"])
		var entries [][2]string
		for {
			part, err := mr.NextPart()
			if err != nil {
				break
			}
			v, _ := io.ReadAll(part)
			entries = append(entries, [2]string{part.FormName(), string(v)})
		}
		b, _ := json.Marshal(entries)
		body = string(b)
	}
	search := ""
	if r.URL.RawQuery != "" {
		search = "?" + r.URL.RawQuery
	}
	p := r.URL.EscapedPath()
	f.log = append(f.log, fmt.Sprintf("%s %s %s%s %s %s", r.Header.Get("X-Orig-Host"), r.Method, p, search, r.Header.Get("Authorization"), body))
	send := func(status int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write(f.orderedJSON(v))
	}
	hasLast := r.URL.Query().Has("last")
	var in map[string]any
	_ = json.Unmarshal(raw, &in)

	switch {
	case p == "/oauth2/token":
		send(200, map[string]any{"\x00keys": []string{"access_token", "refresh_token", "expires_in", "refresh_token_expires_in"},
			"access_token": "at-rotated", "refresh_token": "rt-rotated", "expires_in": 600, "refresh_token_expires_in": 2592000})
	case p == "/user/me":
		send(200, f.state["me"])
	case p == "/peppol/documents/org-1":
		if hasLast {
			send(200, []any{})
		} else {
			send(200, f.list("peppol"))
		}
	case p == "/document/invoices":
		if hasLast {
			send(200, []any{})
		} else {
			send(200, f.list("invoices"))
		}
	case p == "/document/invoices/status" && r.Method == http.MethodPut:
		for _, i := range f.list("invoices") {
			if m := i.(map[string]any); m["id"] == in["DocumentId"] {
				m["paymentStatus"] = in["PaymentStatus"]
			}
		}
	case statusPath.MatchString(p) && r.Method == http.MethodPut:
		id, _ := url.PathUnescape(statusPath.FindStringSubmatch(p)[1])
		for _, d := range f.list("peppol") {
			if m := d.(map[string]any); m["id"] == id {
				m["paymentStatus"] = in["Status"]
			}
		}
	case documentPath.MatchString(p):
		id, _ := url.PathUnescape(documentPath.FindStringSubmatch(p)[1])
		if x, ok := f.ubl[id]; ok {
			w.Header().Set("Content-Type", "application/xml; charset=utf-8")
			_, _ = w.Write(x)
			return
		}
		w.WriteHeader(500)
		_, _ = io.WriteString(w, "boom")
	case p == "/peppol/transfer-falco":
		for _, d := range f.list("peppol") {
			m := d.(map[string]any)
			if m["id"] != in["PeppolDocumentId"] {
				continue
			}
			if m["importState"] == "Imported" {
				w.WriteHeader(400)
				_, _ = io.WriteString(w, `{"errorType":"already_imported"}`)
				return
			}
			m["importState"] = "Imported"
			m["importDate"] = "2026-09-22T12:00:00Z"
			first := f.list("invoices")[0].(map[string]any)
			inv := map[string]any{}
			for k, v := range first {
				inv[k] = v
			}
			inv["id"], inv["peppolInvoiceId"], inv["invoiceReference"] = "inv-2", m["id"], m["invoiceReference"]
			inv["supplierName"], inv["amount"], inv["invoiceCurrency"] = "Silversquare Belgium", m["amount"], m["currency"]
			f.state["invoices"] = append(f.list("invoices"), inv)
			send(200, m)
			return
		}
	case p == "/api.billing/billing-documents/period/org-1":
		send(200, map[string]any{"\x00keys": []string{"BillingDocuments"}, "BillingDocuments": f.list("billing")})
	case billingPath.MatchString(p):
		id := billingPath.FindStringSubmatch(p)[1]
		if id == "bill-0002-yyyy" {
			w.WriteHeader(404)
			_, _ = io.WriteString(w, "not found")
			return
		}
		w.Header().Set("Content-Type", "application/pdf")
		_, _ = io.WriteString(w, "%PDF-billing "+id)
	default:
		w.WriteHeader(404)
		_, _ = io.WriteString(w, "no route")
	}
}

func seedVault(t *testing.T) {
	t.Helper()
	testbox.Isolate(t)
	t.Setenv("AGENTIO_PASSPHRASE", "fixture-pass-123")
	if err := vault.Create(vault.DefaultVaultPath(), "fixture-pass-123", vault.EmptyContents()); err != nil {
		t.Fatal(err)
	}
	base := func(expiry int64, access string) map[string]any {
		return map[string]any{
			"refreshToken": "rt-old", "refreshExpiryDate": int64(4102444800000), "accessToken": access, "expiryDate": expiry,
			"organizationId": "org-1", "organizationName": "Acme BV", "userId": "user-1", "userEmail": "pierre@example.com",
		}
	}
	stale := base(1, "at-old")
	stale["legacy"] = "kept"
	for _, p := range []struct {
		name  string
		creds map[string]any
		ro    bool
	}{{"acme", base(4102444800000, "at-live"), false}, {"stale", stale, false}, {"ro", base(4102444800000, "at-live"), true}} {
		opts := profile.SaveOptions{}
		if p.ro {
			opts = profile.SaveOptions{ReadOnlySet: true, ReadOnly: true}
		}
		if err := profile.Save("falco", p.name, p.creds, opts); err != nil {
			t.Fatal(err)
		}
	}
}

// withStderr points os.Stderr at a pipe while fn runs and copies what was
// written into buf.
func withStderr(t *testing.T, buf *bytes.Buffer, fn func() int) int {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	prev := os.Stderr
	os.Stderr = w
	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(buf, r)
		close(done)
	}()
	code := fn()
	os.Stderr = prev
	_ = w.Close()
	<-done
	_ = r.Close()
	return code
}

func golden(t *testing.T, dir, name, ext string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, name+"."+ext))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// The stdout, stderr, exit code and requests of each command match what the
// Bun CLI produced. Only a rendered PDF's size differs (different PDF writer).
func TestCLIMatchesTheBunCapture(t *testing.T) {
	seedVault(t)
	f := newFixture(t)
	goldenDir, err := filepath.Abs(filepath.Join("testdata", "bun"))
	if err != nil {
		t.Fatal(err)
	}
	t.Chdir(t.TempDir())

	scenarios := []struct {
		name string
		args []string
	}{
		{"01-list", strings.Fields("falco peppol list --profile acme")},
		{"02-list-json", strings.Fields("falco peppol list --profile acme --format json")},
		{"03-list-filter", strings.Fields("falco peppol list --profile acme --since 2026-07-01 --sender ACME")},
		{"04-list-baddate", strings.Fields("falco peppol list --profile acme --since 2026-7-1")},
		{"05-get-stdout", strings.Fields("falco peppol get pep-1111-aaaa --profile acme --output -")},
		{"06-get-pdf", strings.Fields("falco peppol get pep-1111-aaaa --profile acme --output got --extract-pdf")},
		{"07-get-render", strings.Fields("falco peppol get pep-2222-bbbb --profile acme --extract-pdf")},
		{"08-sync", strings.Fields("falco peppol sync --profile acme --output synced --extract-pdf")},
		{"09-sync-again", strings.Fields("falco peppol sync --profile acme --output synced --extract-pdf")},
		{"10-markpaid-invoice", strings.Fields("falco peppol mark-paid INV/2026/9 --profile acme --format json")},
		{"11-markpaid-peppol", strings.Fields("falco peppol mark-paid DT20261474 --profile acme")},
		{"12-markpaid-badstatus", strings.Fields("falco peppol mark-paid X --profile acme --status Maybe --unpaid")},
		{"13-markpaid-already", strings.Fields("falco peppol mark-paid INV/2026/9 --profile acme --unpaid --format json")},
		{"14-import-dry", strings.Fields("falco peppol import DT20261474 --profile acme --dry-run --format json")},
		{"15-import-already", strings.Fields("falco peppol import pep-1111-aaaa --profile acme")},
		{"16-import", strings.Fields("falco peppol import +++123/456/789+++ --profile acme --format json")},
		{"17-import-missing", strings.Fields("falco peppol import nope --profile acme")},
		{"18-invoices-sync", strings.Fields("falco invoices sync --profile acme --output sales")},
		{"19-invoices-sync-again", strings.Fields("falco invoices sync --profile acme --output sales --include Invoice,CreditNote,Estimate")},
		{"20-invoices-badinclude", []string{"falco", "invoices", "sync", "--profile", "acme", "--output", "sales", "--include", " , "}},
		{"21-profile-list", strings.Fields("falco profile list")},
		{"22-ro-markpaid", strings.Fields("falco peppol mark-paid INV/2026/9 --profile ro")},
		{"23-ro-import-dry", strings.Fields("falco peppol import DT20261474 --profile ro --dry-run")},
		{"24-ro-import", strings.Fields("falco peppol import DT20261474 --profile ro")},
		{"25-sync-nomatch", strings.Fields("falco peppol sync --profile acme --output empty --sender nobody")},
		{"26-refresh", strings.Fields("falco peppol list --profile stale --sender nobody")},
	}
	for _, s := range scenarios {
		f.resetOrdered()
		var out, errOut bytes.Buffer
		// Progress goes through RunContext.Log, which writes to the process
		// stderr; capture it with the error the CLI renders, in order.
		code := withStderr(t, &errOut, func() int {
			return cli.Execute(plugins.Default, s.args, &out, os.Stderr, strings.NewReader(""))
		})

		if want := strings.TrimSpace(golden(t, goldenDir, s.name, "code")); fmt.Sprint(code) != want {
			t.Errorf("%s: exit %d, Bun %s\n%s", s.name, code, want, errOut.String())
		}
		if want := golden(t, goldenDir, s.name, "out"); out.String() != want {
			t.Errorf("%s stdout:\n got %q\nwant %q", s.name, out.String(), want)
		}
		wantErr := golden(t, goldenDir, s.name, "err")
		gotErr := errOut.String()
		if s.name == "07-get-render" {
			// The rendition comes from a different PDF writer; only its size differs.
			size := regexp.MustCompile(`\(\d+ bytes, rendered from UBL\)`)
			wantErr = size.ReplaceAllString(wantErr, "(N bytes, rendered from UBL)")
			gotErr = size.ReplaceAllString(gotErr, "(N bytes, rendered from UBL)")
		}
		if gotErr != wantErr {
			t.Errorf("%s stderr:\n got %q\nwant %q", s.name, gotErr, wantErr)
		}
		f.mu.Lock()
		gotLog := strings.Join(f.log, "\n")
		f.mu.Unlock()
		if want := strings.TrimSuffix(golden(t, goldenDir, s.name, "log"), "\n"); gotLog != want {
			t.Errorf("%s requests:\n got %s\nwant %s", s.name, gotLog, want)
		}
	}

	// Files written by the commands, byte for byte except rendered PDFs.
	for path, want := range map[string]string{
		"got":     string(f.ubl["pep-1111-aaaa"]),
		"got.pdf": "%PDF-1.4 fake",
		"synced/2026-07-14_acme-bv_INV-2026-9.pdf":                                  "%PDF-1.4 fake",
		"sales/2026-07-02_cafe-reunion-sprl_42.pdf":                                 "%PDF-billing bill-0001-xxxx",
		"sales/2026-07-04_other_bill-000.pdf":                                       "%PDF-billing bill-0003-zzzz",
		"pep-2222-bbbb.xml":                                                         string(f.ubl["pep-2222-bbbb"]),
		"synced/2026-07-14_acme-bv_INV-2026-9.xml":                                  string(f.ubl["pep-1111-aaaa"]),
		"synced/2026-08-18_silversquare-belgium-tres-long-nom-de-fo_DT20261474.xml": string(f.ubl["pep-2222-bbbb"]),
	} {
		got, err := os.ReadFile(path)
		if err != nil || string(got) != want {
			t.Errorf("%s: %q %v", path, got, err)
		}
	}
	for _, path := range []string{"pep-2222-bbbb.pdf", "synced/2026-08-18_silversquare-belgium-tres-long-nom-de-fo_DT20261474.pdf"} {
		if got, err := os.ReadFile(path); err != nil || !bytes.HasPrefix(got, []byte("%PDF-")) {
			t.Errorf("%s is not a PDF: %v", path, err)
		}
	}
	// The manifest has Bun's shape and key order; only the timestamp differs.
	manifest, _ := os.ReadFile("synced/.manifest.json")
	stamp := regexp.MustCompile(`"updated_at": "\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z"`)
	wantManifest := "{\n  \"version\": 1,\n  \"updated_at\": \"T\",\n  \"entries\": {\n" +
		"    \"pep-1111-aaaa\": \"2026-07-14_acme-bv_INV-2026-9\",\n" +
		"    \"pep-2222-bbbb\": \"2026-08-18_silversquare-belgium-tres-long-nom-de-fo_DT20261474\",\n" +
		"    \"pep-3333-cccc\": \"2026-06-01_unknown_pep-3333\"\n  }\n}"
	if got := stamp.ReplaceAllString(string(manifest), `"updated_at": "T"`); got != wantManifest {
		t.Errorf("manifest:\n%s", manifest)
	}
	if info, err := os.Stat("synced/.manifest.json"); err != nil || info.Mode().Perm() != 0o600 {
		t.Errorf("manifest mode %v %v", info, err)
	}

	// After the refresh the stored credential has Bun's keys and values:
	// {"refreshToken":"rt-rotated","refreshExpiryDate":…,"accessToken":"at-rotated",
	//  "organizationId":"org-1","organizationName":"Acme BV","userId":"user-1",
	//  "userEmail":"pierre@example.com","expiryDate":…,"legacy":"kept"}
	c, err := vault.Load()
	if err != nil {
		t.Fatal(err)
	}
	stored := c.Credentials["falco"]["stale"]
	now := time.Now().UnixMilli()
	exp, _ := stored["expiryDate"].(json.Number).Int64()
	rexp, _ := stored["refreshExpiryDate"].(json.Number).Int64()
	if len(stored) != 9 || stored["refreshToken"] != "rt-rotated" || stored["accessToken"] != "at-rotated" ||
		stored["organizationId"] != "org-1" || stored["organizationName"] != "Acme BV" || stored["userId"] != "user-1" ||
		stored["userEmail"] != "pierre@example.com" || stored["legacy"] != "kept" ||
		exp < now+590_000 || exp > now+600_000 || rexp < now+2591990_000 || rexp > now+2592000_000 {
		t.Fatalf("refreshed credential %#v", stored)
	}
}
