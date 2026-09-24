// Package retry is the backoff helper services use around provider calls.
// It retries HTTP 429, 5xx, and quota-style 403s.
package retry

import (
	"errors"
	"math"
	"math/rand"
	"strings"
	"time"
)

type StatusError struct {
	Status  int
	Message string
}

func (e *StatusError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return "request failed"
}

type Options struct {
	MaxRetries int
	OnRetry    func(attempt int, delay time.Duration, err error)
	Sleep      func(time.Duration)
}

func Do(fn func() error, opt Options) error {
	max := opt.MaxRetries
	if max == 0 {
		max = 5
	}
	sleep := opt.Sleep
	if sleep == nil {
		sleep = time.Sleep
	}
	var last error
	for attempt := 0; attempt <= max; attempt++ {
		err := fn()
		if err == nil {
			return nil
		}
		last = err
		if attempt == max || !retryable(err) {
			return err
		}
		delay := backoff(attempt, err)
		if opt.OnRetry != nil {
			opt.OnRetry(attempt, delay, err)
		}
		sleep(delay)
	}
	return last
}

func retryable(err error) bool {
	var se *StatusError
	if !errors.As(err, &se) {
		return false
	}
	if se.Status == 429 || (se.Status >= 500 && se.Status < 600) {
		return true
	}
	if se.Status == 403 && (strings.Contains(se.Message, "rateLimitExceeded") || strings.Contains(se.Message, "quotaExceeded") || strings.Contains(se.Message, "userRateLimitExceeded")) {
		return true
	}
	return false
}

func backoff(attempt int, err error) time.Duration {
	var se *StatusError
	if errors.As(err, &se) && se.Status == 429 {
		now := time.Now()
		return time.Until(now.Truncate(time.Minute).Add(time.Minute)) + 250*time.Millisecond
	}
	base := 500 * math.Pow(2, float64(attempt))
	jitter := base * 0.25 * (rand.Float64()*2 - 1)
	ms := math.Max(0, math.Round(base+jitter))
	return time.Duration(ms) * time.Millisecond
}
