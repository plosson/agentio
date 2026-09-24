package retry

import (
	"errors"
	"testing"
	"time"
)

func noSleep(time.Duration) {}

func TestRetryGivesUpOnAClientErrorAndRetriesQuota(t *testing.T) {
	calls := 0
	err := Do(func() error {
		calls++
		return &StatusError{Status: 400, Message: "bad"}
	}, Options{MaxRetries: 3, Sleep: noSleep})
	if calls != 1 || err == nil {
		t.Fatalf("calls %d err %v", calls, err)
	}
	calls = 0
	err = Do(func() error {
		calls++
		if calls < 3 {
			return &StatusError{Status: 403, Message: "quotaExceeded"}
		}
		return nil
	}, Options{MaxRetries: 2, Sleep: noSleep})
	if err != nil || calls != 3 {
		t.Fatalf("calls %d err %v", calls, err)
	}
	calls = 0
	err = Do(func() error {
		calls++
		return errors.New("boom")
	}, Options{MaxRetries: 4, Sleep: func(time.Duration) { t.Fatal("slept on a non-status error") }})
	if calls != 1 {
		t.Fatal(calls)
	}
}

// Bun `retryWithBackoff(fn, { maxRetries: 0 })` tries once: zero is not "use
// the default".
func TestZeroRetriesTriesOnce(t *testing.T) {
	calls := 0
	err := Do(func() error {
		calls++
		return &StatusError{Status: 503, Message: "unavailable"}
	}, Options{MaxRetries: 0, Sleep: func(time.Duration) { t.Fatal("slept with zero retries") }})
	if calls != 1 || err == nil || err.Error() != "unavailable" {
		t.Fatalf("calls %d err %v", calls, err)
	}
}

// The last error comes back after MaxRetries retries of a 5xx.
func TestRetriesExhaustAndReturnTheLastError(t *testing.T) {
	calls := 0
	var attempts []int
	err := Do(func() error {
		calls++
		return &StatusError{Status: 500 + calls, Message: "server"}
	}, Options{MaxRetries: 2, Sleep: noSleep, OnRetry: func(a int, _ time.Duration, _ error) { attempts = append(attempts, a) }})
	var se *StatusError
	if calls != 3 || !errors.As(err, &se) || se.Status != 503 {
		t.Fatalf("calls %d err %#v", calls, err)
	}
	if len(attempts) != 2 || attempts[0] != 1 || attempts[1] != 2 {
		t.Fatalf("onRetry attempts %v", attempts)
	}
}

// Bun waits to the next minute only for a quota 403 (matched without regard
// to case); a 429 gets the jittered backoff.
func TestQuotaWaitsForTheNextMinuteAnd429BacksOff(t *testing.T) {
	at := time.UnixMilli(1_700_000_012_345)
	var delays []time.Duration
	calls := 0
	_ = Do(func() error {
		calls++
		if calls == 1 {
			return &StatusError{Status: 403, Message: "User RATELIMITEXCEEDED here"}
		}
		return &StatusError{Status: 429, Message: "slow down"}
	}, Options{MaxRetries: 1, Sleep: func(d time.Duration) { delays = append(delays, d) }, Now: func() time.Time { return at }})
	want := time.Duration(60_000-1_700_000_012_345%60_000+250) * time.Millisecond
	if len(delays) != 1 || delays[0] != want {
		t.Fatalf("quota delay %v want %v", delays, want)
	}
	delays = nil
	_ = Do(func() error { return &StatusError{Status: 429, Message: "slow down"} },
		Options{MaxRetries: 1, Sleep: func(d time.Duration) { delays = append(delays, d) }, Now: func() time.Time { return at }})
	if len(delays) != 1 || delays[0] < 375*time.Millisecond || delays[0] > 625*time.Millisecond {
		t.Fatalf("429 delay %v", delays)
	}
	// A plain 403 (no quota wording) is a permission error, not retried.
	calls = 0
	_ = Do(func() error { calls++; return &StatusError{Status: 403, Message: "Forbidden"} }, Options{MaxRetries: 3, Sleep: noSleep})
	if calls != 1 {
		t.Fatalf("plain 403 retried %d times", calls)
	}
}
