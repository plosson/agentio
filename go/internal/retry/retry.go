// Package retry is Bun utils/batch.ts retryWithBackoff: the backoff services
// use around provider calls. It retries HTTP 429, 5xx, and quota-style 403s.
package retry

import (
	"errors"
	"math"
	"math/rand"
	"regexp"
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
	// MaxRetries is the number of retries after the first try; zero retries
	// nothing. Bun's `maxRetries ?? 5` default is the caller's.
	MaxRetries int
	// OnRetry receives the 1-based retry number, as Bun's onRetry does.
	OnRetry func(attempt int, delay time.Duration, err error)
	Sleep   func(time.Duration)
	// Now is the clock behind the wait to the next minute; nil is time.Now.
	Now func() time.Time
}

func Do(fn func() error, opt Options) error {
	sleep := opt.Sleep
	if sleep == nil {
		sleep = time.Sleep
	}
	now := opt.Now
	if now == nil {
		now = time.Now
	}
	var last error
	for attempt := 0; attempt <= opt.MaxRetries; attempt++ {
		err := fn()
		if err == nil {
			return nil
		}
		last = err
		if attempt == opt.MaxRetries || !retryable(err) {
			return err
		}
		delay := backoffDelay(attempt)
		if quotaExceeded(err) {
			delay = untilNextMinute(now())
		}
		if opt.OnRetry != nil {
			opt.OnRetry(attempt+1, delay, err)
		}
		sleep(delay)
	}
	return last
}

var quotaPattern = regexp.MustCompile(`(?i)rateLimitExceeded|quotaExceeded|userRateLimitExceeded`)

func quotaExceeded(err error) bool {
	var se *StatusError
	return errors.As(err, &se) && se.Status == 403 && quotaPattern.MatchString(se.Message)
}

func retryable(err error) bool {
	var se *StatusError
	if !errors.As(err, &se) {
		return false
	}
	if se.Status == 429 || (se.Status >= 500 && se.Status < 600) {
		return true
	}
	return quotaExceeded(err)
}

// backoffDelay is 500ms, 1s, 2s, 4s, 8s with ±25% jitter.
func backoffDelay(attempt int) time.Duration {
	base := 500 * math.Pow(2, float64(attempt))
	jitter := base * 0.25 * (rand.Float64()*2 - 1)
	ms := math.Max(0, math.Round(base+jitter))
	return time.Duration(ms) * time.Millisecond
}

// untilNextMinute is Bun msUntilNextMinute: 60000 - (now % 60000) + 250 ms.
func untilNextMinute(now time.Time) time.Duration {
	ms := now.UnixMilli()
	return time.Duration(60_000-ms%60_000+250) * time.Millisecond
}
