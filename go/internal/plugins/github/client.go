package github

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
	"golang.org/x/crypto/nacl/box"
)

const apiBase = "https://api.github.com"

type fetchFunc func(context.Context, *http.Request) (*http.Response, error)

type failFunc func(code plugins.ErrorCode, message, suggestion string) error

// Client is src/plugins/github/client.ts GitHubClient. The agentio-owned
// `github install|uninstall` commands use it from the host, as Bun's
// src/commands/github-vault-secrets.ts does.
type Client struct {
	ctx   context.Context
	token string
	fetch fetchFunc
	fail  failFunc
}

// NewClient builds a client from a command's fresh credentials.
func NewClient(ctx context.Context, run *plugins.RunContext) *Client {
	return newClient(ctx, str(run.Credentials, "accessToken"), run.Fetch, run.Fail)
}

func newClient(ctx context.Context, token string, fetch fetchFunc, fail failFunc) *Client {
	return &Client{ctx: ctx, token: token, fetch: fetch, fail: fail}
}

type user struct {
	login    string
	email    any // string or nil
	hasEmail bool
}

// request is GitHubClient.request. Every failure that is not an HTTP status
// (transport, unreadable or non-JSON body) is NETWORK_ERROR, as Bun's catch-all.
func (c *Client) request(method, path string, body map[string]any) (any, error) {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(c.ctx, method, apiBase+path, reader)
	if err != nil {
		return nil, c.network(err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.fetch(c.ctx, req)
	if err != nil {
		return nil, c.network(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNoContent {
		return jsvalue.NewObject(), nil
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, c.network(err)
	}
	// Bun's fetch reads an empty body (a 201 with no content) as null.
	var data any
	if len(raw) > 0 {
		if data, err = jsvalue.Parse(raw); err != nil {
			return nil, c.network(jsonParseError(raw, err))
		}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if data == nil {
			return nil, c.network(errors.New("null is not an object (evaluating 'data.message')"))
		}
		obj, _ := data.(*jsvalue.Object)
		message := "Unknown GitHub API error"
		if v, _ := obj.Get("message"); jsvalue.Truthy(v) {
			message = jsvalue.String(v)
		}
		switch resp.StatusCode {
		case 401:
			return nil, c.fail("AUTH_FAILED", "GitHub authentication failed: "+message, "")
		case 403:
			return nil, c.fail("PERMISSION_DENIED", "Permission denied: "+message, "You need admin access to set secrets on this repository")
		case 404:
			return nil, c.fail("NOT_FOUND", "Not found: "+message, "Check that the repository exists and you have access to it")
		case 429:
			return nil, c.fail("RATE_LIMITED", "Rate limited: "+message, "")
		}
		return nil, c.fail("API_ERROR", "GitHub API error: "+message, "")
	}
	return data, nil
}

// jsonParseError is Bun's response.json() message for a blank body and for a
// body that is not JSON at all (an HTML error page from a proxy).
func jsonParseError(raw []byte, err error) error {
	trimmed := bytes.TrimLeft(raw, " \t\r\n")
	if len(trimmed) == 0 {
		return errors.New("JSON Parse error: Unexpected EOF")
	}
	if !bytes.ContainsRune([]byte(`{["-0123456789tfn`), rune(trimmed[0])) && trimmed[0] < 0x80 {
		return fmt.Errorf("JSON Parse error: Unrecognized token '%c'", trimmed[0])
	}
	return err
}

func (c *Client) network(err error) error {
	return c.fail("NETWORK_ERROR", "Failed to connect to GitHub: "+err.Error(), "")
}

func (c *Client) getUser() (user, error) {
	data, err := c.request(http.MethodGet, "/user", nil)
	if err != nil {
		return user{}, err
	}
	obj, _ := data.(*jsvalue.Object)
	login, _ := obj.Get("login")
	email, hasEmail := obj.Get("email")
	u := user{email: email, hasEmail: hasEmail}
	if login != nil {
		u.login = jsvalue.String(login)
	}
	return u, nil
}

// SetRepoSecret encrypts the value with the repository's public key (a
// libsodium sealed box) and uploads it.
func (c *Client) SetRepoSecret(repo, name, value string) error {
	data, err := c.request(http.MethodGet, "/repos/"+repo+"/actions/secrets/public-key", nil)
	if err != nil {
		return err
	}
	obj, _ := data.(*jsvalue.Object)
	key, _ := obj.Str("key")
	keyID, hasKeyID := obj.Get("key_id")
	encrypted, err := sealBox(key, value)
	if err != nil {
		return err
	}
	body := map[string]any{"encrypted_value": encrypted}
	if hasKeyID { // JSON.stringify drops an undefined key_id
		body["key_id"] = keyID
	}
	_, err = c.request(http.MethodPut, "/repos/"+repo+"/actions/secrets/"+name, body)
	return err
}

func (c *Client) DeleteRepoSecret(repo, name string) error {
	_, err := c.request(http.MethodDelete, "/repos/"+repo+"/actions/secrets/"+name, nil)
	return err
}

// sealBox is sodium.crypto_box_seal over a base64 (ORIGINAL variant) key.
func sealBox(publicKey, message string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(publicKey)
	if err != nil {
		return "", errors.New("incomplete input")
	}
	if len(raw) != 32 {
		return "", fmt.Errorf("invalid publicKey length")
	}
	var pk [32]byte
	copy(pk[:], raw)
	sealed, err := box.SealAnonymous(nil, []byte(message), &pk, rand.Reader)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(sealed), nil
}
