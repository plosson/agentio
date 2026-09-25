package auth

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/vault"
)

const (
	// RefreshBuffer is how early a CLI refreshes an access token.
	RefreshBuffer = 5 * time.Minute
	// HubRefreshBuffer is wider, so a token the hub hands out is not one the
	// client immediately wants to refresh itself.
	HubRefreshBuffer = 10 * time.Minute
)

type Fresh struct {
	Credentials map[string]any
	Refreshed   bool
}

type RefreshOptions struct {
	Buffer time.Duration
	Force  bool
	Now    time.Time
}

// One chain per profile. Concurrent callers wait for the refresh in flight
// instead of each refreshing and clobbering the vault. Atlassian's rotating
// refresh tokens make a double refresh fatal. This serialises within one
// process only.
var (
	chainMu sync.Mutex
	tails   = map[string]chan struct{}{}
)

func serialized(key string, task func() (Fresh, error)) (Fresh, error) {
	chainMu.Lock()
	prev, ok := tails[key]
	ch := make(chan struct{})
	tails[key] = ch
	chainMu.Unlock()
	if ok {
		<-prev
	}
	defer func() {
		close(ch)
		chainMu.Lock()
		if tails[key] == ch {
			delete(tails, key)
		}
		chainMu.Unlock()
	}()
	return task()
}

// GetFresh loads credentials, refreshes them when stale or forced, and
// persists the replacement before returning it.
func GetFresh(ctx context.Context, reg *plugins.Registry, service, profileName string, opt RefreshOptions) (Fresh, error) {
	return serialized(service+"/"+profileName, func() (Fresh, error) {
		stored, err := GetCredentials(service, profileName)
		if err != nil {
			return Fresh{}, err
		}
		if stored == nil {
			return Fresh{}, clierr.NoCredentials(service, profileName)
		}
		spec := reg.RefreshOf(service)
		buffer := opt.Buffer
		if buffer == 0 {
			buffer = RefreshBuffer
		}
		now := opt.Now
		if now.IsZero() {
			now = time.Now()
		}
		wanted := spec != nil && spec.Applies != nil && spec.Applies(stored) &&
			(opt.Force || (spec.IsStale != nil && spec.IsStale(stored, now.UnixMilli(), buffer.Milliseconds())))
		if !wanted {
			return Fresh{Credentials: stored, Refreshed: false}, nil
		}
		fresh, err := spec.Run(ctx, stored)
		if err != nil {
			reason := plugins.FetchFailure(err).Error()
			return Fresh{}, clierr.New(clierr.TokenExpired,
				fmt.Sprintf("Token refresh failed for %s profile \"%s\": %s", service, profileName, reason),
				fmt.Sprintf("Re-authenticate with: agentio %s profile add --profile %s", service, profileName))
		}
		if err := SetCredentials(service, profileName, fresh); err != nil {
			return Fresh{}, err
		}
		cloned, err := GetCredentials(service, profileName)
		if err != nil {
			return Fresh{}, err
		}
		return Fresh{Credentials: cloned, Refreshed: true}, nil
	})
}

// ForRemote is the credential object the hub hands out: RedactForRemote, in
// the object's stored key order (vault.Ordered), as Bun sends it.
func ForRemote(reg *plugins.Registry, service string, credentials map[string]any) *jsvalue.Object {
	kept := RedactForRemote(reg, service, credentials)
	ordered := vault.Ordered(credentials)
	out := jsvalue.NewObject()
	for _, k := range ordered.Keys() {
		if _, ok := kept[k]; ok {
			v, _ := ordered.Get(k)
			out.Set(k, v)
		}
	}
	return out
}

// RedactForRemote strips refresh material. A service with no refresher is a
// transparent vault: the hub hands the whole object over. The returned map is
// a shallow copy so the caller's object is left intact.
func RedactForRemote(reg *plugins.Registry, service string, credentials map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range credentials {
		out[k] = v
	}
	spec := reg.RefreshOf(service)
	if spec == nil {
		return out
	}
	for _, field := range spec.SecretFields {
		delete(out, field)
	}
	return out
}
