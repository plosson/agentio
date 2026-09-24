package atlassian

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"

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

// StatusToErrorCode is Bun httpStatusToErrorCode.
func StatusToErrorCode(status int) plugins.ErrorCode {
	switch status {
	case http.StatusUnauthorized:
		return "AUTH_FAILED"
	case http.StatusForbidden:
		return "PERMISSION_DENIED"
	case http.StatusNotFound:
		return "NOT_FOUND"
	case http.StatusTooManyRequests:
		return "RATE_LIMITED"
	default:
		return "API_ERROR"
	}
}

// Request sends method to target with body as JSON (none when nil) and
// decodes the answer into out. A 204 or an empty answer leaves out as is.
func (c Client) Request(method, target string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(c.Ctx, method, target, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.Access)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.Fetch(c.Ctx, req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return c.Fail(StatusToErrorCode(resp.StatusCode), c.ErrorPrefix+": "+string(raw), "")
	}
	if resp.StatusCode == http.StatusNoContent || out == nil {
		return nil
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	return json.Unmarshal(raw, out)
}

// ExtractTextFromADF is the Bun clients' extractTextFromAdf: top-level
// blocks joined by a blank line, text nodes concatenated, hard breaks as
// newlines.
func ExtractTextFromADF(adf any) string {
	doc, ok := adf.(map[string]any)
	if !ok {
		return ""
	}
	content, ok := doc["content"].([]any)
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
	n, ok := node.(map[string]any)
	if !ok {
		return ""
	}
	if n["type"] == "text" {
		if text, _ := n["text"].(string); text != "" {
			return text
		}
	}
	if n["type"] == "hardBreak" {
		return "\n"
	}
	content, ok := n["content"].([]any)
	if !ok {
		return ""
	}
	var b strings.Builder
	for _, child := range content {
		b.WriteString(extractNode(child))
	}
	return b.String()
}
