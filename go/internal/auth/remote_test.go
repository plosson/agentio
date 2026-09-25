package auth_test

import (
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
