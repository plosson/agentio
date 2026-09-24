// Package profile mirrors Bun's profile domain boundary:
//
//	src/config/profile-store.ts    saveProfile, deleteProfile, renameProfile, chooseProfileName
//	src/config/config-manager.ts   listProfileRefs, listProfiles, resolveProfile, getProfile, ProfileRef
//	src/plugins/profile-host.ts    addProfileFromPlugin / persistSetupResult
//
// Services only return credentials (plugin.SetupResult). This package owns
// naming + persistence. Vault crypto stays in internal/vault.
package profile

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/plosson/agentio/go/internal/plugin"
	"github.com/plosson/agentio/go/internal/vault"
)

// SetProfileOptions mirrors Bun SetProfileOptions.
type SetProfileOptions struct {
	ReadOnly bool
}

// ProfileNameChoice mirrors Bun ProfileNameChoice (chooseProfileName input).
type ProfileNameChoice struct {
	Explicit string
	Derived  string
	ReadOnly bool
}

// ProfileRef mirrors Bun ProfileRef (service/name flattened).
type ProfileRef struct {
	Service  string
	Name     string
	ReadOnly bool
}

// WriteOutcome mirrors Bun WriteOutcome for rename paths.
type WriteOutcome string

const (
	WriteOK     WriteOutcome = "ok"
	WriteDenied WriteOutcome = "denied"
	WriteAbsent WriteOutcome = "absent"
	WriteTaken  WriteOutcome = "taken"
)

// SaveProfile mirrors Bun saveProfile(service, profileName, credentials, options).
// One atomic vault write of config.profiles[service][] + credentials[service][name].
func SaveProfile(s *vault.Store, serviceName, profileName string, credentials map[string]any, options SetProfileOptions) error {
	if err := validateProfileName(profileName); err != nil {
		return err
	}
	return s.PutProfile(serviceName, vault.ProfileEntry{Name: profileName, ReadOnly: options.ReadOnly}, credentials)
}

// ChooseProfileName mirrors Bun chooseProfileName(service, {explicit, derived, readOnly}).
func ChooseProfileName(s *vault.Store, serviceName string, choice ProfileNameChoice) string {
	if choice.Explicit != "" {
		return choice.Explicit
	}
	derived := choice.Derived
	if derived == "" {
		derived = "default"
	}
	if !HasProfile(s, serviceName, derived) {
		return derived
	}
	base := derived
	if choice.ReadOnly {
		base = derived + "-readonly"
		if !HasProfile(s, serviceName, base) {
			return base
		}
	}
	for suffix := 2; ; suffix++ {
		candidate := fmt.Sprintf("%s-%d", base, suffix)
		if !HasProfile(s, serviceName, candidate) {
			return candidate
		}
	}
}

// DeleteProfile mirrors Bun deleteProfile(service, profileName). False if absent.
func DeleteProfile(s *vault.Store, serviceName, profileName string) (bool, error) {
	return s.RemoveProfile(serviceName, profileName)
}

// RenameProfile mirrors Bun renameProfile(service, from, to).
func RenameProfile(s *vault.Store, serviceName, from, to string) (WriteOutcome, error) {
	if err := validateProfileName(to); err != nil {
		return WriteAbsent, err
	}
	outcome, err := s.RenameProfile(serviceName, from, to)
	if err != nil {
		return "", err
	}
	switch outcome {
	case "ok":
		return WriteOK, nil
	case "absent":
		return WriteAbsent, nil
	case "taken":
		return WriteTaken, nil
	default:
		return WriteOutcome(outcome), nil
	}
}

// GetProfile mirrors Bun getProfile — returns the entry or false if missing.
func GetProfile(s *vault.Store, serviceName, profileName string) (vault.ProfileEntry, bool) {
	for _, p := range s.ListProfiles(serviceName) {
		if p.Name == profileName {
			return p, true
		}
	}
	return vault.ProfileEntry{}, false
}

// HasProfile mirrors Bun hasProfile.
func HasProfile(s *vault.Store, serviceName, profileName string) bool {
	_, ok := GetProfile(s, serviceName, profileName)
	return ok
}

// ServiceProfiles is one row of Bun listProfiles().
type ServiceProfiles struct {
	Service  string
	Profiles []vault.ProfileEntry
}

// ListProfiles mirrors Bun listProfiles(service?).
func ListProfiles(s *vault.Store, serviceFilter string) []ServiceProfiles {
	var services []string
	if serviceFilter != "" {
		services = []string{serviceFilter}
	} else {
		services = s.ListServices()
		sort.Strings(services)
	}
	out := make([]ServiceProfiles, 0, len(services))
	for _, svc := range services {
		entries := s.ListProfiles(svc)
		if serviceFilter == "" && len(entries) == 0 {
			continue
		}
		out = append(out, ServiceProfiles{Service: svc, Profiles: entries})
	}
	return out
}

// ListProfileRefs mirrors Bun listProfileRefs().
func ListProfileRefs(s *vault.Store, serviceFilter string) []ProfileRef {
	var out []ProfileRef
	for _, group := range ListProfiles(s, serviceFilter) {
		for _, p := range group.Profiles {
			out = append(out, ProfileRef{Service: group.Service, Name: p.Name, ReadOnly: p.ReadOnly})
		}
	}
	return out
}

// ResolveProfileResult mirrors Bun ResolveProfileResult.
type ResolveProfileResult struct {
	Profile string
	Names   []string // when Error == "multiple"
	Error   string   // "", "none", or "multiple"
}

// ResolveProfile mirrors Bun resolveProfile(service, name?).
func ResolveProfile(s *vault.Store, serviceName, profileFlag string) ResolveProfileResult {
	profiles := s.ListProfiles(serviceName)
	if profileFlag != "" {
		for _, p := range profiles {
			if p.Name == profileFlag {
				return ResolveProfileResult{Profile: p.Name}
			}
		}
		return ResolveProfileResult{Error: "none"}
	}
	if len(profiles) == 0 {
		return ResolveProfileResult{Error: "none"}
	}
	if len(profiles) == 1 {
		return ResolveProfileResult{Profile: profiles[0].Name}
	}
	names := make([]string, len(profiles))
	for i, p := range profiles {
		names[i] = p.Name
	}
	return ResolveProfileResult{Error: "multiple", Names: names}
}

// RequireProfile turns ResolveProfile into a name or error (CLI helper).
func RequireProfile(s *vault.Store, serviceName, profileFlag string) (string, error) {
	r := ResolveProfile(s, serviceName, profileFlag)
	switch r.Error {
	case "":
		return r.Profile, nil
	case "none":
		if profileFlag != "" {
			return "", fmt.Errorf("profile %q not found for %s", profileFlag, serviceName)
		}
		return "", fmt.Errorf("no %s profiles; run: agentio profile add %s", serviceName, serviceName)
	case "multiple":
		return "", fmt.Errorf("multiple %s profiles; pass --profile (%s)", serviceName, strings.Join(r.Names, ", "))
	default:
		return "", fmt.Errorf("resolve profile: %s", r.Error)
	}
}

// GetCredentials mirrors Bun getCredentials(service, profile) from token-store.
func GetCredentials(s *vault.Store, serviceName, profileName string) (map[string]any, error) {
	return s.GetCredentials(serviceName, profileName)
}

// PersistSetupResult mirrors Bun persistSetupResult (profile-host.ts):
// chooseProfileName + saveProfile. Returns the chosen profile name.
func PersistSetupResult(s *vault.Store, serviceName string, result *plugin.SetupResult, opts plugin.SetupOptions) (string, error) {
	if result == nil {
		return "", fmt.Errorf("nil setup result")
	}
	name := ChooseProfileName(s, serviceName, ProfileNameChoice{
		Explicit: opts.Profile,
		Derived:  result.SuggestedProfileName,
		ReadOnly: opts.ReadOnly,
	})
	if err := SaveProfile(s, serviceName, name, result.Credentials, SetProfileOptions{ReadOnly: opts.ReadOnly}); err != nil {
		return "", err
	}
	return name, nil
}

// AddProfileFromPlugin mirrors Bun addProfileFromPlugin(plugin, options):
// plugin.Setup → host PersistSetupResult. Plugins never write the vault.
func AddProfileFromPlugin(ctx context.Context, s *vault.Store, pl plugin.ServicePlugin, opts plugin.SetupOptions) (name string, result *plugin.SetupResult, err error) {
	if pl == nil {
		return "", nil, fmt.Errorf("nil service plugin")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	result, err = pl.Setup(ctx, opts)
	if err != nil {
		return "", nil, err
	}
	name, err = PersistSetupResult(s, pl.ID(), result, opts)
	if err != nil {
		return "", result, err
	}
	return name, result, nil
}

func validateProfileName(name string) error {
	if strings.TrimSpace(name) == "" || strings.Contains(name, "/") {
		return fmt.Errorf("invalid profile name %q (cannot be empty or contain /)", name)
	}
	return nil
}
