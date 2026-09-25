package atlassian

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
)

// Client is the private request() of the Bun Atlassian clients: bearer
// token, JSON in and out, and a failure raised as "<ErrorPrefix>: <body>"
// under the status's error code.
type Client struct {
	Access string
	Ctx    context.Context
	Fetch  func(context.Context, *http.Request) (*http.Response, error)
	Fail   func(plugins.ErrorCode, string, string) error
	// ErrorPrefix is the product's "<Product> API error".
	ErrorPrefix string
}

// NewClient is a Client on the command's fresh credentials.
func NewClient(ctx context.Context, run *plugins.RunContext, errorPrefix string) Client {
	return Client{
		Access:      Str(run.Credentials, "accessToken"),
		Ctx:         ctx,
		Fetch:       run.Fetch,
		Fail:        run.Fail,
		ErrorPrefix: errorPrefix,
	}
}

// Request is the Bun clients' request(): body sent as JSON.stringify(body)
// (none when nil), a failure raised as "<ErrorPrefix>: <body>", a 204 as {}
// and any other answer as `await response.json()` reads it (an empty body is
// null).
func (c Client) Request(method, target string, body any) (any, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(jsvalue.Stringify(body))
	}
	req, err := http.NewRequestWithContext(c.Ctx, method, target, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Access)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.Fetch(c.Ctx, req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, c.Fail(plugins.HTTPStatusToErrorCode(resp.StatusCode), c.ErrorPrefix+": "+string(raw), "")
	}
	if resp.StatusCode == http.StatusNoContent {
		return jsvalue.NewObject(), nil
	}
	return plugins.ResponseJSON(resp.StatusCode, raw)
}

// Pick is an object literal of raw's members: pairs are the new key, then
// the member of raw it takes (`{ id: raw.id, spaceId: raw.space_id }`). A
// missing member is undefined, which --json leaves out.
func Pick(raw any, pairs ...string) *jsvalue.Object {
	o := jsvalue.NewObject()
	for i := 0; i+1 < len(pairs); i += 2 {
		o.Set(pairs[i], jsvalue.Member(raw, pairs[i+1]))
	}
	return o
}

// ExtractTextFromADF is the Bun clients' extractTextFromAdf: top-level
// blocks joined by a blank line, text nodes concatenated, hard breaks as
// newlines.
func ExtractTextFromADF(adf any) string {
	content, ok := jsvalue.Member(adf, "content").([]any)
	if !ok {
		return ""
	}
	parts := make([]string, len(content))
	for i, block := range content {
		parts[i] = extractNode(block)
	}
	return strings.Join(parts, "\n\n")
}

func extractNode(node any) string {
	if _, ok := node.(*jsvalue.Object); !ok {
		return ""
	}
	typ := jsvalue.Member(node, "type")
	if text := jsvalue.Member(node, "text"); jsvalue.StrictEqual(typ, "text") && jsvalue.Truthy(text) {
		return jsvalue.String(text)
	}
	if jsvalue.StrictEqual(typ, "hardBreak") {
		return "\n"
	}
	content, ok := jsvalue.Member(node, "content").([]any)
	if !ok {
		return ""
	}
	var b strings.Builder
	for _, child := range content {
		b.WriteString(extractNode(child))
	}
	return b.String()
}
