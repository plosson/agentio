package daemon

import (
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	sessionIdle = 30 * time.Minute
	cookieName  = "agentio_session"
)

var (
	sessionMu sync.Mutex
	sessions  = map[string]time.Time{}
)

func ResetSessions() {
	sessionMu.Lock()
	sessions = map[string]time.Time{}
	sessionMu.Unlock()
}

func CreateSession(now time.Time) string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	id := base64.RawURLEncoding.EncodeToString(b)
	sessionMu.Lock()
	sessions[id] = now
	sessionMu.Unlock()
	return id
}

func HasSession(r *http.Request, now time.Time) bool {
	id := sessionID(r)
	if id == "" {
		return false
	}
	sessionMu.Lock()
	defer sessionMu.Unlock()
	last, ok := sessions[id]
	if !ok {
		return false
	}
	if now.Sub(last) > sessionIdle {
		delete(sessions, id)
		return false
	}
	sessions[id] = now
	return true
}

func DeleteSession(r *http.Request) {
	id := sessionID(r)
	if id == "" {
		return
	}
	sessionMu.Lock()
	delete(sessions, id)
	sessionMu.Unlock()
}

func ClearSessions() {
	ResetSessions()
}

// SecureRequest is whether the Set-Cookie gets Secure: the request came over
// TLS, or the fronting proxy says it did with exactly "https", as Bun compares.
func SecureRequest(r *http.Request) bool {
	return strings.Join(r.Header.Values("X-Forwarded-Proto"), ", ") == "https" || r.TLS != nil
}

func SessionCookie(id string, secure bool) string {
	return cookieName + "=" + id + "; " + cookieAttrs(secure)
}

func ExpiredSessionCookie(secure bool) string {
	return cookieName + "=; " + cookieAttrs(secure) + "; Max-Age=0"
}

func cookieAttrs(secure bool) string {
	s := "HttpOnly; "
	if secure {
		s += "Secure; "
	}
	return s + "SameSite=Strict; Path=/"
}

func sessionID(r *http.Request) string {
	header := r.Header.Get("Cookie")
	if header == "" {
		return ""
	}
	for _, part := range strings.Split(header, ";") {
		part = strings.TrimSpace(part)
		name, value, ok := strings.Cut(part, "=")
		if ok && name == cookieName {
			return value
		}
	}
	return ""
}
