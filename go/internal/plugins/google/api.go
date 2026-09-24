package google

import (
	"context"

	"github.com/plosson/agentio/go/internal/plugins"
)

// API is the part of a product's API client every Google product shares: the
// command's context, its RunContext (Fail, Log, Fetch, Credentials) and the
// error shapes of the Bun clients. A product's api struct embeds it beside the
// google.golang.org/api services it builds with NewService.
type API struct {
	Ctx context.Context
	*plugins.RunContext
	// ErrorMessage is the Bun client's getErrorMessage, read by StatusError
	// and Failed. Most clients use StatusText.
	ErrorMessage func(error) string
}

// StatusText is the getErrorMessage most Bun Google clients share:
// StatusMessage with the client's own 403 and 404 wording.
func StatusText(forbidden, notFound string) func(error) string {
	return func(err error) string { return StatusMessage(err, forbidden, notFound) }
}

// APIError is Bun `throw new CliError('API_ERROR', `${prefix}: ${message}`)`
// (gcal, gmail, gtasks).
func (a API) APIError(prefix string, err error) error {
	return a.Fail("API_ERROR", prefix+": "+Message(err), "")
}

// NotFoundOr is the Bun isNotFoundError branch before APIError:
// "<what> not found: <id>".
func (a API) NotFoundOr(what, id, prefix string, err error) error {
	if IsNotFound(err) {
		return a.Fail("NOT_FOUND", what+" not found: "+id, "")
	}
	return a.APIError(prefix, err)
}

// StatusError is Bun `new CliError(getErrorCode(err), prefix +
// getErrorMessage(err), suggestion)`.
func (a API) StatusError(prefix string, err error, suggestion string) error {
	return a.Fail(ErrorCode(err), prefix+a.ErrorMessage(err), suggestion)
}

// Failed is the Bun clients' throwApiError(err, operation):
// "Failed to <operation>: <getErrorMessage>".
func (a API) Failed(operation string, err error) error {
	return a.StatusError("Failed to "+operation+": ", err, "")
}
