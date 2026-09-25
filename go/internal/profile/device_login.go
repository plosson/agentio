package profile

import (
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"os"
	"regexp"
	"time"

	"github.com/plosson/agentio/go/internal/auth"
	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/jsvalue"
)

// Client side of the hub's device login (Bun src/auth/device-login.ts): ask
// for a code, show it, poll until the owner decides.

type DeviceLoginOptions struct {
	// URL is the hub as typed; only its origin is used, https when no scheme.
	URL string
	// Name introduces this machine; blank is the hostname.
	Name string
	// OnCode is called once with the code, the page the owner must open and
	// the hub's expiresIn (seconds).
	OnCode func(userCode, verifyURL string, expiresIn float64)
	// PollInterval replaces the interval the hub asks for (tests).
	PollInterval time.Duration
	// Sleep waits between polls; nil is time.Sleep.
	Sleep func(time.Duration)
}

type DeviceLoginResult struct {
	URL   string
	Token string
	Key   KeyView
}

var schemePrefix = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.-]*://`)

// HubOrigin is the origin of the hub URL, https assumed without a scheme.
func HubOrigin(input string) (string, error) {
	if !schemePrefix.MatchString(input) {
		input = "https://" + input
	}
	return ValidateHubURL(input)
}

func errorCode(err error) clierr.Code {
	var ce *clierr.Error
	if errors.As(err, &ce) {
		return ce.Code
	}
	return ""
}

// jsNumber is `value * 1` for a JSON value: NaN for anything that is not a
// number, a numeric string, a boolean or null.
func jsNumber(v any) float64 {
	switch t := v.(type) {
	case nil:
		return 0
	case float64:
		return t
	case bool:
		if t {
			return 1
		}
		return 0
	case string:
		return jsvalue.Number(t)
	}
	return math.NaN()
}

// timeoutDelay is setTimeout's delay: 1 ms unless it is a number from 1 to 2^31-1.
func timeoutDelay(ms float64) time.Duration {
	if !(ms >= 1 && ms <= math.MaxInt32) {
		ms = 1
	}
	return time.Duration(ms * float64(time.Millisecond))
}

func DeviceLogin(opts DeviceLoginOptions) (DeviceLoginResult, error) {
	origin, err := HubOrigin(opts.URL)
	if err != nil {
		return DeviceLoginResult{}, err
	}
	name := jsvalue.Trim(opts.Name)
	if name == "" {
		name, _ = os.Hostname()
	}
	sleep := opts.Sleep
	if sleep == nil {
		sleep = time.Sleep
	}
	notAHub := clierr.New(clierr.ConfigError, origin+" does not offer device login", "Is this the hub URL, and is the hub up to date?")
	raw, _, err := auth.HubCall(origin, "/v1/device", auth.Call{Method: http.MethodPost, Body: map[string]string{"name": name}})
	if err != nil {
		// Not a hub at all (404), or a hub too old to have the route, which
		// answers with its bearer check instead.
		if code := errorCode(err); code == clierr.NotFound || code == clierr.AuthFailed {
			return DeviceLoginResult{}, notAHub
		}
		return DeviceLoginResult{}, err
	}
	// A landing page answers 200 with HTML, which is no JSON object.
	var start map[string]any
	if json.Unmarshal(raw, &start) != nil || start == nil {
		return DeviceLoginResult{}, notAHub
	}
	userCode, ok1 := start["userCode"].(string)
	deviceCode, ok2 := start["deviceCode"].(string)
	if !ok1 || !ok2 {
		return DeviceLoginResult{}, notAHub
	}
	expiresIn := math.NaN()
	if v, ok := start["expiresIn"]; ok {
		expiresIn = jsNumber(v)
	}
	if opts.OnCode != nil {
		opts.OnCode(userCode, origin+"/ui#authorize="+userCode, expiresIn)
	}
	nowMs := func() float64 { return float64(time.Now().UnixMilli()) }
	deadline := nowMs() + expiresIn*1000
	interval := float64(opts.PollInterval) / float64(time.Millisecond)
	if opts.PollInterval == 0 {
		interval = math.NaN()
		if v, ok := start["interval"]; ok {
			interval = jsNumber(v) * 1000
		}
	}
	for nowMs() < deadline {
		sleep(timeoutDelay(interval))
		body, _, err := auth.HubCall(origin, "/v1/device/token", auth.Call{Method: http.MethodPost, Body: map[string]string{"deviceCode": deviceCode}})
		if err != nil {
			code := errorCode(err)
			if code == clierr.NotFound {
				break // the hub forgot it: expired, or restarted
			}
			if code == clierr.RateLimited {
				interval *= 2
				continue
			}
			return DeviceLoginResult{}, err
		}
		var answer struct {
			Status string  `json:"status"`
			Token  string  `json:"token"`
			Key    KeyView `json:"key"`
		}
		_ = json.Unmarshal(body, &answer)
		switch answer.Status {
		case "approved":
			return DeviceLoginResult{URL: origin, Token: answer.Token, Key: answer.Key}, nil
		case "denied":
			return DeviceLoginResult{}, clierr.New(clierr.AuthFailed, "The hub owner denied this login", "")
		}
	}
	return DeviceLoginResult{}, clierr.New(clierr.AuthFailed, "The login code expired before it was approved",
		"Run `agentio login` again and approve within ten minutes")
}
