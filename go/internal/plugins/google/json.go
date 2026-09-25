package google

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"sync"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
	"google.golang.org/api/googleapi"
)

// Call is a google.golang.org/api call (tasks.TasksGetCall, ...) whose Do
// answers T.
type Call[C, T any] interface {
	Context(context.Context) C
	Do(...googleapi.CallOption) (T, error)
}

// Answer runs call under ctx, as call.Context(ctx).Do(opts...), and returns
// the answer both as the SDK decoded it and as Bun's googleapis client reads
// it (response.data, see gaxiosData): there a missing field is undefined and
// null is null, where the typed struct has "" or 0 for both. The SDK still
// builds and sends the request.
//
// An answer the typed struct cannot hold (a number where it wants a string,
// a body that is not JSON) is no error in Bun, which never decodes into a
// type: Answer then returns the zero T with the answer and no error. An HTTP
// failure, a failed send and a body cut short fail as the SDK reports them.
//
// Only the response the SDK decodes is kept (not a retried or refreshed
// attempt's, nor a redirect's), only for a JSON call (alt=json, never a media
// download), and only for this call: a call made outside Answer records
// nothing.
func Answer[C Call[C, T], T any](ctx context.Context, call C, opts ...googleapi.CallOption) (T, any, error) {
	rec := &recorder{}
	v, err := call.Context(context.WithValue(ctx, recorderKey{}, rec)).Do(opts...)
	status, body, complete := rec.answer()
	if err != nil {
		var ge *googleapi.Error
		if errors.As(err, &ge) || !complete || status < 200 || status > 299 {
			return v, nil, err
		}
		var zero T
		v = zero
	}
	return v, gaxiosData(status, body), nil
}

// gaxiosData is the response.data gaxios gives a googleapis call for a JSON
// answer: "" for 204, the body JSON.parse'd, or its text when it is not JSON.
func gaxiosData(status int, body []byte) any {
	if status == http.StatusNoContent {
		return ""
	}
	if v, err := jsvalue.Parse(body); err == nil {
		return v
	}
	return jsvalue.DecodeUTF8(body)
}

type recorderKey struct{}

// recorder holds the body of the last JSON response sent under an Answer
// context. complete is whether it was read to its end.
type recorder struct {
	mu       sync.Mutex
	status   int
	body     *bytes.Buffer
	complete bool
}

func (r *recorder) answer() (int, []byte, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.body == nil {
		return r.status, nil, false
	}
	return r.status, bytes.Clone(r.body.Bytes()), r.complete
}

// recordTransport tees a JSON answer into the Answer recorder on the
// request's context. The body the SDK reads is unchanged: same bytes, same
// errors.
type recordTransport struct{ base http.RoundTripper }

func (t recordTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	resp, err := t.base.RoundTrip(req)
	if err != nil || resp == nil || resp.Body == nil {
		return resp, err
	}
	rec, _ := req.Context().Value(recorderKey{}).(*recorder)
	if rec == nil || req.URL.Query().Get("alt") != "json" {
		return resp, err
	}
	buf := &bytes.Buffer{}
	rec.mu.Lock()
	rec.status, rec.body, rec.complete = resp.StatusCode, buf, false
	rec.mu.Unlock()
	resp.Body = &teeBody{ReadCloser: resp.Body, rec: rec, buf: buf}
	return resp, nil
}

type teeBody struct {
	io.ReadCloser
	rec *recorder
	buf *bytes.Buffer
}

func (b *teeBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	b.rec.mu.Lock()
	b.buf.Write(p[:n])
	if err == io.EOF && b.rec.body == b.buf {
		b.rec.complete = true
	}
	b.rec.mu.Unlock()
	return n, err
}

// Close reads what the SDK left of the answer (a JSON decoder stops at the
// end of the value, or at the first byte it cannot use) before closing, so
// the answer is the whole body, as gaxios reads it.
func (b *teeBody) Close() error {
	_, _ = io.Copy(io.Discard, struct{ io.Reader }{b})
	return b.ReadCloser.Close()
}

// CallJSON sends body verbatim (nil for none) to basePath+path with the
// profile's token and returns the answer as gaxios reads it (gaxiosData). basePath
// is a product client's BasePath, so WithEndpoints applies. A failure is a
// *googleapi.Error, so ErrorCode, Message and StatusMessage read it.
//
// It is only for a call no google.golang.org/api client can make as Bun
// makes it (a body sent verbatim, such as a batchUpdate escape hatch). Any
// other call goes through the SDK, with Answer when its JSON is needed.
func CallJSON(ctx context.Context, run *plugins.RunContext, keys Keys, method, basePath, path string, body []byte) (any, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, basePath+path, reader)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := HTTPClient(ctx, run, keys).Do(req)
	if err != nil {
		return nil, plugins.FetchFailure(err)
	}
	defer resp.Body.Close()
	if err := googleapi.CheckResponse(resp); err != nil {
		return nil, err
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	return gaxiosData(resp.StatusCode, raw), nil
}
