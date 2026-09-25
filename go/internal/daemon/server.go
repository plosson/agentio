package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/plosson/agentio/go/internal/auth"
	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/host"
	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/profile"
	"github.com/plosson/agentio/go/internal/vault"
)

// Bun's fixed bind: the daemon runs in a container, so the port is mapped
// there. Tests move both off it; nothing else changes them.
var (
	Host = "0.0.0.0"
	Port = 7890
)

var (
	v1AuthLimiter = NewLimiter(5, time.Minute, "")
	v1KeyLimiter  = NewLimiter(120, time.Minute, "More than 120 requests a minute for this key, try again in a minute")
	deviceLimiter = NewLimiter(40, time.Minute, "Too many login requests from this address, slow down")
	unlockLimiter = NewLimiter(5, time.Minute, "")
)

func ResetLimiters() {
	v1AuthLimiter.Reset()
	v1KeyLimiter.Reset()
	deviceLimiter.Reset()
	unlockLimiter.Reset()
}

// Server is the local hub: health, the credential API, and the admin UI.
type Server struct {
	Registry *plugins.Registry
	Version  string
	Now      func() time.Time
}

func (s *Server) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Server) Handler() http.Handler {
	start := s.now()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth.EnterHub()
		defer auth.LeaveHub()
		// Routes match the path as sent, as Bun's URL pathname does; each
		// segment is decoded once, where it is parsed.
		path := r.URL.EscapedPath()
		if path == "/health" && r.Method == http.MethodGet {
			now := s.now()
			writeJSON(w, http.StatusOK, object{
				{"status", "ok"}, {"timestamp", now.UnixMilli()},
				{"uptime", now.Sub(start).Milliseconds()}, {"locked", !vault.Unlocked()},
			})
			return
		}
		if path == "/" && r.Method == http.MethodGet {
			w.Header().Set("Location", "/ui")
			w.WriteHeader(http.StatusFound)
			return
		}
		if strings.HasPrefix(path, "/v1/") {
			s.handleV1(w, r)
			return
		}
		if strings.HasPrefix(path, "/ui") {
			s.handleUI(w, r)
			return
		}
		writeErr(w, clierr.New(clierr.NotFound, "Not found", ""))
	})
}

func (s *Server) handleV1(w http.ResponseWriter, r *http.Request) {
	ip := ClientIP(r)
	path := r.URL.EscapedPath()
	defer func() { recoverLog(w) }()
	if r.Method == http.MethodPost && (path == "/v1/device" || path == "/v1/device/token") {
		if err := deviceLimiter.Check(ip, s.now()); err != nil {
			writeErr(w, err)
			return
		}
		// A field that is not a string fails like an empty one, as in Bun.
		body, err := readObject(r)
		if err != nil {
			writeErr(w, err)
			return
		}
		if path == "/v1/device" {
			name, _ := body["name"].(string)
			started, err := StartDevice(name, s.now())
			if err != nil {
				writeErr(w, err)
				return
			}
			writeJSON(w, http.StatusCreated, started)
			return
		}
		deviceCode, _ := body["deviceCode"].(string)
		poll, err := PollDevice(deviceCode, s.now())
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, poll)
		return
	}
	if !vault.Unlocked() {
		writeErr(w, clierr.New(clierr.VaultLocked, "Vault is locked on the hub", ""))
		return
	}
	key, err := s.authenticate(r, ip)
	if err != nil {
		writeErr(w, err)
		return
	}
	if err := v1KeyLimiter.Check(key.ID, s.now()); err != nil {
		writeErr(w, err)
		return
	}
	_ = profile.TouchKey(*key, s.now())

	if r.Method == http.MethodGet && path == "/v1/profiles" {
		s.listProfiles(w, key)
		return
	}
	ref, ok := profilePath(path, "/v1/profiles")
	if !ok {
		writeErr(w, clierr.New(clierr.NotFound, "Not found", ""))
		return
	}
	switch {
	case ref.Action == "" && r.Method == http.MethodGet:
		s.profileStatus(w, key, ref)
	case ref.Action == "credentials" && r.Method == http.MethodPost:
		s.credentials(w, key, ref)
	case ref.Action == "" && r.Method == http.MethodPut:
		s.saveProfile(w, r, key, ref)
	case ref.Action == "" && r.Method == http.MethodPatch:
		s.renameProfile(w, r, key, ref)
	case ref.Action == "" && r.Method == http.MethodDelete:
		s.deleteProfile(w, key, ref)
	default:
		writeErr(w, clierr.New(clierr.NotFound, "Not found", ""))
	}
}

func (s *Server) authenticate(r *http.Request, ip string) (*profile.KeyView, error) {
	header := r.Header.Get("Authorization")
	token := ""
	if strings.HasPrefix(header, "Bearer ") {
		token = strings.TrimSpace(header[len("Bearer "):])
	}
	var key *profile.KeyView
	var err error
	if token != "" {
		key, err = profile.Authenticate(token)
		if err != nil {
			return nil, err
		}
	}
	if key == nil {
		if err := v1AuthLimiter.Check(ip, s.now()); err != nil {
			return nil, err
		}
		return nil, clierr.New(clierr.AuthFailed, "Invalid or missing token", "Set AGENTIO_TOKEN to a token from the hub")
	}
	return key, nil
}

type profRef struct {
	Service string
	Name    string
	Action  string
}

var serviceID = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)

func profilePath(pathname, prefix string) (profRef, bool) {
	if !strings.HasPrefix(pathname, prefix+"/") {
		return profRef{}, false
	}
	parts := strings.Split(strings.TrimPrefix(pathname, prefix+"/"), "/")
	if len(parts) < 2 || len(parts) > 3 {
		return profRef{}, false
	}
	for _, p := range parts {
		if p == "" {
			return profRef{}, false
		}
	}
	service, err := url.PathUnescape(parts[0])
	if err != nil || !serviceID.MatchString(service) {
		return profRef{}, false
	}
	name, err := url.PathUnescape(parts[1])
	if err != nil {
		return profRef{}, false
	}
	action := ""
	if len(parts) == 3 {
		action = parts[2]
	}
	return profRef{Service: service, Name: name, Action: action}, true
}

func (s *Server) allowed(key *profile.KeyView, service, name string) (bool, error) {
	profileName, readOnly, code, _, err := profile.Resolve(service, name)
	if err != nil {
		return false, err
	}
	if code != "" || profileName == "" {
		return false, clierr.ProfileNotFoundError(service, name)
	}
	if !profile.KeyAllows(*key, service, name) {
		return false, clierr.New(clierr.PermissionDenied, "This token is not allowed to use "+service+"/"+name, "")
	}
	return profile.EffectiveReadOnly(*key, readOnly), nil
}

func (s *Server) listProfiles(w http.ResponseWriter, key *profile.KeyView) {
	refs, err := profile.List("")
	if err != nil {
		writeErr(w, err)
		return
	}
	rows := []object{}
	for _, ref := range refs {
		if !profile.KeyAllows(*key, ref.Service, ref.Name) {
			continue
		}
		has, err := auth.HasCredentials(ref.Service, ref.Name)
		if err != nil {
			writeErr(w, err)
			return
		}
		rows = append(rows, object{
			{"service", ref.Service}, {"name", ref.Name},
			{"readOnly", profile.EffectiveReadOnly(*key, ref.ReadOnly)}, {"hasCredentials", has},
		})
	}
	writeJSON(w, http.StatusOK, object{{"profiles", rows}, {"canManageProfiles", key.CanManageProfiles}})
}

func (s *Server) profileStatus(w http.ResponseWriter, key *profile.KeyView, ref profRef) {
	readOnly, err := s.allowed(key, ref.Service, ref.Name)
	if err != nil {
		writeErr(w, err)
		return
	}
	has, err := auth.HasCredentials(ref.Service, ref.Name)
	if err != nil {
		writeErr(w, err)
		return
	}
	if !has {
		writeJSON(w, http.StatusOK, object{{"status", "no_creds"}, {"readOnly", readOnly}})
		return
	}
	_, err = auth.GetFresh(rContext(), s.Registry, ref.Service, ref.Name, auth.RefreshOptions{Buffer: auth.HubRefreshBuffer})
	if ce, ok := err.(*clierr.Error); ok && ce.Code == clierr.TokenExpired {
		writeJSON(w, http.StatusOK, object{{"status", "needs_reauth"}, {"readOnly", readOnly}})
		return
	}
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, object{{"status", "ok"}, {"readOnly", readOnly}})
}

func (s *Server) credentials(w http.ResponseWriter, key *profile.KeyView, ref profRef) {
	readOnly, err := s.allowed(key, ref.Service, ref.Name)
	if err != nil {
		writeErr(w, err)
		return
	}
	has, err := auth.HasCredentials(ref.Service, ref.Name)
	if err != nil {
		writeErr(w, err)
		return
	}
	if !has {
		writeErr(w, clierr.New(clierr.NotFound, "No credentials stored for "+ref.Service+"/"+ref.Name, "Add them on the hub host"))
		return
	}
	p := s.Registry.Find(ref.Service)
	if p == nil || p.Profile == nil {
		writeErr(w, clierr.New(clierr.NotFound,
			`Plugin "`+ref.Service+`" is not installed on this hub`,
			"Install a compatible plugin on the hub before requesting its credentials"))
		return
	}
	fresh, err := auth.GetFresh(rContext(), s.Registry, ref.Service, ref.Name, auth.RefreshOptions{Buffer: auth.HubRefreshBuffer})
	if err != nil {
		audit(key, "credentials", ref, err, nil)
		writeErr(w, err)
		return
	}
	audit(key, "credentials", ref, nil, fresh.Refreshed)
	writeJSON(w, http.StatusOK, object{
		{"service", ref.Service}, {"name", ref.Name}, {"readOnly", readOnly}, {"refreshed", fresh.Refreshed},
		{"credentials", auth.RedactForRemote(s.Registry, ref.Service, fresh.Credentials)},
	})
}

func requireManage(key *profile.KeyView) error {
	if !key.CanManageProfiles {
		return clierr.CannotManage("")
	}
	return nil
}

func (s *Server) saveProfile(w http.ResponseWriter, r *http.Request, key *profile.KeyView, ref profRef) {
	if err := requireManage(key); err != nil {
		writeErr(w, err)
		return
	}
	var raw json.RawMessage
	if err := readJSON(r, &raw); err != nil {
		writeErr(w, err)
		return
	}
	// Parsed as JSON.parse does, so the credential object is stored in the
	// order the client built it.
	parsed, _ := jsvalue.Parse(raw)
	body, _ := parsed.(*jsvalue.Object)
	opt := profile.SaveOptions{}
	if raw, ok := body.Get("readOnly"); ok {
		b, err := profile.ValidateFlag("readOnly", raw)
		if err != nil {
			writeErr(w, err)
			return
		}
		opt.ReadOnlySet = true
		opt.ReadOnly = b
	}
	creds, _ := body.Value("credentials").(*jsvalue.Object)
	if creds.Len() == 0 {
		writeErr(w, clierr.New(clierr.InvalidParams, "credentials must be a non-empty object", ""))
		return
	}
	if err := applyWrite(key, "save", ref, "", func() (profile.WriteOutcome, error) {
		return profile.SaveForKey(key.ID, ref.Service, ref.Name, creds, opt)
	}); err != nil {
		writeErr(w, err)
		return
	}
	ro, _ := profile.IsReadOnly(ref.Service, ref.Name)
	writeJSON(w, http.StatusCreated, object{{"service", ref.Service}, {"name", ref.Name}, {"readOnly", ro}})
}

func (s *Server) renameProfile(w http.ResponseWriter, r *http.Request, key *profile.KeyView, ref profRef) {
	if err := requireManage(key); err != nil {
		writeErr(w, err)
		return
	}
	var body struct {
		Name any `json:"name"`
	}
	if err := readJSON(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	to, ok := body.Name.(string)
	if !ok {
		writeErr(w, clierr.New(clierr.InvalidParams, "name must be a string", ""))
		return
	}
	if err := applyWrite(key, "rename", ref, to, func() (profile.WriteOutcome, error) {
		return profile.RenameForKey(key.ID, ref.Service, ref.Name, to)
	}); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, object{{"service", ref.Service}, {"name", to}})
}

func (s *Server) deleteProfile(w http.ResponseWriter, key *profile.KeyView, ref profRef) {
	if err := requireManage(key); err != nil {
		writeErr(w, err)
		return
	}
	if err := applyWrite(key, "delete", ref, "", func() (profile.WriteOutcome, error) {
		return profile.DeleteForKey(key.ID, ref.Service, ref.Name)
	}); err != nil {
		writeErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func rContext() context.Context { return context.Background() }

// audit is Bun's audited span closing: one v1 line with the outcome, ok or the
// lowercase code of a CLI error. Any other failure is not logged, as in Bun;
// refreshed rides along only when given.
func audit(key *profile.KeyView, action string, ref profRef, err error, refreshed any) {
	outcome := "ok"
	if err != nil {
		ce, ok := err.(*clierr.Error)
		if !ok {
			return
		}
		outcome = strings.ToLower(string(ce.Code))
	}
	daemonLog("v1", field{"action", action}, field{"key", key.ID + " (" + key.Name + ")"},
		field{"profile", ref.Service + "/" + ref.Name}, field{"outcome", outcome}, field{"refreshed", refreshed})
}

// applyWrite is Bun's applyWrite: a keyed profile write whose outcome other
// than success becomes the shared error, audited either way.
func applyWrite(key *profile.KeyView, action string, ref profRef, to string, write func() (profile.WriteOutcome, error)) error {
	outcome, err := write()
	if err == nil {
		if failure := profile.WriteFailure(outcome, ref.Service, ref.Name, to); failure != nil {
			err = failure
		}
	}
	audit(key, action, ref, err, nil)
	return err
}

func readJSON(r *http.Request, dest any) error {
	b, err := io.ReadAll(r.Body)
	if err != nil {
		return clierr.New(clierr.InvalidParams, "Body must be JSON", "")
	}
	if len(strings.TrimSpace(string(b))) == 0 {
		return clierr.New(clierr.InvalidParams, "Body must be JSON", "")
	}
	if err := json.Unmarshal(b, dest); err != nil {
		return clierr.New(clierr.InvalidParams, "Body must be JSON", "")
	}
	return nil
}

// readObject reads a JSON body the way the Bun routes use it: a bad body is
// INVALID_PARAMS, and a body that is not an object reads every field as absent.
func readObject(r *http.Request) (map[string]any, error) {
	var body any
	if err := readJSON(r, &body); err != nil {
		return nil, err
	}
	if m, ok := body.(map[string]any); ok {
		return m, nil
	}
	return map[string]any{}, nil
}

// jsString is JavaScript's String(v) for what a JSON body can hold, so a hub URL
// that is not a string fails validation with Bun's message instead of the body's.
func jsString(v any, present bool) string {
	switch t := v.(type) {
	case string:
		return t
	case nil:
		if present {
			return "null"
		}
		return "undefined"
	case bool, float64:
		return fmt.Sprint(t)
	case []any:
		parts := make([]string, len(t))
		for i, item := range t {
			if item != nil {
				parts[i] = jsString(item, true)
			}
		}
		return strings.Join(parts, ",")
	default:
		return "[object Object]"
	}
}

func hubURL(body map[string]any) string {
	v, ok := body["url"]
	return jsString(v, ok)
}

// keyInput passes the key fields through untouched; profile validates them.
func keyInput(body map[string]any) profile.KeyInput {
	return profile.KeyInput{
		Name: body["name"], AllowedProfiles: normalizeScope(body["allowedProfiles"]),
		ReadOnly: body["readOnly"], CanManageProfiles: body["canManageProfiles"],
	}
}

// presentNull stands for a field sent as null: a patch validates it, where an
// absent field is left alone. It is never a valid name, scope or flag.
type presentNull struct{}

func patchField(body map[string]any, key string) any {
	v, ok := body[key]
	if ok && v == nil {
		return presentNull{}
	}
	return v
}

// object is a JSON object that keeps its field order, as a JavaScript one does.
type object []field

type field struct {
	key   string
	value any
}

func (o object) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, f := range o {
		if i > 0 {
			buf.WriteByte(',')
		}
		buf.Write(marshalJS(f.key))
		buf.WriteByte(':')
		buf.Write(marshalJS(f.value))
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(marshalJS(body))
}

func writeErr(w http.ResponseWriter, err error) {
	if ce, ok := err.(*clierr.Error); ok {
		body := object{{"error", ce.Message}, {"code", ce.Code}}
		if ce.Suggestion != "" {
			body = append(body, field{"suggestion", ce.Suggestion})
		}
		writeJSON(w, clierr.HTTPStatus(ce.Code), body)
		return
	}
	msg := "Unexpected error"
	if err != nil {
		msg = err.Error()
	}
	writeJSON(w, http.StatusInternalServerError, object{{"error", msg}, {"code", "API_ERROR"}})
}

func recoverLog(w http.ResponseWriter) {
	if rec := recover(); rec != nil {
		log.Printf("daemon panic: %v", rec)
		writeErr(w, clierr.New(clierr.APIError, "Unexpected error", ""))
	}
}

func securityHeaders(nonce string) map[string]string {
	return map[string]string{
		"Content-Security-Policy":   "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'nonce-" + nonce + "'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
		"X-Frame-Options":           "DENY",
		"X-Content-Type-Options":    "nosniff",
		"Referrer-Policy":           "no-referrer",
		"Strict-Transport-Security": "max-age=31536000; includeSubDomains",
	}
}

func (s *Server) handleUI(w http.ResponseWriter, r *http.Request) {
	path := r.URL.EscapedPath()
	if r.Method == http.MethodGet && (path == "/ui" || path == "/ui/") {
		s.page(w)
		return
	}
	if r.Method == http.MethodGet && path == "/ui/api/session" {
		writeJSON(w, http.StatusOK, object{{"authenticated", HasSession(r, s.now())}, {"locked", !vault.Unlocked()}})
		return
	}
	if r.Method == http.MethodPost && path == "/ui/api/unlock" {
		s.unlock(w, r)
		return
	}
	if !HasSession(r, s.now()) {
		writeErr(w, clierr.New(clierr.AuthFailed, "Unauthorized", ""))
		return
	}
	if r.Method == http.MethodPost && path == "/ui/api/lock" {
		vault.Lock()
		StopKeepalive()
		ClearSessions()
		signedOut(w, r)
		return
	}
	if r.Method == http.MethodPost && path == "/ui/api/logout" {
		DeleteSession(r)
		signedOut(w, r)
		return
	}
	if !vault.Unlocked() {
		writeErr(w, clierr.New(clierr.VaultLocked, "Vault is locked", ""))
		return
	}
	switch {
	case r.Method == http.MethodGet && path == "/ui/api/profiles":
		refs, err := profile.List("")
		if err != nil {
			writeErr(w, err)
			return
		}
		rows := []object{}
		for _, ref := range refs {
			rows = append(rows, object{{"service", ref.Service}, {"name", ref.Name}, {"readOnly", ref.ReadOnly}})
		}
		writeJSON(w, http.StatusOK, object{{"profiles", rows}})
	case r.Method == http.MethodGet && path == "/ui/api/status":
		test := r.URL.Query().Get("test") != "false"
		rows, err := host.Statuses(r.Context(), s.Registry, test)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, object{{"version", s.Version}, {"services", host.ByService(rows)}})
	case r.Method == http.MethodGet && path == "/ui/api/keys":
		keys, err := profile.ListKeys()
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, object{{"keys", keys}})
	case r.Method == http.MethodPost && path == "/ui/api/keys":
		s.createKey(w, r)
	default:
		if code := authorizeCode(path); code != "" {
			if r.Method == http.MethodGet {
				view, err := DescribeDevice(code, s.now())
				if err != nil {
					writeErr(w, err)
					return
				}
				writeJSON(w, http.StatusOK, view)
				return
			}
			if r.Method == http.MethodPost {
				s.authorize(w, r, code)
				return
			}
		}
		if ref, ok := profilePath(path, "/ui/api/profiles"); ok {
			if ref.Action == "status" && r.Method == http.MethodGet {
				row, err := host.OneStatus(r.Context(), s.Registry, ref.Service, ref.Name, true)
				if err != nil {
					writeErr(w, err)
					return
				}
				writeJSON(w, http.StatusOK, row.Entry())
				return
			}
			if ref.Action != "" {
				writeErr(w, clierr.New(clierr.NotFound, "Not found", ""))
				return
			}
			if r.Method == http.MethodDelete {
				ok, err := profile.Delete(ref.Service, ref.Name)
				if err != nil {
					writeErr(w, err)
					return
				}
				if !ok {
					writeErr(w, clierr.ProfileNotFoundError(ref.Service, ref.Name))
					return
				}
				w.WriteHeader(http.StatusNoContent)
				return
			}
			if r.Method == http.MethodPatch {
				s.patchProfile(w, r, ref)
				return
			}
		}
		if id, rotate, ok := keyRef(path); ok {
			if rotate && r.Method == http.MethodPost {
				s.rotateKey(w, r, id)
				return
			}
			if !rotate && r.Method == http.MethodPatch {
				s.updateKey(w, r, id)
				return
			}
			if !rotate && r.Method == http.MethodDelete {
				if err := profile.RevokeKey(id); err != nil {
					writeErr(w, err)
					return
				}
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		writeErr(w, clierr.New(clierr.NotFound, "Not found", ""))
	}
}

// statusRow is one `agentio status --json` row without its service, which the
// UI routes carry in the key or the path instead.
func (s *Server) unlock(w http.ResponseWriter, r *http.Request) {
	if err := unlockLimiter.Check(ClientIP(r), s.now()); err != nil {
		writeErr(w, err)
		return
	}
	body, err := readObject(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	passphrase, _ := body["passphrase"].(string)
	if passphrase == "" {
		writeErr(w, clierr.New(clierr.InvalidParams, "passphrase is required", ""))
		return
	}
	if err := vault.Unlock(passphrase); err != nil {
		writeErr(w, err)
		return
	}
	KeepaliveFromEnv(context.Background(), s.Registry)
	w.Header().Add("Set-Cookie", SessionCookie(CreateSession(s.now()), SecureRequest(r)))
	writeJSON(w, http.StatusOK, object{{"ok", true}})
}

func signedOut(w http.ResponseWriter, r *http.Request) {
	w.Header().Add("Set-Cookie", ExpiredSessionCookie(SecureRequest(r)))
	w.WriteHeader(http.StatusNoContent)
}

func authorizeCode(pathname string) string {
	const prefix = "/ui/api/authorize/"
	if !strings.HasPrefix(pathname, prefix) {
		return ""
	}
	code := strings.TrimPrefix(pathname, prefix)
	if code == "" || strings.Contains(code, "/") {
		return ""
	}
	decoded, err := url.PathUnescape(code)
	if err != nil {
		return ""
	}
	return decoded
}

func (s *Server) authorize(w http.ResponseWriter, r *http.Request, code string) {
	body, err := readObject(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	if body["approve"] != true {
		if err := DenyDevice(code, s.now()); err != nil {
			writeErr(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	key, err := ApproveDevice(code, keyInput(body), hubURL(body), s.now())
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, object{{"key", key}})
}

func normalizeScope(v any) any {
	switch t := v.(type) {
	case string:
		return t
	case []any:
		out := make([]string, 0, len(t))
		for _, item := range t {
			s, ok := item.(string)
			if !ok {
				return t // not a list of strings: left for validation to reject
			}
			out = append(out, s)
		}
		return out
	default:
		return v
	}
}

func (s *Server) createKey(w http.ResponseWriter, r *http.Request) {
	body, err := readObject(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	issued, err := profile.CreateKey(keyInput(body), hubURL(body))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, issued)
}

func (s *Server) rotateKey(w http.ResponseWriter, r *http.Request, id string) {
	body, err := readObject(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	issued, err := profile.RotateKey(id, hubURL(body))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, issued)
}

func (s *Server) updateKey(w http.ResponseWriter, r *http.Request, id string) {
	body, err := readObject(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	updated, err := profile.UpdateKey(id, profile.KeyInput{
		Name:              patchField(body, "name"),
		AllowedProfiles:   normalizeScope(patchField(body, "allowedProfiles")),
		ReadOnly:          patchField(body, "readOnly"),
		CanManageProfiles: patchField(body, "canManageProfiles"),
	})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

func (s *Server) patchProfile(w http.ResponseWriter, r *http.Request, ref profRef) {
	body, err := readObject(r)
	if err != nil {
		writeErr(w, err)
		return
	}
	if name, present := body["name"]; present {
		to, ok := name.(string)
		if !ok {
			writeErr(w, clierr.New(clierr.InvalidParams, "name must be a string", ""))
			return
		}
		outcome, err := profile.Rename(ref.Service, ref.Name, to)
		if err != nil {
			writeErr(w, err)
			return
		}
		if failure := profile.WriteFailure(outcome, ref.Service, ref.Name, to); failure != nil {
			writeErr(w, failure)
			return
		}
		writeJSON(w, http.StatusOK, object{{"service", ref.Service}, {"name", to}})
		return
	}
	readOnly, err := profile.ValidateFlag("readOnly", body["readOnly"])
	if err != nil {
		writeErr(w, err)
		return
	}
	ok, err := profile.SetReadOnly(ref.Service, ref.Name, readOnly)
	if err != nil {
		writeErr(w, err)
		return
	}
	if !ok {
		writeErr(w, clierr.ProfileNotFoundError(ref.Service, ref.Name))
		return
	}
	writeJSON(w, http.StatusOK, object{{"service", ref.Service}, {"name", ref.Name}, {"readOnly", readOnly}})
}

func keyRef(pathname string) (id string, rotate bool, ok bool) {
	const prefix = "/ui/api/keys/"
	if !strings.HasPrefix(pathname, prefix) {
		return "", false, false
	}
	rest := strings.TrimPrefix(pathname, prefix)
	parts := strings.Split(rest, "/")
	if len(parts) == 1 && parts[0] != "" {
		id, err := url.PathUnescape(parts[0])
		if err != nil {
			return "", false, false
		}
		return id, false, true
	}
	if len(parts) == 2 && parts[1] == "rotate" && parts[0] != "" {
		id, err := url.PathUnescape(parts[0])
		if err != nil {
			return "", false, false
		}
		return id, true, true
	}
	return "", false, false
}
