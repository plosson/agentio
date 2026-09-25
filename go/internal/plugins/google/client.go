package google

import (
	"context"
	"io"
	"math"
	"net/http"
	"time"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
	"golang.org/x/oauth2"
	"google.golang.org/api/googleapi"
	"google.golang.org/api/option"
)

// Endpoints replaces Google's URLs for the calls made under a context. Tests
// point them at an httptest server; production never sets them.
type Endpoints struct {
	// API is passed to option.WithEndpoint for every product client.
	API string
	// Token replaces https://oauth2.googleapis.com/token.
	Token string
	// UserInfo replaces https://www.googleapis.com/oauth2/v2/userinfo.
	UserInfo string
}

type endpointsKey struct{}

// WithEndpoints returns ctx carrying e.
func WithEndpoints(ctx context.Context, e Endpoints) context.Context {
	return context.WithValue(ctx, endpointsKey{}, e)
}

func endpointsFrom(ctx context.Context) Endpoints {
	if ctx == nil {
		return Endpoints{}
	}
	e, _ := ctx.Value(endpointsKey{}).(Endpoints)
	return e
}

// NewService builds a google.golang.org/api product client (calendar.NewService,
// drive.NewService, ...) that sends the profile's stored access token:
//
//	svc, err := google.NewService(ctx, run, google.Snake, calendar.NewService)
//
// The client never refreshes or persists a token; the host refreshed the
// credentials before the command ran.
func NewService[T any](ctx context.Context, run *plugins.RunContext, keys Keys, newService func(context.Context, ...option.ClientOption) (T, error)) (T, error) {
	return newService(ctx, ClientOptions(ctx, run, keys)...)
}

// ClientOptions is what NewService passes to the product constructor.
func ClientOptions(ctx context.Context, run *plugins.RunContext, keys Keys) []option.ClientOption {
	opts := []option.ClientOption{option.WithHTTPClient(HTTPClient(run, keys))}
	if ep := endpointsFrom(ctx).API; ep != "" {
		opts = append(opts, option.WithEndpoint(ep))
	}
	return opts
}

// MaxResults is Bun `maxResults: Math.min(limit, max)` as googleapis puts it
// on the query string: a --limit that parseInt read as NaN is sent as "NaN".
func MaxResults(limit, max float64) googleapi.CallOption {
	if !math.IsNaN(limit) {
		limit = math.Min(limit, max)
	}
	return googleapi.QueryParameter("maxResults", jsvalue.NumberString(limit))
}

// HTTPClient sends the stored access token through the host's Fetch, with
// googleapis' retry policy. Use it for the few calls no product SDK covers.
func HTTPClient(run *plugins.RunContext, keys Keys) *http.Client {
	fetch := run.Fetch
	if fetch == nil {
		fetch = plugins.Fetch
	}
	stored := keys.Read(run.Credentials)
	source := oauth2.StaticTokenSource(&oauth2.Token{AccessToken: stored.AccessToken, TokenType: stored.TokenType})
	return &http.Client{Transport: &oauth2.Transport{
		Source: source,
		Base:   &retryTransport{base: fetchTransport(fetch), methods: apiRetryMethods},
	}}
}

type fetchTransport fetchFunc

func (f fetchTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req.Context(), req)
}

var (
	// apiRetryMethods is gaxios' default httpMethodsToRetry (googleapis-common).
	apiRetryMethods = map[string]bool{"GET": true, "HEAD": true, "PUT": true, "OPTIONS": true, "DELETE": true}
	// tokenRetryMethods is google-auth-library OAuth2Client.RETRY_CONFIG.
	tokenRetryMethods = map[string]bool{"GET": true, "HEAD": true, "PUT": true, "POST": true, "OPTIONS": true, "DELETE": true}
)

const (
	maxRetries        = 3
	noResponseRetries = 2
)

// sleep waits between retries; tests replace it.
var sleep = func(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// retryTransport is gaxios' retry: 408, 429 and 5xx up to 3 times, a network
// failure up to 2 times, only for methods, with its 100ms, 500ms, 1500ms delays.
type retryTransport struct {
	base    http.RoundTripper
	methods map[string]bool
}

func (t *retryTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	for attempt := 0; ; attempt++ {
		try := req
		if attempt > 0 && req.Body != nil {
			body, err := req.GetBody()
			if err != nil {
				return nil, err
			}
			try = req.Clone(req.Context())
			try.Body = body
		}
		resp, err := t.base.RoundTrip(try)
		if !t.shouldRetry(req, resp, err, attempt) {
			return resp, err
		}
		if resp != nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
		}
		if err := sleep(req.Context(), retryDelay(attempt)); err != nil {
			return nil, err
		}
	}
}

func (t *retryTransport) shouldRetry(req *http.Request, resp *http.Response, err error, attempt int) bool {
	if req.Context().Err() != nil || !t.methods[req.Method] || attempt >= maxRetries {
		return false
	}
	if req.Body != nil && req.GetBody == nil {
		return false
	}
	if err != nil {
		return resp == nil && attempt < noResponseRetries
	}
	s := resp.StatusCode
	return s == 408 || s == 429 || (s >= 500 && s <= 599)
}

// retryDelay is gaxios getNextRetryDelay with retryDelay 100 and multiplier 2.
func retryDelay(attempt int) time.Duration {
	if attempt == 0 {
		return 100 * time.Millisecond
	}
	return time.Duration(((1<<attempt)-1)*500) * time.Millisecond
}
