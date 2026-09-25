package google

import (
	"context"
	"errors"
	"io"
	"math"
	"net/http"
	"sync"
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
	opts := []option.ClientOption{option.WithHTTPClient(HTTPClient(ctx, run, keys))}
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

// HTTPClient is the google-auth-library OAuth2Client Bun builds from the
// stored tokens (createGoogleAuth): it sends the access token through the
// host's Fetch with googleapis' retry policy, and refreshes it in memory as
// the library does (see authTransport). Use it for the few calls no product
// SDK covers.
// ctx supplies the token endpoint (Endpoints) for a refresh.
func HTTPClient(ctx context.Context, run *plugins.RunContext, keys Keys) *http.Client {
	fetch := run.Fetch
	if fetch == nil {
		fetch = plugins.Fetch
	}
	return &http.Client{Transport: newAuthTransport(ctx, run, keys, fetch)}
}

func newAuthTransport(ctx context.Context, run *plugins.RunContext, keys Keys, fetch fetchFunc) *authTransport {
	stored := keys.Read(run.Credentials)
	return &authTransport{
		ctx:     ctx,
		access:  stored.AccessToken,
		refresh: stored.RefreshToken,
		expiry:  stored.ExpiryDate,
		fetch:   fetch,
		base:    &retryTransport{base: fetchTransport(fetch), methods: apiRetryMethods},
	}
}

// AccessToken is OAuth2Client.getAccessToken() over the stored tokens, for a
// call Bun makes with plain fetch: the stored token while it is not expiring,
// else a refreshed one ("" when Google returned none).
func AccessToken(ctx context.Context, run *plugins.RunContext, keys Keys) (string, error) {
	fetch := run.Fetch
	if fetch == nil {
		fetch = plugins.Fetch
	}
	t := newAuthTransport(ctx, run, keys, fetch)
	if t.access == "" || t.expiring() {
		if err := t.refreshNow(ctx, false); err != nil {
			return "", err
		}
	}
	return t.access, nil
}

// eagerRefresh is OAuth2Client's eagerRefreshThresholdMillis.
const eagerRefresh = 5 * time.Minute

// authTransport is OAuth2Client.requestAsync. Before a request: no access and
// no refresh token is an error; an access token that is not expiring is sent;
// otherwise the refresh token buys a new one. After a 401 or 403, a client
// with both tokens and no expiry refreshes once and sends the request again.
// A refreshed token lives only in this client: nothing is stored.
type authTransport struct {
	ctx     context.Context // the client's: its Endpoints name the token URL
	mu      sync.Mutex
	access  string
	refresh string
	expiry  int64 // ms; 0 is none
	fetch   fetchFunc
	base    http.RoundTripper
}

func (t *authTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	for retried := false; ; retried = true {
		access, err := t.metadata(req.Context())
		if err != nil {
			return nil, &plugins.FetchError{Message: err.Error(), Err: err}
		}
		try := req.Clone(req.Context())
		if retried && req.Body != nil {
			if try.Body, err = req.GetBody(); err != nil {
				return nil, err
			}
		}
		try.Header.Set("Authorization", "Bearer "+access)
		resp, err := t.base.RoundTrip(try)
		if err != nil || retried || (resp.StatusCode != 401 && resp.StatusCode != 403) || !t.mayRequireRefresh() ||
			(req.Body != nil && req.GetBody == nil) {
			return resp, err
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if err := t.refreshNow(req.Context(), false); err != nil {
			return nil, &plugins.FetchError{Message: err.Error(), Err: err}
		}
	}
}

// metadata is getRequestMetadataAsync: the access token to send.
func (t *authTransport) metadata(ctx context.Context) (string, error) {
	t.mu.Lock()
	access, refresh := t.access, t.refresh
	fresh := access != "" && !t.expiring()
	t.mu.Unlock()
	if access == "" && refresh == "" {
		return "", errors.New("No access, refresh token, API key or refresh handler callback is set.")
	}
	if fresh {
		return access, nil
	}
	if err := t.refreshNow(ctx, true); err != nil {
		return "", err
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.access, nil
}

// expiring is isTokenExpiring: an expiry within eagerRefresh. Hold t.mu.
func (t *authTransport) expiring() bool {
	return t.expiry != 0 && time.UnixMilli(t.expiry).Before(time.Now().Add(eagerRefresh).Add(time.Millisecond))
}

// mayRequireRefresh is requestAsync's test for a retry after a 401 or 403.
func (t *authTransport) mayRequireRefresh() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.access != "" && t.refresh != "" && t.expiry == 0
}

// refreshNow is refreshAccessTokenAsync. fromMetadata adds the prefix
// getRequestMetadataAsync puts on a 403 or 404 from the token endpoint.
func (t *authTransport) refreshNow(ctx context.Context, fromMetadata bool) error {
	t.mu.Lock()
	refresh := t.refresh
	t.mu.Unlock()
	if refresh == "" {
		return errors.New("No refresh token is set.")
	}
	conf, err := oauthConfig(t.ctx, "")
	if err != nil {
		return err
	}
	tok, err := conf.TokenSource(tokenContext(ctx, t.fetch), &oauth2.Token{RefreshToken: refresh}).Token()
	if err != nil {
		var re *oauth2.RetrieveError
		if fromMetadata && errors.As(err, &re) && re.Response != nil && (re.Response.StatusCode == 403 || re.Response.StatusCode == 404) {
			return errors.New("Could not refresh access token: " + tokenError(err).Error())
		}
		return tokenError(err)
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.access = tok.AccessToken
	t.expiry = expiryMs(tok)
	return nil
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
