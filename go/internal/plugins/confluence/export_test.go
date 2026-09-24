package confluence

import "github.com/plosson/agentio/go/internal/plugins/atlassian"

// The names the tests used before the Atlassian layer was shared.
const (
	atlassianClientID  = atlassian.ClientID
	atlassianSecretEnc = atlassian.SecretEnc
)

var (
	setup              = app.Setup
	reauth             = app.Reauthenticate
	refresh            = atlassian.Refresh
	stale              = atlassian.IsStale
	applies            = atlassian.Applies
	extractTextFromAdf = atlassian.ExtractTextFromADF
)
