package google

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/plosson/agentio/go/internal/plugins"
	"google.golang.org/api/googleapi"
)

// Message is the error.message Bun reads off a failed googleapis call: gaxios
// extracts it from the response body. Any other error keeps its own text.
func Message(err error) string {
	var ge *googleapi.Error
	if errors.As(err, &ge) {
		return gaxiosMessage(ge.Code, []byte(ge.Body))
	}
	return plugins.FetchFailure(err).Error()
}

// Code is the numeric error.code Bun reads off a failed googleapis call (the
// body's error.code, else the HTTP status), or 0 when there is none.
func Code(err error) int {
	var ge *googleapi.Error
	if !errors.As(err, &ge) {
		return 0
	}
	var reply struct {
		Error json.RawMessage `json:"error"`
	}
	if json.Unmarshal([]byte(ge.Body), &reply) == nil && len(reply.Error) > 0 {
		var inner map[string]any
		if json.Unmarshal(reply.Error, &inner) == nil {
			if raw, ok := inner["code"]; ok {
				if n, ok := raw.(float64); ok {
					return int(n)
				}
				return 0
			}
		}
	}
	return ge.Code
}

// IsNotFound is the Bun clients' isNotFoundError: error.code === 404.
func IsNotFound(err error) bool {
	return Code(err) == 404
}

// ErrorCode is the Bun clients' getErrorCode: the mapped numeric code, else
// API_ERROR (no code is 0, which the mapping also answers with API_ERROR).
func ErrorCode(err error) plugins.ErrorCode {
	return plugins.HTTPStatusToErrorCode(Code(err))
}

// StatusMessage is the Bun clients' getErrorMessage: fixed text for 401 and
// 429, the product's own text for 403 and 404, else Message.
func StatusMessage(err error, forbidden, notFound string) string {
	switch Code(err) {
	case 401:
		return "OAuth token expired or invalid"
	case 403:
		return forbidden
	case 404:
		return notFound
	case 429:
		return "Rate limit exceeded, please try again later"
	}
	return Message(err)
}

// ValidationFailure is the catch branch every Bun Google client's validate
// shares: an expired or revoked grant asks for re-authentication.
func ValidationFailure(err error) plugins.ValidationResult {
	message := Message(err)
	if strings.Contains(message, "invalid_grant") || strings.Contains(message, "Token has been expired or revoked") {
		return plugins.ValidationResult{Valid: false, Error: "refresh token expired, re-authenticate"}
	}
	return plugins.ValidationResult{Valid: false, Error: message}
}

// gaxiosMessage is GaxiosError.extractAPIErrorFromResponse: body.error.message,
// else the joined body.error.errors[].message, else a string error or body,
// else "Request failed with status code N".
func gaxiosMessage(status int, body []byte) string {
	var data any
	if err := json.Unmarshal(body, &data); err != nil {
		return string(body)
	}
	switch d := data.(type) {
	case string:
		return d
	case map[string]any:
		switch e := d["error"].(type) {
		case string:
			if e != "" {
				return e
			}
		case map[string]any:
			if m, ok := e["message"]; ok {
				if s, ok := m.(string); ok {
					return s
				}
				return fmt.Sprint(m)
			}
			if items, ok := e["errors"].([]any); ok {
				var parts []string
				for _, item := range items {
					if obj, ok := item.(map[string]any); ok {
						if s, ok := obj["message"].(string); ok {
							parts = append(parts, s)
						}
					}
				}
				if len(parts) > 0 {
					return strings.Join(parts, "\n")
				}
			}
		}
	}
	return fmt.Sprintf("Request failed with status code %d", status)
}
