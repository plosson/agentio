package google

import (
	"errors"
	"fmt"
	"strings"

	"github.com/plosson/agentio/go/internal/plugins"
)

// Result drops a typed nil on failure: the host prints any non-nil value
// returned with an error, and Bun printed nothing before throwing.
func Result[T any](v T, err error) (any, error) {
	if err != nil {
		return nil, err
	}
	return v, nil
}

// RequireOptions is Commander's requiredOption check, in declaration order.
// flags are the Bun declarations ("--space <id>").
func RequireOptions(in plugins.CommandInput, run *plugins.RunContext, flags ...string) error {
	for _, f := range flags {
		name := strings.TrimPrefix(strings.Fields(f)[0], "--")
		if s, _ := in.Options[name].(string); s == "" {
			return run.Fail("INVALID_PARAMS", fmt.Sprintf("required option '%s' not specified", f), "")
		}
	}
	return nil
}

// WriteUnlessInvalid is an AccessFor that lets input check rejects reach Run,
// which reports it: a Bun command that validates its input before calling
// enforceWriteAccess answers a read-only profile with the input error.
func WriteUnlessInvalid(check func(plugins.CommandInput, func(plugins.ErrorCode, string, string) error) error) func(plugins.CommandInput) string {
	return func(in plugins.CommandInput) string {
		if check(in, func(plugins.ErrorCode, string, string) error { return errInvalid }) != nil {
			return "read"
		}
		return "write"
	}
}

var errInvalid = errors.New("invalid")
