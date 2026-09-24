package google

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
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

// EmailListInfo is the Bun getExtraInfo every Google product shows in
// `profile list`: " - <email>" when the profile has one.
func EmailListInfo(creds map[string]any) string {
	if email, _ := creds["email"].(string); email != "" {
		return " - " + email
	}
	return ""
}

// BatchRequests is the input the Bun batchUpdate escape hatches (gdocs,
// gsheets, gslides) read before they resolve the profile: exactly one of
// --requests-json and --file, holding a JSON array, kept in order.
func BatchRequests(in plugins.CommandInput, fail func(plugins.ErrorCode, string, string) error) ([]any, error) {
	requestsJSON, _ := in.Options["requests-json"].(string)
	file, _ := in.Options["file"].(string)
	if requestsJSON == "" && file == "" {
		return nil, fail("INVALID_PARAMS", "Provide --requests-json or --file", "")
	}
	if requestsJSON != "" && file != "" {
		return nil, fail("INVALID_PARAMS", "--requests-json and --file are mutually exclusive", "")
	}
	source := []byte(requestsJSON)
	if file != "" {
		raw, err := os.ReadFile(file)
		if err != nil {
			return nil, err
		}
		source = raw
	}
	parsed, err := jsvalue.Parse(source)
	if err != nil {
		return nil, fail("INVALID_PARAMS", "Invalid JSON: "+jsvalue.ParseErrorMessage(source), "")
	}
	requests, ok := parsed.([]any)
	if !ok {
		return nil, fail("INVALID_PARAMS", "Input must be a JSON array of Request objects", "")
	}
	return requests, nil
}

// BatchInputError is BatchRequests' rejection, for WriteUnlessInvalid: Bun
// reports bad input before enforceWriteAccess.
func BatchInputError(in plugins.CommandInput, fail func(plugins.ErrorCode, string, string) error) error {
	_, err := BatchRequests(in, fail)
	return err
}
