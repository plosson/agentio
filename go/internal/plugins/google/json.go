package google

import (
	"bytes"
	"context"
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
	resp, err := HTTPClient(run, keys).Do(req)
	if err != nil {
		return nil, err
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
