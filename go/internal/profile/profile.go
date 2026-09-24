// Package profile is the shared profile registry for AgentIO.
// Services (e.g. Gmail) perform auth and return credentials; this package
// owns naming, persistence, list/get/remove — matching Bun's
// src/config/profile-store.ts + src/commands/profile.ts.
package profile

import (
	"fmt"
	"strings"

	"github.com/plosson/agentio/go/internal/vault"
)

// KnownServices are services the skeleton can register profiles for.
// Extend as more services land under internal/services/.
var KnownServices = []string{"gmail"}

// IsKnown reports whether service is registered in this binary.
func IsKnown(service string) bool {
	for _, s := range KnownServices {
		if s == service {
			return true
		}
	}
	return false
}

// SetupResult is what a service returns after authentication (Bun SetupResult).
type SetupResult struct {
	Credentials          map[string]any
	SuggestedProfileName string
	Info                 string
	ReadOnly             bool
}

// Save writes a profile entry and credentials via the vault (one atomic update).
func Save(s *vault.Store, service, name string, creds map[string]any, readOnly bool) error {
	if err := validateName(name); err != nil {
		return err
	}
	if !IsKnown(service) {
		return fmt.Errorf("unknown service: %q (known: %s)", service, strings.Join(KnownServices, ", "))
	}
	return s.PutProfile(service, vault.ProfileEntry{Name: name, ReadOnly: readOnly}, creds)
}

// ChooseName picks the profile name: explicit wins; else derived with collision suffixes
// (Bun chooseProfileName: derived, then derived-readonly, then -2, -3, …).
func ChooseName(s *vault.Store, service, explicit, derived string, readOnly bool) string {
	if explicit != "" {
		return explicit
	}
	if derived == "" {
		derived = "default"
	}
	if !has(s, service, derived) {
		return derived
	}
	base := derived
	if readOnly {
		base = derived + "-readonly"
		if !has(s, service, base) {
			return base
		}
	}
	for suffix := 2; ; suffix++ {
		candidate := fmt.Sprintf("%s-%d", base, suffix)
		if !has(s, service, candidate) {
			return candidate
		}
	}
}

// PersistSetup chooses a name and saves credentials (Bun addProfileFromPlugin / persistSetupResult).
func PersistSetup(s *vault.Store, service string, result SetupResult, explicitName string) (string, error) {
	name := ChooseName(s, service, explicitName, result.SuggestedProfileName, result.ReadOnly)
	if err := Save(s, service, name, result.Credentials, result.ReadOnly); err != nil {
		return "", err
	}
	return name, nil
}

// List returns profile entries for one service (empty slice if none).
func List(s *vault.Store, service string) []vault.ProfileEntry {
	return s.ListProfiles(service)
}

// ListAll returns profiles across known services as service/name pairs.
type Ref struct {
	Service  string
	Name     string
	ReadOnly bool
}

func ListAll(s *vault.Store, serviceFilter string) []Ref {
	var out []Ref
	services := KnownServices
	if serviceFilter != "" {
		services = []string{serviceFilter}
	}
	for _, svc := range services {
		for _, p := range s.ListProfiles(svc) {
			out = append(out, Ref{Service: svc, Name: p.Name, ReadOnly: p.ReadOnly})
		}
	}
	return out
}

// Remove deletes a profile and its credentials. Returns false if absent.
func Remove(s *vault.Store, service, name string) (bool, error) {
	return s.RemoveProfile(service, name)
}

// Resolve picks a profile name: explicit if present; sole profile if one; else error.
func Resolve(s *vault.Store, service, profileFlag string) (string, error) {
	profiles := s.ListProfiles(service)
	if profileFlag != "" {
		for _, p := range profiles {
			if p.Name == profileFlag {
				return p.Name, nil
			}
		}
		return "", fmt.Errorf("profile %q not found for %s", profileFlag, service)
	}
	if len(profiles) == 0 {
		return "", fmt.Errorf("no %s profiles; run: agentio profile add %s", service, service)
	}
	if len(profiles) != 1 {
		names := make([]string, len(profiles))
		for i, p := range profiles {
			names[i] = p.Name
		}
		return "", fmt.Errorf("multiple %s profiles; pass --profile (%s)", service, strings.Join(names, ", "))
	}
	return profiles[0].Name, nil
}

// Credentials loads credential map for a resolved profile.
func Credentials(s *vault.Store, service, name string) (map[string]any, error) {
	return s.GetCredentials(service, name)
}

func has(s *vault.Store, service, name string) bool {
	for _, p := range s.ListProfiles(service) {
		if p.Name == name {
			return true
		}
	}
	return false
}

func validateName(name string) error {
	if strings.TrimSpace(name) == "" || strings.Contains(name, "/") {
		return fmt.Errorf("invalid profile name %q (cannot be empty or contain /)", name)
	}
	return nil
}
