// Package acme is a fake refreshable service. It exercises every host hook a
// real OAuth plugin uses: setup (prompt + oauth), refresh with rotation,
// reauthentication, validation (including fetch), read and write commands,
// stdin, variadic arguments, formatting, the plugin cache, and secret redaction.
package acme

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/plosson/agentio/go/internal/obscure"
	"github.com/plosson/agentio/go/internal/plugin"
	"github.com/plosson/agentio/go/internal/plugincache"
	"github.com/plosson/agentio/go/internal/vault"
)

const ServiceID = "acme"

func New() *plugin.Plugin {
	return &plugin.Plugin{
		APIVersion:  plugin.APIVersion,
		ID:          ServiceID,
		DisplayName: "Acme",
		Description: "Fake refreshable service used to exercise the agentio host",
		Brand:       &plugin.Brand{Color: "#336699"},
		Profile: &plugin.ProfileSpec{
			Setup:          setup,
			Validate:       validate,
			Reauthenticate: reauth,
			Refresh: &plugin.RefreshSpec{
				SecretFields: []string{"refreshToken"},
				Applies:      applies,
				IsStale:      stale,
				Run:          refresh,
			},
		},
		Commands: []plugin.CommandSpec{
			whoami(), itemsList(), itemsAdd(), notesPut(), batchApply(), itemsDrop(), widgetsGet(),
		},
	}
}

func setup(ctx context.Context, opts plugin.SetupOptions, setup *plugin.SetupContext) (*plugin.SetupResult, error) {
	_ = opts
	account, err := setup.Prompt("Account", false)
	if err != nil {
		return nil, err
	}
	if account == "" {
		return nil, setup.Fail("INVALID_PARAMS", "Account is required", "")
	}
	hidden, err := obscure.Obscure("acme-demo")
	if err != nil {
		return nil, err
	}
	clientID, err := obscure.Reveal(hidden)
	if err != nil {
		return nil, err
	}
	setup.Log("Acme client", clientID)
	oauth, err := setup.OAuth(ctx, plugin.OAuthSetupOptions{
		ServiceName: "Acme",
		AuthorizationURL: func(redirect string) string {
			return "https://acme.invalid/authorize?redirect_uri=" + redirect
		},
	})
	if err != nil {
		return nil, err
	}
	access, refreshTok, expiry := parseCode(oauth.Code)
	return &plugin.SetupResult{
		Credentials: map[string]any{
			"account": account, "accessToken": access, "refreshToken": refreshTok,
			"expiryDate": jsonNumber(expiry),
		},
		SuggestedProfileName: account,
		Info:                 "Account: " + account,
	}, nil
}

func parseCode(code string) (access, refreshTok string, expiry int64) {
	parts := strings.Split(code, "|")
	access = parts[0]
	refreshTok = access
	expiry = time.Now().Add(time.Hour).UnixMilli()
	if len(parts) > 1 && parts[1] != "" {
		refreshTok = parts[1]
	}
	if len(parts) > 2 {
		if n, err := strconv.ParseInt(parts[2], 10, 64); err == nil {
			expiry = n
		}
	}
	return access, refreshTok, expiry
}

func applies(creds map[string]any) bool {
	s, ok := creds["refreshToken"].(string)
	return ok && s != ""
}

func stale(creds map[string]any, nowMs, bufferMs int64) bool {
	expiry, ok := vault.AsInt64(creds["expiryDate"])
	if !ok {
		return false
	}
	return nowMs+bufferMs >= expiry
}

func refresh(_ context.Context, creds map[string]any) (map[string]any, error) {
	tok, _ := creds["refreshToken"].(string)
	if strings.HasPrefix(tok, "bad:") {
		return nil, fmt.Errorf("provider rejected refresh")
	}
	access, _ := creds["accessToken"].(string)
	out := map[string]any{}
	for k, v := range creds {
		out[k] = v
	}
	out["accessToken"] = "fresh:" + access
	out["refreshToken"] = "rot:" + tok
	out["expiryDate"] = jsonNumber(time.Now().Add(time.Hour).UnixMilli())
	return out, nil
}

func reauth(_ context.Context, creds map[string]any, profileName string, setup *plugin.SetupContext) (map[string]any, error) {
	setup.Log("Re-authenticating acme /", profileName)
	token, err := setup.Prompt("Refresh token", true)
	if err != nil {
		return nil, err
	}
	out := map[string]any{}
	for k, v := range creds {
		out[k] = v
	}
	if out == nil {
		out = map[string]any{}
	}
	out["accessToken"] = "reauth"
	out["refreshToken"] = token
	out["expiryDate"] = jsonNumber(time.Now().Add(time.Hour).UnixMilli())
	return out, nil
}

func validate(ctx context.Context, run *plugin.RunContext) (plugin.ValidationResult, error) {
	account, _ := run.Credentials["account"].(string)
	access, _ := run.Credentials["accessToken"].(string)
	if account == "" {
		return plugin.ValidationResult{Valid: false, Error: "missing account"}, nil
	}
	if access == "bad" {
		return plugin.ValidationResult{Valid: false, Error: "token rejected"}, nil
	}
	if ep, ok := run.Credentials["endpoint"].(string); ok && ep != "" {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, ep, nil)
		if err != nil {
			return plugin.ValidationResult{Valid: false, Error: err.Error()}, nil
		}
		resp, err := run.Fetch(ctx, req)
		if err != nil {
			return plugin.ValidationResult{Valid: false, Error: err.Error()}, nil
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return plugin.ValidationResult{Valid: false, Error: fmt.Sprintf("HTTP %d", resp.StatusCode)}, nil
		}
	}
	return plugin.ValidationResult{Valid: true, Info: "Account: " + account}, nil
}

func whoami() plugin.CommandSpec {
	return plugin.CommandSpec{
		Path: "whoami", Description: "Show the authenticated Acme account",
		Access: "read", Examples: []string{"agentio acme whoami"},
		Run: func(_ context.Context, _ plugin.CommandInput, run *plugin.RunContext) (any, error) {
			return map[string]any{
				"account": run.Credentials["account"], "accessToken": run.Credentials["accessToken"], "profile": run.Profile,
			}, nil
		},
		Format: func(v any) string {
			m, _ := v.(map[string]any)
			return fmt.Sprintf("%v (%v)", m["account"], m["profile"])
		},
	}
}

func itemsList() plugin.CommandSpec {
	return plugin.CommandSpec{
		Path: "items list", Description: "List Acme items",
		Access:   "read",
		Options:  []plugin.OptionSpec{{Flags: "--limit <number>", Description: "Maximum results", DefaultValue: "20"}},
		Examples: []string{"agentio acme items list --limit 5"},
		Run: func(_ context.Context, in plugin.CommandInput, run *plugin.RunContext) (any, error) {
			limit := 20
			if raw, ok := in.Options["limit"].(string); ok && raw != "" {
				n, err := strconv.Atoi(raw)
				if err != nil || n < 0 {
					return nil, run.Fail("INVALID_PARAMS", "limit must be a non-negative integer", "")
				}
				limit = n
			}
			account, _ := run.Credentials["account"].(string)
			var items []string
			for i := 0; i < limit && i < 3; i++ {
				items = append(items, fmt.Sprintf("%s-%d", account, i+1))
			}
			if items == nil {
				items = []string{}
			}
			return map[string]any{"items": items}, nil
		},
	}
}

func itemsAdd() plugin.CommandSpec {
	return plugin.CommandSpec{
		Path: "items add", Description: "Add an Acme item",
		Access:    "write",
		Arguments: []plugin.ArgumentSpec{{Name: "title", Description: "Item title", Required: true}},
		Examples:  []string{"agentio acme items add Widget"},
		Run: func(_ context.Context, in plugin.CommandInput, run *plugin.RunContext) (any, error) {
			title, _ := in.Args["title"].(string)
			if title == "" {
				return nil, run.Fail("INVALID_PARAMS", "title is required", "")
			}
			return map[string]any{"added": title, "profile": run.Profile}, nil
		},
	}
}

func notesPut() plugin.CommandSpec {
	return plugin.CommandSpec{
		Path: "notes put", Description: "Store a note from stdin in the plugin cache",
		Access: "write", Input: "text",
		Examples: []string{"echo hello | agentio acme notes put"},
		Run: func(_ context.Context, in plugin.CommandInput, run *plugin.RunContext) (any, error) {
			text, _ := in.Stdin.(string)
			account, _ := run.Credentials["account"].(string)
			if err := plugincache.Write(ServiceID, account, "note", map[string]string{"text": text}); err != nil {
				return nil, err
			}
			return map[string]any{"saved": len(text)}, nil
		},
	}
}

func batchApply() plugin.CommandSpec {
	return plugin.CommandSpec{
		Path: "batch apply", Description: "Apply a JSON batch from stdin",
		Access: "write", Input: "json",
		Examples: []string{`echo '{"ops":["a"]}' | agentio acme batch apply`},
		Run: func(_ context.Context, in plugin.CommandInput, run *plugin.RunContext) (any, error) {
			obj, ok := in.Stdin.(map[string]any)
			if !ok {
				return nil, run.Fail("INVALID_PARAMS", "stdin JSON must be an object", "")
			}
			return map[string]any{"applied": obj["ops"]}, nil
		},
	}
}

func itemsDrop() plugin.CommandSpec {
	return plugin.CommandSpec{
		Path: "items drop", Description: "Drop one or more items",
		Access:    "write",
		Arguments: []plugin.ArgumentSpec{{Name: "id", Description: "Item ids", Required: true, Variadic: true}},
		Examples:  []string{"agentio acme items drop a b"},
		Run: func(_ context.Context, in plugin.CommandInput, _ *plugin.RunContext) (any, error) {
			return map[string]any{"dropped": in.Args["id"]}, nil
		},
	}
}

func widgetsGet() plugin.CommandSpec {
	return plugin.CommandSpec{
		Path: "widgets get", Description: "Fetch a widget, with an optional extra",
		Access: "read",
		Arguments: []plugin.ArgumentSpec{
			{Name: "id", Description: "Widget id", Required: true},
			{Name: "extra", Description: "Optional extra", Required: false},
		},
		Examples: []string{"agentio acme widgets get w1"},
		Run: func(_ context.Context, in plugin.CommandInput, _ *plugin.RunContext) (any, error) {
			return map[string]any{"id": in.Args["id"], "extra": in.Args["extra"]}, nil
		},
	}
}

func jsonNumber(n int64) any {
	return jsonNumberString(n)
}

func jsonNumberString(n int64) vaultNumber { return vaultNumber(n) }

// vaultNumber keeps expiry as a JSON number across a vault round trip.
type vaultNumber int64

func (n vaultNumber) MarshalJSON() ([]byte, error) {
	return []byte(strconv.FormatInt(int64(n), 10)), nil
}
