package auth_test

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/plosson/agentio/go/internal/auth"
	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/testbox"
)

// Bun's hubCall reads the answer with response.text(), which rejects when the
// connection drops mid-body: the plain TypeError, whatever the status.
func TestHubCallFailsLikeBunWhenTheAnswerIsCut(t *testing.T) {
	testbox.Isolate(t)
	for _, status := range []int{200, 500} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			testbox.CutShort(t, w, status)
		}))
		raw, _, err := auth.HubCall(srv.URL, "/v1/profiles", auth.Call{Token: "t"})
		srv.Close()
		if _, isCli := err.(*clierr.Error); isCli || raw != nil {
			t.Errorf("%d: %q %#v", status, raw, err)
		}
		testbox.WantSocketClosed(t, err)
	}
}

// Bun's remoteCredentials POSTs with no body, so no Content-Type either.
func TestRemoteCredentialsPostsNoBody(t *testing.T) {
	testbox.Isolate(t)
	var gotBody, gotType string
	var gotLength int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotBody, gotType, gotLength = string(b), r.Header.Get("Content-Type"), r.ContentLength
		_, _ = io.WriteString(w, `{"credentials":{"a":"b"}}`)
	}))
	defer srv.Close()
	token, _ := auth.EncodeToken(auth.TokenParts{URL: srv.URL, Kid: "k", Secret: "s"})
	t.Setenv("AGENTIO_TOKEN", token)
	auth.Reset()
	creds, err := auth.RemoteCredentials("acme", "ada")
	if err != nil || creds["a"] != "b" {
		t.Fatalf("%#v %v", creds, err)
	}
	if gotBody != "" || gotType != "" || gotLength != 0 {
		t.Errorf("body %q, Content-Type %q, length %d", gotBody, gotType, gotLength)
	}
}
