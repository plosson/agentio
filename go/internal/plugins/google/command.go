package google

import (
	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/nodefs"
	"github.com/plosson/agentio/go/internal/plugins"
)

// EmailListInfo is the Bun getExtraInfo every Google product shows in
// `profile list`: " - <email>" when the profile has one.
func EmailListInfo(creds plugins.Credentials) string {
	if email, _ := creds.Value("email").(string); email != "" {
		return " - " + email
	}
	return ""
}

// BatchRequests is the input the Bun batchUpdate escape hatches (gdocs,
// gsheets, gslides) read before they resolve the profile (their Prepare): exactly one of
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
		raw, err := nodefs.ReadFile(file)
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
