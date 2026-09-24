package daemon

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
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
	"github.com/plosson/agentio/go/internal/plugin"
	"github.com/plosson/agentio/go/internal/profile"
	"github.com/plosson/agentio/go/internal/vault"
)

const (
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
	Registry *plugin.Registry
	Version  string
	Now      func() time.Time
}

func (s *Server) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Server) order() []string {
	if s.Registry == nil {
		return nil
	}
	var ids []string
	for _, p := range s.Registry.Plugins() {
		ids = append(ids, p.ID)
	}
	return ids
}

func (s *Server) Handler() http.Handler {
	start := s.now()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth.EnterHub()
		defer auth.LeaveHub()
		path := r.URL.Path
		if path == "/health" && r.Method == http.MethodGet {
			writeJSON(w, http.StatusOK, map[string]any{
				"status": "ok", "timestamp": s.now().UnixMilli(),
				"uptime": s.now().Sub(start).Milliseconds(), "locked": !vault.Unlocked(),
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
	path := r.URL.Path
	defer func() { recoverLog(w) }()
	if r.Method == http.MethodPost && (path == "/v1/device" || path == "/v1/device/token") {
		if err := deviceLimiter.Check(ip, s.now()); err != nil {
			writeErr(w, err)
			return
		}
		if path == "/v1/device" {
			var body struct {
				Name string `json:"name"`
			}
			if err := readJSON(r, &body); err != nil {
				writeErr(w, err)
				return
			}
			started, err := StartDevice(body.Name, s.now())
			if err != nil {
				writeErr(w, err)
				return
			}
			writeJSON(w, http.StatusCreated, started)
			return
		}
		var body struct {
			DeviceCode string `json:"deviceCode"`
		}
		if err := readJSON(r, &body); err != nil {
			writeErr(w, err)
			return
		}
		poll, err := PollDevice(body.DeviceCode, s.now())
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
	refs, err := profile.List("", s.order())
	if err != nil {
		writeErr(w, err)
		return
	}
	var rows []map[string]any
	for _, ref := range refs {
		if !profile.KeyAllows(*key, ref.Service, ref.Name) {
			continue
		}
		has, err := auth.HasCredentials(ref.Service, ref.Name)
		if err != nil {
			writeErr(w, err)
			return
		}
		rows = append(rows, map[string]any{
			"service": ref.Service, "name": ref.Name,
			"readOnly": profile.EffectiveReadOnly(*key, ref.ReadOnly), "hasCredentials": has,
		})
	}
	if rows == nil {
		rows = []map[string]any{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"profiles": rows, "canManageProfiles": key.CanManageProfiles})
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
		writeJSON(w, http.StatusOK, map[string]any{"status": "no_creds", "readOnly": readOnly})
		return
	}
	_, err = auth.GetFresh(rContext(), s.Registry, ref.Service, ref.Name, auth.RefreshOptions{Buffer: auth.HubRefreshBuffer})
	if ce, ok := err.(*clierr.Error); ok && ce.Code == clierr.TokenExpired {
		writeJSON(w, http.StatusOK, map[string]any{"status": "needs_reauth", "readOnly": readOnly})
		return
	}
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "readOnly": readOnly})
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
		log.Printf("v1 action=credentials key=%s (%s) profile=%s/%s outcome=%s", key.ID, key.Name, ref.Service, ref.Name, codeOf(err))
		writeErr(w, err)
		return
	}
	log.Printf("v1 action=credentials key=%s (%s) profile=%s/%s outcome=ok refreshed=%t", key.ID, key.Name, ref.Service, ref.Name, fresh.Refreshed)
	writeJSON(w, http.StatusOK, map[string]any{
		"service": ref.Service, "name": ref.Name, "readOnly": readOnly, "refreshed": fresh.Refreshed,
		"credentials": auth.RedactForRemote(s.Registry, ref.Service, fresh.Credentials),
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
	var body map[string]any
	if err := readJSON(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	opt := profile.SaveOptions{}
	if raw, ok := body["readOnly"]; ok {
		b, err := profile.ValidateFlag("readOnly", raw)
		if err != nil {
			writeErr(w, err)
			return
		}
		opt.ReadOnlySet = true
		opt.ReadOnly = b
	}
	creds, _ := body["credentials"].(map[string]any)
	if len(creds) == 0 {
		writeErr(w, clierr.New(clierr.InvalidParams, "credentials must be a non-empty object", ""))
		return
	}
	outcome, err := profile.SaveForKey(key.ID, ref.Service, ref.Name, creds, opt)
	if err != nil {
		writeErr(w, err)
		return
	}
	if failure := profile.WriteFailure(outcome, ref.Service, ref.Name, ""); failure != nil {
		writeErr(w, failure)
		return
	}
	ro, _ := profile.IsReadOnly(ref.Service, ref.Name)
	writeJSON(w, http.StatusCreated, map[string]any{"service": ref.Service, "name": ref.Name, "readOnly": ro})
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
	outcome, err := profile.RenameForKey(key.ID, ref.Service, ref.Name, to)
	if err != nil {
		writeErr(w, err)
		return
	}
	if failure := profile.WriteFailure(outcome, ref.Service, ref.Name, to); failure != nil {
		writeErr(w, failure)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"service": ref.Service, "name": to})
}

func (s *Server) deleteProfile(w http.ResponseWriter, key *profile.KeyView, ref profRef) {
	if err := requireManage(key); err != nil {
		writeErr(w, err)
		return
	}
	outcome, err := profile.DeleteForKey(key.ID, ref.Service, ref.Name)
	if err != nil {
		writeErr(w, err)
		return
	}
	if failure := profile.WriteFailure(outcome, ref.Service, ref.Name, ""); failure != nil {
		writeErr(w, failure)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func rContext() context.Context { return context.Background() }

func codeOf(err error) string {
	if ce, ok := err.(*clierr.Error); ok {
		return strings.ToLower(string(ce.Code))
	}
	return "error"
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

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	_ = enc.Encode(body)
}

func writeErr(w http.ResponseWriter, err error) {
	if ce, ok := err.(*clierr.Error); ok {
		body := map[string]any{"error": ce.Message, "code": ce.Code}
		if ce.Suggestion != "" {
			body["suggestion"] = ce.Suggestion
		}
		writeJSON(w, clierr.HTTPStatus(ce.Code), body)
		return
	}
	msg := "Unexpected error"
	if err != nil {
		msg = err.Error()
	}
	writeJSON(w, http.StatusInternalServerError, map[string]any{"error": msg, "code": "API_ERROR"})
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
	path := r.URL.Path
	if r.Method == http.MethodGet && (path == "/ui" || path == "/ui/") {
		s.page(w)
		return
	}
	if r.Method == http.MethodGet && path == "/ui/api/session" {
		writeJSON(w, http.StatusOK, map[string]any{"authenticated": HasSession(r, s.now()), "locked": !vault.Unlocked()})
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
		refs, err := profile.List("", s.order())
		if err != nil {
			writeErr(w, err)
			return
		}
		rows := []map[string]any{}
		for _, ref := range refs {
			rows = append(rows, map[string]any{"service": ref.Service, "name": ref.Name, "readOnly": ref.ReadOnly})
		}
		writeJSON(w, http.StatusOK, map[string]any{"profiles": rows})
	case r.Method == http.MethodGet && path == "/ui/api/status":
		test := r.URL.Query().Get("test") != "false"
		rows, err := host.Statuses(r.Context(), s.Registry, s.order(), test)
		if err != nil {
			writeErr(w, err)
			return
		}
		services := map[string][]host.ProfileStatus{}
		for _, row := range rows {
			services[row.Service] = append(services[row.Service], row)
		}
		writeJSON(w, http.StatusOK, map[string]any{"version": s.Version, "services": services})
	case r.Method == http.MethodGet && path == "/ui/api/keys":
		keys, err := profile.ListKeys()
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"keys": keys})
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
				writeJSON(w, http.StatusOK, row)
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

func (s *Server) page(w http.ResponseWriter) {
	nonce := make([]byte, 16)
	_, _ = rand.Read(nonce)
	n := base64.StdEncoding.EncodeToString(nonce)
	meta := map[string]any{}
	if s.Registry != nil {
		for _, p := range s.Registry.Plugins() {
			color := ""
			if p.Brand != nil && regexp.MustCompile(`^#[0-9a-fA-F]{6}$`).MatchString(p.Brand.Color) {
				color = p.Brand.Color
			}
			meta[p.ID] = map[string]any{"displayName": p.DisplayName, "color": color}
		}
	}
	raw, _ := json.Marshal(meta)
	escaped := strings.NewReplacer("<", `\u003c`, ">", `\u003e`, "&", `\u0026`).Replace(string(raw))
	html := strings.ReplaceAll(uiPage, "__CSP_NONCE__", n)
	html = strings.ReplaceAll(html, "__PLUGIN_METADATA__", escaped)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	for k, v := range securityHeaders(n) {
		w.Header().Set(k, v)
	}
	_, _ = io.WriteString(w, html)
}

func (s *Server) unlock(w http.ResponseWriter, r *http.Request) {
	if err := unlockLimiter.Check(ClientIP(r), s.now()); err != nil {
		writeErr(w, err)
		return
	}
	var body struct {
		Passphrase string `json:"passphrase"`
	}
	if err := readJSON(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	if body.Passphrase == "" {
		writeErr(w, clierr.New(clierr.InvalidParams, "passphrase is required", ""))
		return
	}
	if err := vault.Unlock(body.Passphrase); err != nil {
		writeErr(w, err)
		return
	}
	KeepaliveFromEnv(context.Background(), s.Registry, s.order())
	w.Header().Add("Set-Cookie", SessionCookie(CreateSession(s.now()), SecureRequest(r)))
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
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
	var body struct {
		Approve           bool   `json:"approve"`
		Name              string `json:"name"`
		URL               string `json:"url"`
		AllowedProfiles   any    `json:"allowedProfiles"`
		ReadOnly          any    `json:"readOnly"`
		CanManageProfiles any    `json:"canManageProfiles"`
	}
	if err := readJSON(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	if !body.Approve {
		if err := DenyDevice(code, s.now()); err != nil {
			writeErr(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	key, err := ApproveDevice(code, profile.KeyInput{
		Name: body.Name, AllowedProfiles: normalizeScope(body.AllowedProfiles),
		ReadOnly: body.ReadOnly, CanManageProfiles: body.CanManageProfiles,
	}, body.URL, s.now())
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"key": key})
}

func normalizeScope(v any) any {
	switch t := v.(type) {
	case string:
		return t
	case []any:
		var out []string
		for _, item := range t {
			if s, ok := item.(string); ok {
				out = append(out, s)
			}
		}
		return out
	default:
		return v
	}
}

func (s *Server) createKey(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name              string `json:"name"`
		URL               string `json:"url"`
		AllowedProfiles   any    `json:"allowedProfiles"`
		ReadOnly          any    `json:"readOnly"`
		CanManageProfiles any    `json:"canManageProfiles"`
	}
	if err := readJSON(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	issued, err := profile.CreateKey(profile.KeyInput{
		Name: body.Name, AllowedProfiles: normalizeScope(body.AllowedProfiles),
		ReadOnly: body.ReadOnly, CanManageProfiles: body.CanManageProfiles,
	}, body.URL)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, issued)
}

func (s *Server) rotateKey(w http.ResponseWriter, r *http.Request, id string) {
	var body struct {
		URL string `json:"url"`
	}
	if err := readJSON(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	issued, err := profile.RotateKey(id, body.URL)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, issued)
}

func (s *Server) updateKey(w http.ResponseWriter, r *http.Request, id string) {
	var body struct {
		Name              any `json:"name"`
		AllowedProfiles   any `json:"allowedProfiles"`
		ReadOnly          any `json:"readOnly"`
		CanManageProfiles any `json:"canManageProfiles"`
	}
	if err := readJSON(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	// Distinguish omitted fields from present nulls. Re-read as a map.
	raw := map[string]any{}
	// body already consumed. The struct lost omitted info: zero values.
	// Callers of PATCH send the fields they change. Zero name means omitted
	// only when the JSON lacked the key. We already decoded into struct, so
	// a missing name is "". Treat empty name as omitted.
	patch := profile.KeyInput{}
	if body.Name != nil {
		if s, ok := body.Name.(string); ok && s != "" {
			patch.Name = s
		}
	}
	if body.AllowedProfiles != nil {
		patch.AllowedProfiles = normalizeScope(body.AllowedProfiles)
	}
	if body.ReadOnly != nil {
		patch.ReadOnly = body.ReadOnly
	}
	if body.CanManageProfiles != nil {
		patch.CanManageProfiles = body.CanManageProfiles
	}
	_ = raw
	updated, err := profile.UpdateKey(id, patch)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

func (s *Server) patchProfile(w http.ResponseWriter, r *http.Request, ref profRef) {
	var body struct {
		ReadOnly any `json:"readOnly"`
		Name     any `json:"name"`
	}
	if err := readJSON(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	if body.Name != nil {
		to, ok := body.Name.(string)
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
		writeJSON(w, http.StatusOK, map[string]any{"service": ref.Service, "name": to})
		return
	}
	readOnly, err := profile.ValidateFlag("readOnly", body.ReadOnly)
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
	writeJSON(w, http.StatusOK, map[string]any{"service": ref.Service, "name": ref.Name, "readOnly": readOnly})
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
