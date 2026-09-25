package plugins

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// closedURL is a local address nothing listens on.
func closedURL(t *testing.T, scheme string) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()
	return scheme + "://" + addr + "/"
}

// serve accepts connections and hands each to handle.
func serve(t *testing.T, handle func(net.Conn)) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go handle(c)
		}
	}()
	return "http://" + ln.Addr().String() + "/"
}

type certPair struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
	der  []byte
}

func newCert(t *testing.T, name string, parent *certPair, isCA bool, notAfter time.Time, hosts ...string) *certPair {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: name},
		NotBefore: time.Now().Add(-48 * time.Hour), NotAfter: notAfter, DNSNames: hosts,
		IsCA: isCA, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	signer, signerKey := tmpl, key
	if parent != nil {
		signer, signerKey = parent.cert, parent.key
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, signer, &key.PublicKey, signerKey)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ := x509.ParseCertificate(der)
	return &certPair{cert: cert, key: key, der: der}
}

// plainHTTP is an HTTP (not TLS) server on 127.0.0.1: a TLS client hello
// gets an HTTP 400 back.
func plainHTTP(t *testing.T) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	t.Cleanup(srv.Close)
	return srv.URL + "/"
}

// tlsServer serves chain (leaf first) on 127.0.0.1.
func tlsServer(t *testing.T, chain ...*certPair) string {
	t.Helper()
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	cert := tls.Certificate{PrivateKey: chain[0].key}
	for _, c := range chain {
		cert.Certificate = append(cert.Certificate, c.der)
	}
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{cert}}
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return srv.URL + "/"
}

// A request that cannot be sent fails with the message Bun's fetch rejects
// with (probed with `bun -e` against local endpoints), not Go's
// `Get "…": dial tcp …` text, however many http.Clients wrapped it.
func TestFetchFailsToSendLikeBun(t *testing.T) {
	ca := newCert(t, "Test CA", nil, true, time.Now().Add(time.Hour))
	leaf := newCert(t, "localhost", ca, false, time.Now().Add(time.Hour), "localhost")
	expired := newCert(t, "localhost", ca, false, time.Now().Add(-24*time.Hour), "localhost")
	selfSigned := newCert(t, "localhost", nil, false, time.Now().Add(time.Hour), "localhost")
	trusted := x509.NewCertPool()
	trusted.AddCert(ca.cert)
	trust := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: trusted}}

	silent := serve(t, func(c net.Conn) { time.Sleep(5 * time.Second); c.Close() })
	closer := serve(t, func(c net.Conn) { c.Close() })
	proxy, _ := url.Parse(closedURL(t, "http"))
	dns := &http.Transport{DialContext: func(context.Context, string, string) (net.Conn, error) {
		return nil, &net.DNSError{Err: "no such host", Name: "nowhere.invalid", IsNotFound: true}
	}}
	mismatch := tlsServer(t, leaf)
	cases := []struct {
		name string
		base http.RoundTripper
		url  string
		ctx  func() (context.Context, context.CancelFunc)
		want string
	}{
		{"refused", nil, closedURL(t, "http"), nil, bunUnableToConnect},
		{"proxy refused", &http.Transport{Proxy: http.ProxyURL(proxy)}, "https://example.invalid/", nil, bunUnableToConnect},
		{"dns", dns, "http://nowhere.invalid/", nil, "getaddrinfo ENOTFOUND nowhere.invalid"},
		{"closed", nil, closer, nil, BunSocketClosed},
		{"timeout", nil, silent, func() (context.Context, context.CancelFunc) {
			return context.WithTimeout(context.Background(), 100*time.Millisecond)
		}, "The operation timed out."},
		{"abort", nil, silent, func() (context.Context, context.CancelFunc) {
			ctx, cancel := context.WithCancel(context.Background())
			time.AfterFunc(100*time.Millisecond, cancel)
			return ctx, cancel
		}, "The operation was aborted."},
		{"self signed", nil, tlsServer(t, selfSigned), nil, "self signed certificate"},
		{"unknown root sent", nil, tlsServer(t, leaf, ca), nil, "self signed certificate in certificate chain"},
		{"unknown issuer", nil, tlsServer(t, leaf), nil, "unable to verify the first certificate"},
		{"expired, trusted", trust, tlsServer(t, expired), nil, "certificate has expired"},
		{"expired, untrusted", nil, tlsServer(t, expired), nil, "unable to verify the first certificate"},
		{"plain http", nil, "https" + strings.TrimPrefix(plainHTTP(t), "http"), nil, "unknown certificate verification error"},
		{"altname", trust, mismatch, nil,
			"ERR_TLS_CERT_ALTNAME_INVALID fetching \"" + mismatch + "\". For more information, pass `verbose: true` in the second argument to fetch()"},
	}
	for _, c := range cases {
		ctx, cancel := context.Background(), context.CancelFunc(func() {})
		if c.ctx != nil {
			ctx, cancel = c.ctx()
		}
		transport := BunTransport{Base: c.base}
		// Fetch, a client over BunTransport, and a client whose transport is
		// itself a fetch (the Google libraries over the host fetch).
		direct := func(req *http.Request) (*http.Response, error) {
			return (&http.Client{Transport: transport}).Do(req)
		}
		nested := func(req *http.Request) (*http.Response, error) {
			inner := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				resp, err := (&http.Client{Transport: transport}).Do(r)
				return resp, FetchFailure(err)
			})}
			return inner.Do(req)
		}
		for via, send := range map[string]func(*http.Request) (*http.Response, error){"client": direct, "nested": nested} {
			req, _ := http.NewRequestWithContext(ctx, http.MethodGet, c.url, nil)
			resp, err := send(req)
			if err == nil {
				resp.Body.Close()
				t.Errorf("%s via %s: no error", c.name, via)
				continue
			}
			if got := FetchFailure(err).Error(); got != c.want {
				t.Errorf("%s via %s:\n got %q\nwant %q", c.name, via, got, c.want)
			}
		}
		cancel()
	}
	// The host fetch returns the bare error.
	req, _ := http.NewRequest(http.MethodGet, closedURL(t, "http"), nil)
	if _, err := Fetch(context.Background(), req); err == nil || err.Error() != bunUnableToConnect {
		t.Errorf("Fetch: %v", err)
	}
	// An error that is not a failed send keeps its text.
	other := errors.New("boom")
	if FetchFailure(nil) != nil || FetchFailure(other) != other || FetchFailure(&url.Error{Op: "Get", URL: "u", Err: other}).Error() != `Get "u": boom` {
		t.Error("FetchFailure changed an unrelated error")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// A proxy that refuses the CONNECT answers the request: Bun's fetch resolves
// with the proxy's response (status, headers, body), it does not reject.
// Probed: `HTTPS_PROXY=… bun -e 'await fetch("https://example.invalid/x")'`
// against a proxy answering `407 Proxy Auth Required` gives 407, "denied".
func TestProxyRefusingConnectIsTheResponse(t *testing.T) {
	proxyAddr := serve(t, func(c net.Conn) {
		buf := make([]byte, 4096)
		_, _ = c.Read(buf)
		_, _ = c.Write([]byte("HTTP/1.1 407 Proxy Auth Required\r\nContent-Type: text/plain\r\nX-P: 1\r\nContent-Length: 6\r\n\r\ndenied"))
		c.Close()
	})
	proxy, _ := url.Parse(proxyAddr)
	for _, base := range []*http.Transport{{Proxy: http.ProxyURL(proxy)}, {Proxy: http.ProxyURL(proxy)}} {
		for i := 0; i < 2; i++ { // the same transport twice
			req, _ := http.NewRequest(http.MethodGet, "https://example.invalid/x", nil)
			resp, err := (&http.Client{Transport: BunTransport{Base: base}}).Do(req)
			if err != nil {
				t.Fatalf("error %v", err)
			}
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode != 407 || resp.Status != "407 Proxy Auth Required" || string(body) != "denied" || resp.Header.Get("X-P") != "1" {
				t.Fatalf("%d %q %q %v", resp.StatusCode, resp.Status, body, resp.Header)
			}
		}
		if base.OnProxyConnectResponse != nil {
			t.Fatal("the caller's transport was changed")
		}
	}
}
