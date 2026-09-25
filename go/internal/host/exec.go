package host

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/plosson/agentio/go/internal/auth"
	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/profile"
)

// EnforceWrite refuses a mutating command on a read-only profile before the handler runs.
func EnforceWrite(service, profileName, operation string) error {
	ro, err := profile.IsReadOnly(service, profileName)
	if err != nil {
		return err
	}
	return writeRefusal(service, profileName, operation, ro)
}

// writeRefusal is Bun enforceWriteAccess once the read-only flag is known.
func writeRefusal(service, profileName, operation string, readOnly bool) error {
	if !readOnly {
		return nil
	}
	suggestion := fmt.Sprintf("To modify this profile's access: agentio %s profile update --profile %s --no-read-only", service, profileName)
	if auth.IsRemote() {
		suggestion = "The profile or the key is read-only on the vault hub; change it there"
	}
	return clierr.New(clierr.PermissionDenied,
		fmt.Sprintf("Cannot %s: profile \"%s\" is read-only", operation, profileName),
		suggestion)
}

// Execute runs one command in Bun's order: Prepare (input checks, dry runs),
// then getClient (require the profile, refresh and persist its token), then
// enforceWriteAccess, then the handler.
func Execute(ctx context.Context, reg *plugins.Registry, p *plugins.Plugin, spec *plugins.CommandSpec, in plugins.CommandInput) (any, error) {
	prepared, done, err := prepare(ctx, spec, in, &plugins.PrepareContext{Log: logStderr, Fail: fail})
	if err != nil || done {
		return prepared, err
	}
	creds := jsvalue.NewObject()
	profileName := ""
	readOnly := false
	if p.Profile != nil {
		flag, _ := in.Options["profile"].(string)
		name, err := profile.Require(p.ID, flag)
		if err != nil {
			return nil, err
		}
		profileName = name
		fresh, err := auth.GetFresh(ctx, reg, p.ID, profileName, auth.RefreshOptions{})
		if err != nil {
			return nil, err
		}
		creds = fresh.Credentials
		if readOnly, err = profile.IsReadOnly(p.ID, profileName); err != nil {
			return nil, err
		}
		if access(spec, in) == "write" {
			if err := writeRefusal(p.ID, profileName, operation(spec, in), readOnly); err != nil {
				return nil, err
			}
		}
	}
	run := NewRunContext(creds, profileName, ctx)
	run.ReadOnly = readOnly
	run.Prepared = prepared
	return spec.Run(ctx, in, run)
}

// Invoke runs a command against a RunContext the caller built, with the same
// Prepare phase as Execute (logging and failing through run) but no profile,
// refresh or write check.
func Invoke(ctx context.Context, spec *plugins.CommandSpec, in plugins.CommandInput, run *plugins.RunContext) (any, error) {
	prepared, done, err := prepare(ctx, spec, in, &plugins.PrepareContext{Log: run.Log, Fail: run.Fail})
	if err != nil || done {
		return prepared, err
	}
	run.Prepared = prepared
	return spec.Run(ctx, in, run)
}

// prepare is the pre-profile phase: the required options, then the
// command's Prepare. A failure prints nothing.
func prepare(ctx context.Context, spec *plugins.CommandSpec, in plugins.CommandInput, pre *plugins.PrepareContext) (any, bool, error) {
	if err := plugins.RequireOptions(in, pre.Fail, spec.Options); err != nil {
		return nil, false, err
	}
	if spec.Prepare == nil {
		return nil, false, nil
	}
	prepared, done, err := spec.Prepare(ctx, in, pre)
	if err != nil {
		return nil, false, err
	}
	return prepared, done, nil
}

func access(spec *plugins.CommandSpec, in plugins.CommandInput) string {
	if spec.AccessFor != nil {
		return spec.AccessFor(in)
	}
	return spec.Access
}

func operation(spec *plugins.CommandSpec, in plugins.CommandInput) string {
	op := spec.Operation
	if spec.OperationFor != nil {
		op = spec.OperationFor(in)
	}
	if op == "" {
		op = spec.Path
	}
	return op
}

// PrintResult writes a command result. --json wins; otherwise format, then JSON.
func PrintResult(w io.Writer, spec *plugins.CommandSpec, result any, asJSON bool) error {
	if asJSON {
		return writeJSON(w, result)
	}
	if spec.Format != nil {
		rendered := spec.Format(result)
		if rendered != "" && spec.Verbatim {
			_, err := io.WriteString(w, rendered)
			return err
		}
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

// writeJSON is console.log(JSON.stringify(value, null, 2)).
func writeJSON(w io.Writer, value any) error {
	_, err := w.Write(append(jsvalue.StringifyIndent(value), '\n'))
	return err
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
	fmt.Fprintf(out, "Profile \"%s\" configured!\n", name)
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
