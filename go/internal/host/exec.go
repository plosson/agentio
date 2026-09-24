package host

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/plosson/agentio/go/internal/auth"
	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/profile"
)

// EnforceWrite refuses a mutating command on a read-only profile before the handler runs.
func EnforceWrite(service, profileName, operation string) error {
	ro, err := profile.IsReadOnly(service, profileName)
	if err != nil {
		return err
	}
	if !ro {
		return nil
	}
	suggestion := fmt.Sprintf("To modify this profile's access: agentio %s profile update --profile %s --no-read-only", service, profileName)
	if auth.IsRemote() {
		suggestion = "The profile or the key is read-only on the vault hub; change it there"
	}
	return clierr.New(clierr.PermissionDenied,
		fmt.Sprintf("Cannot %s: profile %q is read-only", operation, profileName),
		suggestion)
}

// Execute runs one declarative command through host-owned profile and access policy.
func Execute(ctx context.Context, reg *plugins.Registry, p *plugins.Plugin, spec *plugins.CommandSpec, in plugins.CommandInput) (any, error) {
	creds := map[string]any{}
	profileName := ""
	if p.Profile != nil {
		flag, _ := in.Options["profile"].(string)
		name, err := profile.Require(p.ID, flag)
		if err != nil {
			return nil, err
		}
		profileName = name
		access := spec.Access
		if spec.AccessFor != nil {
			access = spec.AccessFor(in)
		}
		if access == "write" {
			operation := spec.Operation
			if operation == "" {
				operation = spec.Path
			}
			if err := EnforceWrite(p.ID, profileName, operation); err != nil {
				return nil, err
			}
		}
		fresh, err := auth.GetFresh(ctx, reg, p.ID, profileName, auth.RefreshOptions{})
		if err != nil {
			return nil, err
		}
		creds = fresh.Credentials
	}
	run := NewRunContext(creds, profileName, ctx)
	return spec.Run(ctx, in, run)
}

// PrintResult writes a command result. --json wins; otherwise format, then JSON.
func PrintResult(w io.Writer, spec *plugins.CommandSpec, result any, asJSON bool) error {
	if asJSON {
		return writeJSON(w, result)
	}
	if spec.Format != nil {
		rendered := spec.Format(result)
		if rendered != "" {
			_, err := fmt.Fprintln(w, rendered)
			return err
		}
		return nil
	}
	if s, ok := result.(string); ok {
		_, err := fmt.Fprintln(w, s)
		return err
	}
	if result == nil {
		return nil
	}
	return writeJSON(w, result)
}

// writeJSON matches JSON.stringify(value, null, 2): no HTML escaping of <, >, &.
func writeJSON(w io.Writer, value any) error {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	return enc.Encode(value)
}

// ParseStdin turns raw stdin into the command's declared input.
func ParseStdin(spec *plugins.CommandSpec, raw string, present bool) (any, error) {
	if spec.Input == "" || spec.Input == "none" || !present {
		return nil, nil
	}
	if spec.Input == "text" {
		return raw, nil
	}
	if spec.Input == "json" {
		var v any
		if err := json.Unmarshal([]byte(raw), &v); err != nil {
			return nil, clierr.New(clierr.InvalidParams, "Invalid JSON on stdin: "+err.Error(), "")
		}
		return v, nil
	}
	return nil, nil
}

// AddProfile runs plugin setup and lets the host name and persist the result.
func AddProfile(ctx context.Context, p *plugins.Plugin, opts plugins.SetupOptions, setup *plugins.SetupContext, out io.Writer) error {
	if p.Profile == nil || p.Profile.Setup == nil {
		return fmt.Errorf("no profile setup registered for %s", p.ID)
	}
	result, err := p.Profile.Setup(ctx, opts, setup)
	if err != nil {
		return err
	}
	name, err := profile.ChooseName(p.ID, opts.Profile, result.SuggestedProfileName, opts.ReadOnly)
	if err != nil {
		return err
	}
	save := profile.SaveOptions{}
	if opts.ReadOnly {
		save.ReadOnlySet = true
		save.ReadOnly = true
	}
	if err := profile.Save(p.ID, name, result.Credentials, save); err != nil {
		return err
	}
	fmt.Fprintf(out, "Profile %q configured!\n", name)
	if result.Info != "" {
		fmt.Fprintln(out, result.Info)
	}
	if opts.ReadOnly {
		fmt.Fprintln(out, "Access: read-only")
	}
	return nil
}

// Reauth replaces credentials through the plugin hook and persists them.
// A plugin without the hook is skipped, not failed.
func Reauth(ctx context.Context, reg *plugins.Registry, service, profileName string, setup *plugins.SetupContext, errOut io.Writer) error {
	p := reg.Find(service)
	if p == nil || p.Profile == nil || p.Profile.Reauthenticate == nil {
		fmt.Fprintf(errOut, "\nSkipping %s / %s: no automatic reauthentication is registered. Run 'agentio %s profile add --profile %s' to update.\n", service, profileName, service, profileName)
		return nil
	}
	existing, err := auth.GetCredentials(service, profileName)
	if err != nil {
		return err
	}
	replacement, err := p.Profile.Reauthenticate(ctx, existing, profileName, setup)
	if err != nil {
		return err
	}
	return auth.SetCredentials(service, profileName, replacement)
}

func TruthyOption(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	case string:
		return strings.EqualFold(t, "true")
	default:
		return false
	}
}
