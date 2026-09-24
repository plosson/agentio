package retry

import (
	"errors"
	"testing"
	"time"
)

func TestRetryGivesUpOnAClientErrorAndRetriesQuota(t *testing.T) {
	calls := 0
	err := Do(func() error {
		calls++
		return &StatusError{Status: 400, Message: "bad"}
	}, Options{MaxRetries: 3, Sleep: func(time.Duration) {}})
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
	}, Options{MaxRetries: 2, Sleep: func(time.Duration) {}})
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
