package plugins

import (
	"fmt"
	"regexp"
	"strings"
)

var (
	pluginID = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)
	longFlag = regexp.MustCompile(`(?:^|[, ]+)--[a-z][a-z0-9-]*`)
	// hostFlag is what the host puts on every command. A command may declare
	// its own --json (Bun gchat and slack `send --json [file]`); the host then
	// adds no output flag, as Bun's declarative adapter does.
	hostFlag = regexp.MustCompile(`(?:^|[, ]+)--profile(?:[, =]|$)`)
	// setupHostFlag is what the host already puts on `profile add`.
	setupHostFlag = regexp.MustCompile(`(?:^|[, ]+)--(?:profile|read-only)(?:[, =]|$)`)
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
	if p.Profile != nil {
		for _, opt := range p.Profile.SetupOptions {
			if !longFlag.MatchString(opt.Flags) {
				return fmt.Errorf("plugin %s profile add has invalid option flags: %s", p.ID, opt.Flags)
			}
			if setupHostFlag.MatchString(opt.Flags) {
				return fmt.Errorf("plugin %s profile add redeclares host option: %s", p.ID, opt.Flags)
			}
		}
	}
	paths := map[string]bool{}
	// names holds every invocable path, aliases included, so an alias cannot
	// shadow a sibling command.
	names := map[string]bool{}
	for i := range p.Commands {
		names[p.Commands[i].Path] = true
	}
	// defaults holds the groups that already have a default command.
	defaults := map[string]bool{}
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
			if opt.Repeatable && !strings.Contains(opt.Flags, "<") {
				return fmt.Errorf("plugin %s command %s has a repeatable option without a value: %s", p.ID, cmd.Path, opt.Flags)
			}
		}
		parent := strings.Join(segments[:len(segments)-1], " ")
		if cmd.Default {
			if defaults[parent] || names[parent] {
				return fmt.Errorf("plugin %s command %s cannot be the default of its group", p.ID, cmd.Path)
			}
			defaults[parent] = true
		}
		for _, alias := range cmd.Aliases {
			full := strings.TrimSpace(parent + " " + alias)
			if !pluginID.MatchString(alias) || alias == "profile" || names[full] {
				return fmt.Errorf("plugin %s command %s has an invalid or duplicate alias: %s", p.ID, cmd.Path, alias)
			}
			names[full] = true
		}
		argNames := map[string]bool{}
		optionalSeen := false
		for _, arg := range cmd.Arguments {
			if !pluginID.MatchString(arg.Name) || argNames[arg.Name] {
				return fmt.Errorf("plugin %s command %s has an invalid or duplicate argument: %s", p.ID, cmd.Path, arg.Name)
			}
			if !arg.Required {
				optionalSeen = true
			}
			if arg.Required && optionalSeen {
				return fmt.Errorf("plugin %s command %s has a required argument after an optional argument", p.ID, cmd.Path)
			}
			argNames[arg.Name] = true
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
