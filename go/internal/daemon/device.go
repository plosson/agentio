package daemon

import (
	"crypto/rand"
	"encoding/base64"
	"strings"
	"sync"
	"time"

	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/profile"
)

const (
	DeviceTTL          = 10 * time.Minute
	DevicePollInterval = 3
	maxPending         = 100
	codeAlphabet       = "BCDFGHJKLMNPQRSTVWXZ23456789"
)

type DeviceStart struct {
	UserCode   string `json:"userCode"`
	DeviceCode string `json:"deviceCode"`
	ExpiresIn  int    `json:"expiresIn"`
	Interval   int    `json:"interval"`
}

type DeviceView struct {
	UserCode  string `json:"userCode"`
	Name      string `json:"name"`
	CreatedAt string `json:"createdAt"`
	ExpiresAt string `json:"expiresAt"`
}

type DevicePoll struct {
	Status string           `json:"status"`
	Key    *profile.KeyView `json:"key,omitempty"`
	Token  string           `json:"token,omitempty"`
}

type pending struct {
	userCode   string
	deviceCode string
	name       string
	createdAt  time.Time
	outcome    DevicePoll
}

var (
	deviceMu sync.Mutex
	pendingN = map[string]*pending{}
)

func ResetDevice() {
	deviceMu.Lock()
	pendingN = map[string]*pending{}
	deviceMu.Unlock()
}

func NormalizeUserCode(input string) string {
	raw := strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' {
			r = r - 'a' + 'A'
		}
		if (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			return r
		}
		return -1
	}, input)
	if len(raw) == 8 {
		return raw[:4] + "-" + raw[4:]
	}
	return raw
}

func StartDevice(name string, now time.Time) (DeviceStart, error) {
	machine, err := profile.ValidateKeyName(name)
	if err != nil {
		return DeviceStart{}, err
	}
	deviceMu.Lock()
	defer deviceMu.Unlock()
	for code, req := range pendingN {
		if now.Sub(req.createdAt) > DeviceTTL {
			delete(pendingN, code)
		}
	}
	if len(pendingN) >= maxPending {
		return DeviceStart{}, clierr.New(clierr.RateLimited, "Too many logins waiting for approval, try again in a few minutes", "")
	}
	taken := map[string]bool{}
	for _, req := range pendingN {
		taken[req.userCode] = true
	}
	userCode := newUserCode()
	for taken[userCode] {
		userCode = newUserCode()
	}
	buf := make([]byte, 32)
	_, _ = rand.Read(buf)
	deviceCode := base64.RawURLEncoding.EncodeToString(buf)
	pendingN[deviceCode] = &pending{
		userCode: userCode, deviceCode: deviceCode, name: machine, createdAt: now,
		outcome: DevicePoll{Status: "pending"},
	}
	return DeviceStart{UserCode: userCode, DeviceCode: deviceCode, ExpiresIn: int(DeviceTTL.Seconds()), Interval: DevicePollInterval}, nil
}

func newUserCode() string {
	part := func() string {
		b := make([]byte, 4)
		_, _ = rand.Read(b)
		out := make([]byte, 4)
		for i := range out {
			out[i] = codeAlphabet[int(b[i])%len(codeAlphabet)]
		}
		return string(out)
	}
	return part() + "-" + part()
}

func PollDevice(deviceCode string, now time.Time) (DevicePoll, error) {
	deviceMu.Lock()
	defer deviceMu.Unlock()
	req := pendingN[deviceCode]
	if req == nil || now.Sub(req.createdAt) > DeviceTTL {
		if req != nil {
			delete(pendingN, deviceCode)
		}
		return DevicePoll{}, unknownCode()
	}
	out := req.outcome
	if out.Status != "pending" {
		delete(pendingN, deviceCode)
	}
	return out, nil
}

func DescribeDevice(userCode string, now time.Time) (DeviceView, error) {
	req, err := live(userCode, now)
	if err != nil {
		return DeviceView{}, err
	}
	return DeviceView{
		UserCode: req.userCode, Name: req.name,
		CreatedAt: isoTime(req.createdAt),
		ExpiresAt: isoTime(req.createdAt.Add(DeviceTTL)),
	}, nil
}

func ApproveDevice(userCode string, input profile.KeyInput, hubURL string, now time.Time) (profile.KeyView, error) {
	deviceMu.Lock()
	req, err := liveLocked(userCode, now)
	deviceMu.Unlock()
	if err != nil {
		return profile.KeyView{}, err
	}
	issued, err := profile.CreateKey(input, hubURL)
	if err != nil {
		return profile.KeyView{}, err
	}
	deviceMu.Lock()
	if cur := pendingN[req.deviceCode]; cur != nil && cur.outcome.Status == "pending" {
		cur.outcome = DevicePoll{Status: "approved", Key: &issued.Key, Token: issued.Token}
	}
	deviceMu.Unlock()
	return issued.Key, nil
}

func DenyDevice(userCode string, now time.Time) error {
	deviceMu.Lock()
	defer deviceMu.Unlock()
	req, err := liveLocked(userCode, now)
	if err != nil {
		return err
	}
	req.outcome = DevicePoll{Status: "denied"}
	return nil
}

func live(userCode string, now time.Time) (*pending, error) {
	deviceMu.Lock()
	defer deviceMu.Unlock()
	return liveLocked(userCode, now)
}

func liveLocked(userCode string, now time.Time) (*pending, error) {
	code := NormalizeUserCode(userCode)
	for _, req := range pendingN {
		if req.userCode == code && now.Sub(req.createdAt) <= DeviceTTL && req.outcome.Status == "pending" {
			return req, nil
		}
	}
	return nil, unknownCode()
}

// isoTime is JavaScript's Date.toISOString: UTC, milliseconds, Z.
func isoTime(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

func unknownCode() *clierr.Error {
	return clierr.New(clierr.NotFound, "Unknown or expired login code", "Run `agentio login` again to get a new one")
}
