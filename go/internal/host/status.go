package host

import (
	"context"
	"strings"

	"github.com/plosson/agentio/go/internal/auth"
	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
	"github.com/plosson/agentio/go/internal/profile"
)

// ProfileStatus is Bun's ProfileStatus. ReadOnly is the entry's readOnly as
// stored: nil when the entry has none.
type ProfileStatus struct {
	Service  string `json:"service"`
	Profile  string `json:"profile"`
	ReadOnly *bool  `json:"readOnly,omitempty"`
	Status   string `json:"status"`
	Info     string `json:"info,omitempty"`
	Error    string `json:"error,omitempty"`
}

// StatusEntry is a ProfileStatus without its service: a row of Bun's
// `services` object (`const { service, ...rest } = status`).
type StatusEntry struct {
	Profile  string `json:"profile"`
	ReadOnly *bool  `json:"readOnly,omitempty"`
	Status   string `json:"status"`
	Info     string `json:"info,omitempty"`
	Error    string `json:"error,omitempty"`
}

func (s ProfileStatus) Entry() StatusEntry {
	return StatusEntry{Profile: s.Profile, ReadOnly: s.ReadOnly, Status: s.Status, Info: s.Info, Error: s.Error}
}

// ByService is Bun's `services` object: the rows grouped by service, in the
// order each service first appears.
func ByService(rows []ProfileStatus) *jsvalue.Object {
	services := jsvalue.NewObject()
	for _, row := range rows {
		list, _ := services.Get(row.Service)
		entries, _ := list.([]StatusEntry)
		services.Set(row.Service, append(entries, row.Entry()))
	}
	return services
}

var sessionFailures = map[clierr.Code]bool{
	clierr.AuthFailed: true, clierr.NetworkError: true, clierr.ConfigError: true,
	clierr.RateLimited: true, clierr.VaultLocked: true, clierr.VaultNotConfigured: true,
	clierr.VaultCorrupt: true,
}

// Statuses checks every configured profile. A single expired credential stays
// in its row; a dead hub or a locked vault aborts the whole run.
func Statuses(ctx context.Context, reg *plugins.Registry, test bool) ([]ProfileStatus, error) {
	refs, err := profile.List("")
	if err != nil {
		return nil, err
	}
	var out []ProfileStatus
	for _, ref := range refs {
		row, err := Check(ctx, reg, ref, test)
		if err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, nil
}

func OneStatus(ctx context.Context, reg *plugins.Registry, service, name string, test bool) (ProfileStatus, error) {
	refs, err := profile.List(service)
	if err != nil {
		return ProfileStatus{}, err
	}
	for _, ref := range refs {
		if ref.Name == name {
			return Check(ctx, reg, ref, test)
		}
	}
	return ProfileStatus{}, clierr.ProfileNotFoundError(service, name)
}

// Check is Bun's checkProfile: one profile's row. Reading whether anything is
// stored, or a session failure, fails the whole run.
func Check(ctx context.Context, reg *plugins.Registry, ref profile.Ref, test bool) (ProfileStatus, error) {
	row := ProfileStatus{Service: ref.Service, Profile: ref.Name}
	if ref.ReadOnlyStated {
		readOnly := ref.ReadOnly
		row.ReadOnly = &readOnly
	}
	has, err := auth.HasCredentials(ref.Service, ref.Name)
	if err != nil {
		return ProfileStatus{}, err
	}
	if !has {
		row.Status = "no-creds"
		return row, nil
	}
	if !test {
		row.Status = "skipped"
		return row, nil
	}
	p := reg.Find(ref.Service)
	if p == nil || p.Profile == nil {
		row.Status = "invalid"
		row.Error = "plugin is not installed in this agentio build"
		return row, nil
	}
	fresh, err := auth.GetFresh(ctx, reg, ref.Service, ref.Name, auth.RefreshOptions{})
	if err != nil {
		if ce, ok := err.(*clierr.Error); ok && sessionFailures[ce.Code] {
			return ProfileStatus{}, err
		}
		row.Status = "invalid"
		row.Error = failureText(err)
		return row, nil
	}
	result, err := p.Profile.Validate(ctx, NewRunContext(fresh.Credentials, ref.Name, ctx))
	if err != nil {
		if ce, ok := err.(*clierr.Error); ok && sessionFailures[ce.Code] {
			return ProfileStatus{}, err
		}
		row.Status = "invalid"
		row.Error = failureText(err)
		return row, nil
	}
	if !result.Valid && !auth.IsRemote() && !strings.Contains(result.Error, "re-authenticate") {
		forced, ferr := auth.GetFresh(ctx, reg, ref.Service, ref.Name, auth.RefreshOptions{Force: true})
		if ferr != nil {
			if ce, ok := ferr.(*clierr.Error); ok && sessionFailures[ce.Code] {
				return ProfileStatus{}, ferr
			}
			row.Status = "invalid"
			row.Error = failureText(ferr)
			return row, nil
		}
		if forced.Refreshed {
			result, err = p.Profile.Validate(ctx, NewRunContext(forced.Credentials, ref.Name, ctx))
			if err != nil {
				row.Status = "invalid"
				row.Error = failureText(err)
				return row, nil
			}
		}
	}
	row.Status = "invalid"
	if result.Valid {
		row.Status = "ok"
	}
	row.Info = result.Info
	row.Error = result.Error
	return row, nil
}

func failureText(err error) string {
	if ce, ok := err.(*clierr.Error); ok {
		if ce.Code == clierr.TokenExpired {
			return "refresh token rejected, re-authenticate"
		}
		return ce.Message
	}
	if err == nil {
		return ""
	}
	return err.Error()
}
