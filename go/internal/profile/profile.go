// Package profile owns how a profile enters, moves, and leaves the vault.
// Plugins never write this. Remote mode turns each call into one hub request.
package profile

import (
	"fmt"
	"sort"

	"github.com/plosson/agentio/go/internal/auth"
	"github.com/plosson/agentio/go/internal/clierr"
	"github.com/plosson/agentio/go/internal/vault"
)

type WriteOutcome string

const (
	WriteOK     WriteOutcome = "ok"
	WriteDenied WriteOutcome = "denied"
	WriteAbsent WriteOutcome = "absent"
	WriteTaken  WriteOutcome = "taken"
)

type Ref struct {
	Service  string
	Name     string
	ReadOnly bool
}

func RefOf(service, name string) string { return service + "/" + name }

func ValidateName(name string) error {
	if name == "" || name == " " || containsSlash(name) || trimEmpty(name) {
		return clierr.New(clierr.InvalidParams,
			fmt.Sprintf("Invalid profile name %q", name),
			`A name cannot be empty or contain "/"`)
	}
	return nil
}

func trimEmpty(name string) bool {
	for _, r := range name {
		if r != ' ' && r != '\t' && r != '\n' {
			return false
		}
	}
	return true
}

func containsSlash(name string) bool {
	for _, r := range name {
		if r == '/' {
			return true
		}
	}
	return false
}

func entries(service string) ([]vault.ProfileValue, error) {
	if auth.IsRemote() {
		all, err := auth.RemoteProfiles()
		if err != nil {
			return nil, err
		}
		var out []vault.ProfileValue
		for _, p := range all {
			if p.Service == service {
				out = append(out, vault.ProfileValue{Name: p.Name, ReadOnly: p.ReadOnly})
			}
		}
		if out == nil {
			out = []vault.ProfileValue{}
		}
		return out, nil
	}
	c, err := vault.Load()
	if err != nil {
		return nil, err
	}
	list := c.Config.Profiles[service]
	if list == nil {
		return []vault.ProfileValue{}, nil
	}
	return list, nil
}

// Resolve picks a profile. Explicit names must exist. One profile selects
// itself. Several require a name.
func Resolve(service, name string) (profile string, readOnly bool, errCode string, names []string, err error) {
	list, err := entries(service)
	if err != nil {
		return "", false, "", nil, err
	}
	if name != "" {
		for _, p := range list {
			if p.Name == name {
				return p.Name, p.ReadOnly, "", nil, nil
			}
		}
		return "", false, "none", nil, nil
	}
	if len(list) == 0 {
		return "", false, "none", nil, nil
	}
	if len(list) == 1 {
		return list[0].Name, list[0].ReadOnly, "", nil, nil
	}
	for _, p := range list {
		names = append(names, p.Name)
	}
	return "", false, "multiple", names, nil
}

func Require(service, name string) (string, error) {
	profile, _, code, names, err := Resolve(service, name)
	if err != nil {
		return "", err
	}
	if code == "" {
		return profile, nil
	}
	if code == "multiple" {
		return "", clierr.MultipleProfiles(service, names)
	}
	if name != "" {
		return "", clierr.New(clierr.ProfileNotFound,
			fmt.Sprintf("Profile %q not found for %s", name, service),
			fmt.Sprintf("Run: agentio %s profile add", service))
	}
	return "", clierr.New(clierr.ProfileNotFound,
		fmt.Sprintf("No %s profile configured", service),
		fmt.Sprintf("Run: agentio %s profile add", service))
}

func IsReadOnly(service, name string) (bool, error) {
	list, err := entries(service)
	if err != nil {
		return false, err
	}
	for _, p := range list {
		if p.Name == name {
			return p.ReadOnly, nil
		}
	}
	return false, nil
}

// ServiceOrder is Bun's ALL_SERVICES (src/types/config.ts), the order every
// Bun profile listing follows; configured ids not in it come after, sorted.
// It is not the plugin catalog: rss is absent, so its profiles sort last.
var ServiceOrder = []string{
	"gdocs", "gdrive", "gmail", "gcal", "gtasks", "gchat", "gsheets", "gslides", "gscript",
	"github", "jira", "confluence", "slack", "telegram", "discourse", "dropbox", "sql", "revolut", "falco",
}

// List returns profiles. preferred is the catalog order; unknown stored ids follow, sorted.
// A service filter returns that service even when it has no profiles.
func List(service string, preferred []string) ([]Ref, error) {
	if auth.IsRemote() {
		all, err := auth.RemoteProfiles()
		if err != nil {
			return nil, err
		}
		var out []Ref
		for _, p := range all {
			if service == "" || p.Service == service {
				out = append(out, Ref{Service: p.Service, Name: p.Name, ReadOnly: p.ReadOnly})
			}
		}
		return out, nil
	}
	c, err := vault.Load()
	if err != nil {
		return nil, err
	}
	var services []string
	if service != "" {
		services = []string{service}
	} else {
		seen := map[string]bool{}
		for _, id := range preferred {
			if _, ok := c.Config.Profiles[id]; ok {
				services = append(services, id)
				seen[id] = true
			}
		}
		var rest []string
		for id := range c.Config.Profiles {
			if !seen[id] {
				rest = append(rest, id)
			}
		}
		sort.Strings(rest)
		services = append(services, rest...)
	}
	var out []Ref
	for _, svc := range services {
		for _, p := range c.Config.Profiles[svc] {
			out = append(out, Ref{Service: svc, Name: p.Name, ReadOnly: p.ReadOnly})
		}
	}
	return out, nil
}

// ChooseName picks the stored name. An explicit name wins, even when taken.
// A free derived name is used as-is. A collision grows a numeric suffix, and
// a read-only collision first tries "<derived>-readonly".
func ChooseName(service string, explicit, derived string, readOnly bool) (string, error) {
	if explicit != "" {
		return explicit, nil
	}
	if derived == "" {
		derived = "default"
	}
	_, _, code, _, err := Resolve(service, derived)
	if err != nil {
		return "", err
	}
	if code == "none" {
		return derived, nil
	}
	base := derived
	if readOnly {
		base = derived + "-readonly"
		_, _, code, _, err = Resolve(service, base)
		if err != nil {
			return "", err
		}
		if code == "none" {
			return base, nil
		}
	}
	for suffix := 2; ; suffix++ {
		candidate := fmt.Sprintf("%s-%d", base, suffix)
		_, _, code, _, err = Resolve(service, candidate)
		if err != nil {
			return "", err
		}
		if code == "none" {
			return candidate, nil
		}
	}
}

type SaveOptions struct {
	// ReadOnlySet distinguishes "not stated" from an explicit false.
	ReadOnlySet bool
	ReadOnly    bool
}

func Save(service, name string, credentials map[string]any, opt SaveOptions) error {
	if auth.IsRemote() {
		var flag *bool
		if opt.ReadOnlySet {
			flag = &opt.ReadOnly
		}
		return auth.RemoteSaveProfile(service, name, credentials, flag)
	}
	return vault.Update(func(c *vault.Contents) error {
		index := findIndex(c.Config.Profiles[service], name)
		return put(c, service, name, credentials, kept(c, service, index, opt))
	})
}

func kept(c *vault.Contents, service string, index int, opt SaveOptions) SaveOptions {
	if index == -1 {
		return opt
	}
	if opt.ReadOnlySet {
		return opt
	}
	return SaveOptions{ReadOnlySet: true, ReadOnly: c.Config.Profiles[service][index].ReadOnly}
}

func put(c *vault.Contents, service, name string, credentials map[string]any, opt SaveOptions) error {
	if err := ValidateName(name); err != nil {
		return err
	}
	entry := vault.ProfileValue{Name: name}
	if opt.ReadOnly {
		entry.ReadOnly = true
	}
	list := c.Config.Profiles[service]
	index := findIndex(list, name)
	if index == -1 {
		c.Config.Profiles[service] = append(list, entry)
	} else {
		list[index] = entry
		c.Config.Profiles[service] = list
	}
	if c.Credentials[service] == nil {
		c.Credentials[service] = map[string]map[string]any{}
	}
	cloned, err := vault.CloneMap(credentials)
	if err != nil {
		return err
	}
	c.Credentials[service][name] = cloned
	return nil
}

func findIndex(list []vault.ProfileValue, name string) int {
	for i, p := range list {
		if p.Name == name {
			return i
		}
	}
	return -1
}

func Rename(service, from, to string) (WriteOutcome, error) {
	if err := ValidateName(to); err != nil && auth.IsRemote() {
		return "", err
	}
	if auth.IsRemote() {
		outcome, err := auth.RemoteRename(service, from, to)
		if err != nil {
			return "", err
		}
		return WriteOutcome(outcome), nil
	}
	var outcome WriteOutcome
	err := vault.Update(func(c *vault.Contents) error {
		outcome = move(c, service, from, to)
		return nil
	})
	return outcome, err
}

func move(c *vault.Contents, service, from, to string) WriteOutcome {
	if err := ValidateName(to); err != nil {
		// Surface as a hard error by panicking into the update? Callers validate first.
		// move is also used by the keyed path. Return taken is wrong. Store the error
		// by using a sentinel via a side channel. Validate before calling move.
		return WriteOutcome("invalid")
	}
	index := findIndex(c.Config.Profiles[service], from)
	if index == -1 {
		return WriteAbsent
	}
	if from != to && findIndex(c.Config.Profiles[service], to) != -1 {
		return WriteTaken
	}
	entry := c.Config.Profiles[service][index]
	entry.Name = to
	c.Config.Profiles[service][index] = entry
	if stored, ok := c.Credentials[service][from]; ok && from != to {
		if c.Credentials[service] == nil {
			c.Credentials[service] = map[string]map[string]any{}
		}
		c.Credentials[service][to] = stored
		delete(c.Credentials[service], from)
	}
	renameScopes(c, service, from, to)
	return WriteOK
}

// Delete drops a profile, its credentials, and its place in every key scope.
// False when no entry existed. Stray credentials are still removed.
func Delete(service, name string) (bool, error) {
	if auth.IsRemote() {
		outcome, err := auth.RemoteDelete(service, name)
		if err != nil {
			return false, err
		}
		return outcome == "ok", nil
	}
	var removed bool
	err := vault.Update(func(c *vault.Contents) error {
		removed = remove(c, service, name)
		return nil
	})
	return removed, err
}

func remove(c *vault.Contents, service, name string) bool {
	index := findIndex(c.Config.Profiles[service], name)
	removed := index != -1
	if removed {
		list := c.Config.Profiles[service]
		c.Config.Profiles[service] = append(list[:index], list[index+1:]...)
		pruneScopes(c)
	}
	if c.Credentials[service] != nil {
		delete(c.Credentials[service], name)
	}
	return removed
}

func SetReadOnly(service, name string, readOnly bool) (bool, error) {
	if auth.IsRemote() {
		return false, auth.RemoteModeError("Changing a profile")
	}
	var found bool
	err := vault.Update(func(c *vault.Contents) error {
		index := findIndex(c.Config.Profiles[service], name)
		if index == -1 {
			return nil
		}
		entry := c.Config.Profiles[service][index]
		entry.ReadOnly = readOnly
		c.Config.Profiles[service][index] = entry
		found = true
		return nil
	})
	return found, err
}

func WriteFailure(outcome WriteOutcome, service, name, to string) *clierr.Error {
	switch outcome {
	case WriteOK:
		return nil
	case WriteAbsent:
		return clierr.ProfileNotFoundError(service, name)
	case WriteDenied:
		return clierr.New(clierr.PermissionDenied,
			"This token is not allowed to use "+RefOf(service, name),
			"Ask the hub owner to widen this key, or choose a name it already covers")
	case WriteTaken:
		target := to
		if target == "" {
			target = name
		}
		return clierr.New(clierr.InvalidParams,
			"Profile "+RefOf(service, target)+" already exists",
			"Choose another name")
	default:
		return clierr.New(clierr.InvalidParams, fmt.Sprintf("Invalid profile name %q", to), `A name cannot be empty or contain "/"`)
	}
}

// SaveForKey adds a profile for a remote key, or replaces one it already reaches.
// A new name is granted to the key in the same write.
func SaveForKey(keyID, service, name string, credentials map[string]any, opt SaveOptions) (WriteOutcome, error) {
	var outcome WriteOutcome = WriteOK
	err := vault.Update(func(c *vault.Contents) error {
		index := findIndex(c.Config.Profiles[service], name)
		if index != -1 && !reaches(c, keyID, service, name) {
			outcome = WriteDenied
			return nil
		}
		if err := put(c, service, name, credentials, kept(c, service, index, opt)); err != nil {
			return err
		}
		grant(c, keyID, service, name)
		outcome = WriteOK
		return nil
	})
	return outcome, err
}

func DeleteForKey(keyID, service, name string) (WriteOutcome, error) {
	var outcome WriteOutcome
	err := vault.Update(func(c *vault.Contents) error {
		if findIndex(c.Config.Profiles[service], name) == -1 {
			outcome = WriteAbsent
			return nil
		}
		if !reaches(c, keyID, service, name) {
			outcome = WriteDenied
			return nil
		}
		remove(c, service, name)
		outcome = WriteOK
		return nil
	})
	return outcome, err
}

func RenameForKey(keyID, service, from, to string) (WriteOutcome, error) {
	var outcome WriteOutcome
	err := vault.Update(func(c *vault.Contents) error {
		if findIndex(c.Config.Profiles[service], from) == -1 {
			outcome = WriteAbsent
			return nil
		}
		if !reaches(c, keyID, service, from) {
			outcome = WriteDenied
			return nil
		}
		outcome = move(c, service, from, to)
		return nil
	})
	return outcome, err
}
