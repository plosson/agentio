// Package clierr is the stable error vocabulary shared by the host and plugins.
// Codes and exit statuses match src/utils/errors.ts.
package clierr

import "fmt"

type Code string

const (
	AuthFailed         Code = "AUTH_FAILED"
	TokenExpired       Code = "TOKEN_EXPIRED"
	ProfileNotFound    Code = "PROFILE_NOT_FOUND"
	InvalidParams      Code = "INVALID_PARAMS"
	APIError           Code = "API_ERROR"
	NetworkError       Code = "NETWORK_ERROR"
	PermissionDenied   Code = "PERMISSION_DENIED"
	RateLimited        Code = "RATE_LIMITED"
	NotFound           Code = "NOT_FOUND"
	ConfigError        Code = "CONFIG_ERROR"
	VaultNotConfigured Code = "VAULT_NOT_CONFIGURED"
	VaultLocked        Code = "VAULT_LOCKED"
	VaultCorrupt       Code = "VAULT_CORRUPT"
)

// Error is a user-facing failure. Plugins return it via RunContext.Fail.
type Error struct {
	Code       Code
	Message    string
	Suggestion string
}

func (e *Error) Error() string { return e.Message }

func New(code Code, message, suggestion string) *Error {
	return &Error{Code: code, Message: message, Suggestion: suggestion}
}

func ExitCode(code Code) int {
	switch code {
	case AuthFailed, TokenExpired, PermissionDenied, VaultNotConfigured, VaultLocked, VaultCorrupt:
		return 2
	case ConfigError, ProfileNotFound:
		return 3
	case NetworkError:
		return 4
	case APIError, RateLimited, NotFound:
		return 5
	default:
		return 1
	}
}

func HTTPStatus(code Code) int {
	switch code {
	case AuthFailed:
		return 401
	case PermissionDenied:
		return 403
	case InvalidParams:
		return 400
	case NotFound, ProfileNotFound:
		return 404
	case TokenExpired:
		return 409
	case RateLimited:
		return 429
	case VaultLocked:
		return 503
	default:
		return 500
	}
}

func HTTPStatusToCode(status int) Code {
	switch status {
	case 401:
		return AuthFailed
	case 403:
		return PermissionDenied
	case 404:
		return NotFound
	case 429:
		return RateLimited
	default:
		return APIError
	}
}

func MultipleProfiles(service string, names []string) *Error {
	return New(InvalidParams,
		fmt.Sprintf("Multiple %s profiles exist: %s.", service, join(names)),
		"Use --profile <name> to pick one.")
}

func ProfileNotFoundError(service, profile string) *Error {
	return New(ProfileNotFound,
		fmt.Sprintf("No %s profile %q", service, profile),
		fmt.Sprintf("Run: agentio %s profile list", service))
}

func NoCredentials(service, profile string) *Error {
	return New(AuthFailed,
		fmt.Sprintf("No credentials found for %s profile %q", service, profile),
		fmt.Sprintf("Run: agentio %s profile add --profile %s", service, profile))
}

func CannotManage(hubURL string) *Error {
	where := ""
	if hubURL != "" {
		where = " on the vault hub at " + hubURL
	}
	return New(PermissionDenied,
		"This token may not manage profiles"+where,
		"Ask the hub owner to allow this key to manage profiles")
}

func join(parts []string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += ", "
		}
		out += p
	}
	return out
}

// Known reports whether code is one this CLI understands on the wire.
func Known(code string) bool {
	switch Code(code) {
	case AuthFailed, TokenExpired, ProfileNotFound, InvalidParams, APIError, NetworkError,
		PermissionDenied, RateLimited, NotFound, ConfigError, VaultNotConfigured, VaultLocked, VaultCorrupt:
		return true
	default:
		return false
	}
}
