package plugins

import (
	"fmt"
	"regexp"
	"strings"
)

var (
	pluginID = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)
	longFlag = regexp.MustCompile(`(?:^|[, ]+)--[a-z][a-z0-9-]*`)
	hostFlag = regexp.MustCompile(`(?:^|[, ]+)--(?:profile|json)(?:[, =]|$)`)
)

var reservedIDs = map[string]bool{
	"config": true, "daemon": true, "docs": true, "doctor": true, "key": true,
	"login": true, "logout": true, "plugin": true, "profile": true, "reauth": true,
	"setup": true, "skill": true, "status": true, "update": true, "vault": true,
}

// Registry is an ordered, validated plugin catalog.
type Registry struct {
	plugins []*Plugin
	byID    map[string]*Plugin
}

func NewRegistry(plugins ...*Plugin) (*Registry, error) {
	r := &Registry{byID: map[string]*Plugin{}}
	for _, p := range plugins {
		if err := r.add(p); err != nil {
			return nil, err
		}
	}
	return r, nil
}

func (r *Registry) add(p *Plugin) error {
	if p == nil {
		return fmt.Errorf("invalid service plugin export")
	}
	if p.APIVersion != APIVersion {
		return fmt.Errorf("unsupported plugin API version for %s: %d", idOr(p), p.APIVersion)
	}
	if !pluginID.MatchString(p.ID) {
		return fmt.Errorf("invalid service id: %s", p.ID)
	}
	if reservedIDs[p.ID] {
		return fmt.Errorf("service id is reserved by Agentio: %s", p.ID)
	}
	if r.byID[p.ID] != nil {
		return fmt.Errorf("duplicate service id: %s", p.ID)
	}
	if strings.TrimSpace(p.DisplayName) == "" {
		return fmt.Errorf("plugin %s has no display name", p.ID)
	}
	if strings.TrimSpace(p.Description) == "" {
		return fmt.Errorf("plugin %s has no description", p.ID)
	}
	if p.Commands == nil {
		return fmt.Errorf("plugin %s has no commands", p.ID)
	}
	if p.Profile != nil && p.Profile.Refresh != nil && len(p.Profile.Refresh.SecretFields) == 0 {
		return fmt.Errorf("refreshable plugin %s must declare secret fields", p.ID)
	}
	if p.Profile != nil && (p.Profile.Setup == nil || p.Profile.Validate == nil) {
		return fmt.Errorf("plugin %s has an invalid profile contract", p.ID)
	}
	paths := map[string]bool{}
	for i := range p.Commands {
		cmd := &p.Commands[i]
		if strings.TrimSpace(cmd.Path) == "" {
			return fmt.Errorf("plugin %s has an empty command path", p.ID)
		}
		segments := strings.Fields(cmd.Path)
		for _, seg := range segments {
			if !pluginID.MatchString(seg) {
				return fmt.Errorf("plugin %s has an invalid command path: %s", p.ID, cmd.Path)
			}
		}
		if segments[0] == "profile" {
			return fmt.Errorf("plugin %s command path \"profile\" is reserved", p.ID)
		}
		if paths[cmd.Path] {
			return fmt.Errorf("plugin %s has duplicate command path: %s", p.ID, cmd.Path)
		}
		if strings.TrimSpace(cmd.Description) == "" {
			return fmt.Errorf("plugin %s command %s has no description", p.ID, cmd.Path)
		}
		if len(cmd.Examples) == 0 {
			return fmt.Errorf("plugin %s command %s has no examples", p.ID, cmd.Path)
		}
		if cmd.Run == nil {
			return fmt.Errorf("plugin %s command %s has no handler", p.ID, cmd.Path)
		}
		for _, opt := range cmd.Options {
			if !longFlag.MatchString(opt.Flags) {
				return fmt.Errorf("plugin %s command %s has invalid option flags: %s", p.ID, cmd.Path, opt.Flags)
			}
			if hostFlag.MatchString(opt.Flags) {
				return fmt.Errorf("plugin %s command %s redeclares host option: %s", p.ID, cmd.Path, opt.Flags)
			}
		}
		names := map[string]bool{}
		optionalSeen := false
		for _, arg := range cmd.Arguments {
			if !pluginID.MatchString(arg.Name) || names[arg.Name] {
				return fmt.Errorf("plugin %s command %s has an invalid or duplicate argument: %s", p.ID, cmd.Path, arg.Name)
			}
			if !arg.Required {
				optionalSeen = true
			}
			if arg.Required && optionalSeen {
				return fmt.Errorf("plugin %s command %s has a required argument after an optional argument", p.ID, cmd.Path)
			}
			names[arg.Name] = true
		}
		paths[cmd.Path] = true
	}
	r.plugins = append(r.plugins, p)
	r.byID[p.ID] = p
	return nil
}

// MustRegister adds a plugin or panics. The CLI calls this at startup.
func (r *Registry) MustRegister(p *Plugin) {
	if err := r.add(p); err != nil {
		panic(err)
	}
}

func (r *Registry) Find(id string) *Plugin { return r.byID[id] }

func (r *Registry) Plugins() []*Plugin { return append([]*Plugin(nil), r.plugins...) }

func (r *Registry) ProfilePlugins() []*Plugin {
	var out []*Plugin
	for _, p := range r.plugins {
		if p.Profile != nil {
			out = append(out, p)
		}
	}
	return out
}

// RefreshOf returns the refresh spec for a service, if it declared one.
func (r *Registry) RefreshOf(id string) *RefreshSpec {
	p := r.Find(id)
	if p == nil || p.Profile == nil {
		return nil
	}
	return p.Profile.Refresh
}

func idOr(p *Plugin) string {
	if p.ID == "" {
		return "<unknown>"
	}
	return p.ID
}

// Default is the process catalog the CLI registers fakes into.
var Default = &Registry{byID: map[string]*Plugin{}}
