package google

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
	"google.golang.org/api/googleapi"
)

// CallJSON sends body verbatim (nil for none) to basePath+path with the
// profile's token and returns the response parsed by jsvalue.Parse. basePath
// is a product client's BasePath, so WithEndpoints applies. A failure is a
// *googleapi.Error, so ErrorCode, Message and StatusMessage read it.
//
// It serves Bun commands that print or forward the API's own objects (a raw
// document dump, a batchUpdate escape hatch). The typed google.golang.org/api
// structs reorder keys, drop false and zero values, and drop fields the pinned
// client does not know, so those commands keep the JSON as a jsvalue.Object.
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
	return jsvalue.Parse(raw)
}

// GetJSON is a GET through CallJSON that also decodes the answer into out, a
// typed google.golang.org/api struct: raw keeps what the struct loses (a
// field that is null versus absent, a zero that was sent).
func GetJSON(ctx context.Context, run *plugins.RunContext, keys Keys, basePath, path string, out any) (raw any, err error) {
	raw, err = CallJSON(ctx, run, keys, http.MethodGet, basePath, path, nil)
	if err != nil {
		return nil, err
	}
	return raw, json.Unmarshal(jsvalue.Stringify(raw), out)
}
