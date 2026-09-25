package slack

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
)

type fetchFunc = func(ctx context.Context, req *http.Request) (*http.Response, error)

// sendResult is Bun SlackSendResult.
type sendResult struct {
	Success       bool `json:"success"`
	IsJSONPayload bool `json:"isJsonPayload"`
}

// send is SlackClient.send for the one credential type Bun knows.
func send(ctx context.Context, run *plugins.RunContext, m message) (*sendResult, error) {
	if run.Credentials.Value("type") != "webhook" {
		return nil, run.Fail("INVALID_PARAMS", "Unknown credentials type", "")
	}
	webhookURL, _ := run.Credentials.Value("webhookUrl").(string)
	if jsvalue.Trim(webhookURL) == "" || !strings.HasPrefix(webhookURL, "https://") {
		return nil, run.Fail("INVALID_PARAMS", "Invalid webhook URL - must be HTTPS", "Check the webhook URL configuration")
	}
	status, body, err := postJSON(ctx, run.Fetch, webhookURL, m.body())
	if err != nil {
		return nil, run.Fail("NETWORK_ERROR", "Webhook request failed: "+err.Error(), "Verify the webhook URL is correct and accessible")
	}
	if !ok(status) {
		return nil, run.Fail(plugins.HTTPStatusToErrorCode(status), "Failed to send message via webhook: "+statusText(status, body),
			"Check that the webhook URL is valid and the app has permission to post")
	}
	return &sendResult{Success: true, IsJSONPayload: jsvalue.Truthy(m.payload)}, nil
}

// body is Bun `options.payload ?? { text: options.text }`: a JSON null
// payload falls back to a text that is undefined, which stringifies as {}.
func (m message) body() any {
	if m.payload != nil {
		return m.payload
	}
	if !m.isPayload {
		return textBody(m.text)
	}
	return jsvalue.NewObject()
}

// textBody is the object literal `{ text }`.
func textBody(text string) *jsvalue.Object {
	o := jsvalue.NewObject()
	o.Set("text", text)
	return o
}

// postJSON is Bun `fetch(url, { method: 'POST', body: JSON.stringify(body) })`.
// The body is read only for a failed status, where Bun reads response.text();
// a read failure there is a failed request, as in Bun's catch.
func postJSON(ctx context.Context, fetch fetchFunc, target string, body any) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(jsvalue.Stringify(body)))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := fetch(ctx, req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	if ok(resp.StatusCode) {
		return resp.StatusCode, nil, nil
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, nil, err
	}
	return resp.StatusCode, raw, nil
}

// ok is Response#ok.
func ok(status int) bool {
	return status >= 200 && status < 300
}

// statusText is Bun `${response.status} ${await response.text()}`.
func statusText(status int, body []byte) string {
	return strconv.Itoa(status) + " " + jsvalue.DecodeUTF8(body)
}
