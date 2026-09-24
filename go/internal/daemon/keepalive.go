package daemon

import (
	"context"
	"log"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/plosson/agentio/go/internal/auth"
	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/profile"
	"github.com/plosson/agentio/go/internal/vault"
)

const (
	DefaultIntervalHours = 168
	MinIntervalHours     = 1
	MaxIntervalHours     = 336
)

type PassResult struct {
	Refreshed int
	Fresh     int
	Skipped   int
	Failed    int
}

var (
	keepMu  sync.Mutex
	passing bool
	timer   *time.Timer
	gap     time.Duration
)

func IntervalHours(raw string) int {
	if strings.TrimSpace(raw) == "" {
		return DefaultIntervalHours
	}
	hours, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || hours < 0 {
		log.Printf("Ignoring AGENTIO_KEEPALIVE_HOURS=%q: not a number of hours", raw)
		return DefaultIntervalHours
	}
	if hours == 0 {
		return 0
	}
	clamped := hours
	if clamped < MinIntervalHours {
		clamped = MinIntervalHours
	}
	if clamped > MaxIntervalHours {
		clamped = MaxIntervalHours
	}
	if clamped != hours {
		log.Printf("AGENTIO_KEEPALIVE_HOURS=%d is outside %d-%d, using %d", hours, MinIntervalHours, MaxIntervalHours, clamped)
	}
	return clamped
}

// RunRefreshPass refreshes every stored profile that is near expiry.
// It always returns. A locked vault or an overlapping pass is a skip.
func RunRefreshPass(ctx context.Context, reg *plugins.Registry, preferred []string) PassResult {
	if !vault.Unlocked() {
		log.Printf("keepalive outcome=skipped reason=%q", "vault is locked")
		return PassResult{}
	}
	auth.EnterHub()
	defer auth.LeaveHub()
	keepMu.Lock()
	if passing {
		keepMu.Unlock()
		log.Printf("keepalive outcome=skipped reason=%q", "a pass is already running")
		return PassResult{}
	}
	passing = true
	keepMu.Unlock()
	defer func() {
		keepMu.Lock()
		passing = false
		keepMu.Unlock()
	}()
	result, err := walk(ctx, reg, preferred)
	if err != nil {
		reason := err.Error()
		if ce, ok := err.(*clierr.Error); ok {
			reason = string(ce.Code)
		}
		log.Printf("keepalive outcome=aborted reason=%s", reason)
		return PassResult{}
	}
	log.Printf("keepalive outcome=pass refreshed=%d fresh=%d skipped=%d failed=%d", result.Refreshed, result.Fresh, result.Skipped, result.Failed)
	return result
}

func walk(ctx context.Context, reg *plugins.Registry, preferred []string) (PassResult, error) {
	var result PassResult
	refs, err := profile.List("", preferred)
	if err != nil {
		return result, err
	}
	for _, ref := range refs {
		has, err := auth.HasCredentials(ref.Service, ref.Name)
		if err != nil {
			return result, err
		}
		if !has {
			result.Skipped++
			continue
		}
		fresh, err := auth.GetFresh(ctx, reg, ref.Service, ref.Name, auth.RefreshOptions{Buffer: auth.HubRefreshBuffer})
		if err != nil {
			result.Failed++
			reason := err.Error()
			if ce, ok := err.(*clierr.Error); ok {
				reason = string(ce.Code)
			}
			log.Printf("keepalive profile=%s/%s outcome=failed reason=%s", ref.Service, ref.Name, reason)
			continue
		}
		if fresh.Refreshed {
			result.Refreshed++
		} else {
			result.Fresh++
		}
	}
	return result, nil
}

func StartKeepalive(ctx context.Context, reg *plugins.Registry, preferred []string, hours int) {
	StopKeepalive()
	if hours == 0 {
		log.Printf("Token keepalive is off (AGENTIO_KEEPALIVE_HOURS=0)")
		return
	}
	gap = time.Duration(hours) * time.Hour
	log.Printf("Token keepalive every %dh", hours)
	schedule(ctx, reg, preferred, 0)
}

func schedule(ctx context.Context, reg *plugins.Registry, preferred []string, delay time.Duration) {
	timer = time.AfterFunc(delay, func() {
		RunRefreshPass(ctx, reg, preferred)
		keepMu.Lock()
		alive := timer != nil
		keepMu.Unlock()
		if alive {
			schedule(ctx, reg, preferred, gap)
		}
	})
}

func StopKeepalive() {
	keepMu.Lock()
	if timer != nil {
		timer.Stop()
		timer = nil
	}
	keepMu.Unlock()
}

func KeepaliveRunning() bool {
	keepMu.Lock()
	defer keepMu.Unlock()
	return timer != nil
}

func KeepaliveFromEnv(ctx context.Context, reg *plugins.Registry, preferred []string) {
	StartKeepalive(ctx, reg, preferred, IntervalHours(os.Getenv("AGENTIO_KEEPALIVE_HOURS")))
}
