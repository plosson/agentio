package google

import (
	"os"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
)

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
// --requests-json and --file, holding a JSON array, kept in order. A given
// empty --requests-json is still the source (Bun `requestsJson ?? readFile`).
func BatchRequests(in plugins.CommandInput, fail plugins.FailFunc) ([]any, error) {
	requestsJSON, inline := in.LookupOption("requests-json")
	file := in.Option("file")
	if requestsJSON == "" && file == "" {
		return nil, fail("INVALID_PARAMS", "Provide --requests-json or --file", "")
	}
	if requestsJSON != "" && file != "" {
		return nil, fail("INVALID_PARAMS", "--requests-json and --file are mutually exclusive", "")
	}
	source := []byte(requestsJSON)
	if !inline {
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

// BatchInputError is BatchRequests' rejection, for plugins.WriteUnlessInvalid: Bun
// reports bad input before enforceWriteAccess.
func BatchInputError(in plugins.CommandInput, fail plugins.FailFunc) error {
	_, err := BatchRequests(in, fail)
	return err
}
