package plugins

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"syscall"
	"time"
)

// FetchError is the error Bun's fetch rejects with when a request cannot be
// sent: its Error() is the message Bun shows (error.message). Err is the Go
// failure it stands for.
type FetchError struct {
	Message string
	Err     error
}

func (e *FetchError) Error() string { return e.Message }
func (e *FetchError) Unwrap() error { return e.Err }

// FetchFailure is err without the *url.Error an http.Client wraps a failed
// send in (once per client when one client's transport is another's fetch):
// Bun's fetch rejects with the bare error. Any other error is returned as is.
func FetchFailure(err error) error {
	inner := err
	for {
		ue, ok := inner.(*url.Error)
		if !ok {
			break
		}
		inner = ue.Err
	}
	if fe, ok := inner.(*FetchError); ok {
		return fe
	}
	return err
}

// Bun's fetch messages, probed with `bun -e` against local endpoints.
const (
	bunUnableToConnect = "Unable to connect. Is the computer able to access the url?"
	bunTimedOut        = "The operation timed out."
	bunAborted         = "The operation was aborted."
)

// fetchError maps a failed send to Bun's fetch error. roots are the trusted
// roots of the transport that failed (nil: the system's). An error Bun has no
// known wording for is returned unchanged.
func fetchError(req *http.Request, err error, roots *x509.CertPool) error {
	if msg := fetchMessage(req, err, roots); msg != "" {
		return &FetchError{Message: msg, Err: err}
	}
	return err
}

func fetchMessage(req *http.Request, err error, roots *x509.CertPool) string {
	var timeout interface{ Timeout() bool }
	var dns *net.DNSError
	var verify *tls.CertificateVerificationError
	switch {
	case errors.Is(err, context.DeadlineExceeded) || errors.As(err, &timeout) && timeout.Timeout():
		return bunTimedOut
	case errors.Is(err, context.Canceled):
		return bunAborted
	case errors.As(err, &dns) && dns.IsNotFound:
		return "getaddrinfo ENOTFOUND " + dns.Name
	case errors.Is(err, syscall.ECONNREFUSED):
		return bunUnableToConnect
	case errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.EPIPE) ||
		errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF):
		return BunSocketClosed
	case errors.As(err, &verify):
		return certificateMessage(req, verify.UnverifiedCertificates, roots)
	}
	return ""
}

// certificateMessage is the BoringSSL/Node wording Bun gives a certificate it
// refuses, checked in its order: trust, then validity, then the host name.
// The platform verifier's own error is not used: its type differs by OS.
func certificateMessage(req *http.Request, certs []*x509.Certificate, roots *x509.CertPool) string {
	if len(certs) == 0 {
		return ""
	}
	leaf := certs[0]
	intermediates := x509.NewCertPool()
	for _, c := range certs[1:] {
		intermediates.AddCert(c)
	}
	// Trust, judged at a time the leaf is valid so expiry does not mask it.
	at := time.Now()
	if at.After(leaf.NotAfter) {
		at = leaf.NotAfter.Add(-time.Second)
	} else if at.Before(leaf.NotBefore) {
		at = leaf.NotBefore.Add(time.Second)
	}
	chains, err := leaf.Verify(x509.VerifyOptions{Roots: roots, Intermediates: intermediates, CurrentTime: at})
	if err != nil {
		last := certs[len(certs)-1]
		switch {
		case len(certs) == 1 && selfSigned(leaf):
			return "self signed certificate"
		case len(certs) > 1 && selfSigned(last):
			return "self signed certificate in certificate chain"
		case len(certs) == 1:
			return "unable to verify the first certificate"
		}
		return "unable to get local issuer certificate"
	}
	now := time.Now()
	for _, c := range chains[0] {
		if now.After(c.NotAfter) {
			return "certificate has expired"
		}
		if now.Before(c.NotBefore) {
			return "certificate is not yet valid"
		}
	}
	if leaf.VerifyHostname(req.URL.Hostname()) != nil {
		return "ERR_TLS_CERT_ALTNAME_INVALID fetching \"" + req.URL.String() + "\". For more information, pass `verbose: true` in the second argument to fetch()"
	}
	return ""
}

// selfSigned is OpenSSL's test: issued by its own subject and signed by its
// own key, whatever its CA flag.
func selfSigned(c *x509.Certificate) bool {
	return bytes.Equal(c.RawIssuer, c.RawSubject) && c.CheckSignature(c.SignatureAlgorithm, c.RawTBSCertificate, c.Signature) == nil
}

// transportRoots are the roots base trusts, when it says (nil: the system's).
func transportRoots(base http.RoundTripper) *x509.CertPool {
	if t, ok := base.(*http.Transport); ok && t.TLSClientConfig != nil {
		return t.TLSClientConfig.RootCAs
	}
	return nil
}
