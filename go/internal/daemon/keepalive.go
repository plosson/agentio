package daemon

import (
	"context"
	"fmt"
	"math"
	"os"
	"sync"
	"time"

	"github.com/plosson/agentio/go/internal/auth"
	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/jsvalue"
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
	// keepaliveUnit is what one AGENTIO_KEEPALIVE_HOURS is worth. Tests shorten it.
	keepaliveUnit = time.Hour
)

// IntervalHours is Bun's intervalHours: hours between passes, read with
// Number(raw). Zero turns the loop off; anything else is clamped into range,
// and anything unparseable is the default, each with a line saying so.
func IntervalHours(raw string) float64 {
	if jsvalue.Trim(raw) == "" {
		return DefaultIntervalHours
	}
	hours := jsvalue.Number(raw)
	if math.IsNaN(hours) || math.IsInf(hours, 0) || hours < 0 {
		say(`Ignoring AGENTIO_KEEPALIVE_HOURS="` + raw + `": not a number of hours`)
		return DefaultIntervalHours
	}
	if hours == 0 {
		return 0
	}
	clamped := math.Min(math.Max(hours, MinIntervalHours), MaxIntervalHours)
	if clamped != hours {
		say(fmt.Sprintf("AGENTIO_KEEPALIVE_HOURS=%s is outside %d-%d, using %s",
			jsvalue.NumberString(hours), MinIntervalHours, MaxIntervalHours, jsvalue.NumberString(clamped)))
	}
	return clamped
}

// RunRefreshPass refreshes every stored profile that is near expiry.
// It always returns. A locked vault or an overlapping pass is a skip.
func RunRefreshPass(ctx context.Context, reg *plugins.Registry) PassResult {
	if !vault.Unlocked() {
		daemonLog("keepalive", field{"outcome", "skipped"}, field{"reason", "vault is locked"})
		return PassResult{}
	}
	auth.EnterHub()
	defer auth.LeaveHub()
	keepMu.Lock()
	if passing {
		keepMu.Unlock()
		daemonLog("keepalive", field{"outcome", "skipped"}, field{"reason", "a pass is already running"})
		return PassResult{}
	}
	passing = true
	keepMu.Unlock()
	defer func() {
		keepMu.Lock()
		passing = false
		keepMu.Unlock()
	}()
	result, err := walk(ctx, reg)
	if err != nil {
		daemonLog("keepalive", field{"outcome", "aborted"}, field{"reason", reasonOf(err)})
		return PassResult{}
	}
	daemonLog("keepalive", field{"outcome", "pass"}, field{"refreshed", result.Refreshed},
		field{"fresh", result.Fresh}, field{"skipped", result.Skipped}, field{"failed", result.Failed})
	return result
}

// reasonOf is a failure as the keepalive lines name it: the code of a CLI
// error, the message of anything else.
func reasonOf(err error) string {
	if ce, ok := err.(*clierr.Error); ok {
		return string(ce.Code)
	}
	return err.Error()
}

func walk(ctx context.Context, reg *plugins.Registry) (PassResult, error) {
	var result PassResult
	// Both listings are read once, before any refresh: only they can abort the
	// pass. A profile with nothing stored was added but never authorised.
	stored, err := auth.AllCredentials()
	if err != nil {
		return result, err
	}
	refs, err := profile.List("")
	if err != nil {
		return result, err
	}
	for _, ref := range refs {
		if !stored.Has(ref.Service, ref.Name) {
			result.Skipped++
			continue
		}
		fresh, err := auth.GetFresh(ctx, reg, ref.Service, ref.Name, auth.RefreshOptions{Buffer: auth.HubRefreshBuffer})
		if err != nil {
			result.Failed++
			daemonLog("keepalive", field{"profile", ref.Service + "/" + ref.Name}, field{"outcome", "failed"}, field{"reason", reasonOf(err)})
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

func StartKeepalive(ctx context.Context, reg *plugins.Registry, hours float64) {
	keepMu.Lock()
	defer keepMu.Unlock()
	stopLocked()
	if hours == 0 {
		say("Token keepalive is off (AGENTIO_KEEPALIVE_HOURS=0)")
		return
	}
	gap = time.Duration(hours * float64(keepaliveUnit))
	say("Token keepalive every " + jsvalue.NumberString(hours) + "h")
	schedule(ctx, reg, 0)
}

// schedule arms the next pass. The caller holds keepMu.
func schedule(ctx context.Context, reg *plugins.Registry, delay time.Duration) {
	var t *time.Timer
	t = time.AfterFunc(delay, func() {
		waitForBoot()
		RunRefreshPass(ctx, reg)
		keepMu.Lock()
		defer keepMu.Unlock()
		// Only carry on if nothing stopped or restarted the loop while the pass ran.
		if timer == t {
			schedule(ctx, reg, gap)
		}
	})
	timer = t
}

func StopKeepalive() {
	keepMu.Lock()
	defer keepMu.Unlock()
	stopLocked()
}

func stopLocked() {
	if timer != nil {
		timer.Stop()
		timer = nil
	}
}

func KeepaliveRunning() bool {
	keepMu.Lock()
	defer keepMu.Unlock()
	return timer != nil
}

func KeepaliveFromEnv(ctx context.Context, reg *plugins.Registry) {
	StartKeepalive(ctx, reg, IntervalHours(os.Getenv("AGENTIO_KEEPALIVE_HOURS")))
}
