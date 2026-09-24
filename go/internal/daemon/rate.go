package daemon

import (
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/plosson/agentio/go/internal/clierr"
)

const maxTracked = 1000

// Limiter is a fixed-window counter. Above maxTracked keys the oldest insert is dropped.
type Limiter struct {
	mu      sync.Mutex
	limit   int
	window  time.Duration
	message string
	hits    map[string]*hit
	order   []string
}

type hit struct {
	start time.Time
	count int
}

func NewLimiter(limit int, window time.Duration, message string) *Limiter {
	if message == "" {
		message = "Too many attempts, try again in a minute"
	}
	return &Limiter{limit: limit, window: window, message: message, hits: map[string]*hit{}}
}

func (l *Limiter) Allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	entry := l.hits[key]
	if entry == nil || now.Sub(entry.start) >= l.window {
		delete(l.hits, key)
		l.hits[key] = &hit{start: now, count: 1}
		l.order = append(removeKey(l.order, key), key)
		if len(l.hits) > maxTracked {
			oldest := l.order[0]
			l.order = l.order[1:]
			delete(l.hits, oldest)
		}
		return true
	}
	entry.count++
	return entry.count <= l.limit
}

func (l *Limiter) Check(key string, now time.Time) error {
	if !l.Allow(key, now) {
		return clierr.New(clierr.RateLimited, l.message, "")
	}
	return nil
}

func (l *Limiter) Reset() {
	l.mu.Lock()
	l.hits = map[string]*hit{}
	l.order = nil
	l.mu.Unlock()
}

func removeKey(order []string, key string) []string {
	out := make([]string, 0, len(order))
	for _, k := range order {
		if k != key {
			out = append(out, k)
		}
	}
	return out
}

// ClientIP uses the socket peer unless AGENTIO_TRUSTED_IP_HEADER names a header.
// The last comma-separated token is the one the nearest trusted proxy appended.
func ClientIP(r *http.Request) string {
	header := strings.ToLower(strings.TrimSpace(os.Getenv("AGENTIO_TRUSTED_IP_HEADER")))
	if header != "" {
		raw := r.Header.Get(header)
		if raw != "" {
			parts := strings.Split(raw, ",")
			for i := len(parts) - 1; i >= 0; i-- {
				last := strings.TrimSpace(parts[i])
				if last != "" {
					return last
				}
			}
		}
	}
	host := r.RemoteAddr
	if i := strings.LastIndex(host, ":"); i >= 0 {
		return host[:i]
	}
	return host
}
