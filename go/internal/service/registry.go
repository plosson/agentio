package service

import (
	"fmt"
	"sort"
	"strings"
	"sync"
)

// Registry mirrors Bun PluginRegistry: ordered, id-keyed catalog of in-tree plugins.
type Registry struct {
	mu   sync.RWMutex
	list []ServicePlugin
	byID map[string]ServicePlugin
}

// NewRegistry returns an empty registry (Bun `new PluginRegistry([])`).
func NewRegistry() *Registry {
	return &Registry{byID: map[string]ServicePlugin{}}
}

// Default is the process-wide catalog (Bun DEFAULT_PLUGIN_REGISTRY / getPluginRegistry).
var Default = NewRegistry()

// Register adds a plugin. Duplicate ID() values are rejected (Bun PluginRegistry ctor).
func (r *Registry) Register(s ServicePlugin) error {
	if s == nil {
		return fmt.Errorf("nil service plugin")
	}
	id := s.ID()
	if id == "" || strings.Contains(id, "/") || strings.Contains(id, " ") {
		return fmt.Errorf("invalid service id %q", id)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.byID[id]; ok {
		return fmt.Errorf("duplicate service id: %s", id)
	}
	r.byID[id] = s
	r.list = append(r.list, s)
	return nil
}

// MustRegister panics on Register error (init-time wiring).
func (r *Registry) MustRegister(s ServicePlugin) {
	if err := r.Register(s); err != nil {
		panic(err)
	}
}

// Find returns a plugin by id (Bun PluginRegistry.find).
func (r *Registry) Find(id string) (ServicePlugin, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	s, ok := r.byID[id]
	return s, ok
}

// Get is an alias for Find.
func (r *Registry) Get(id string) (ServicePlugin, bool) { return r.Find(id) }

// All returns plugins in registration order (Bun PluginRegistry.plugins).
func (r *Registry) All() []ServicePlugin {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]ServicePlugin, len(r.list))
	copy(out, r.list)
	return out
}

// ProfilePlugins returns plugins that support Setup (all registered today).
// Bun: PluginRegistry.profilePlugins().
func (r *Registry) ProfilePlugins() []ServicePlugin {
	return r.All()
}

// Names returns sorted service ids for help / error text.
func (r *Registry) Names() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	names := make([]string, 0, len(r.byID))
	for id := range r.byID {
		names = append(names, id)
	}
	sort.Strings(names)
	return names
}

// Has reports whether id is registered.
func (r *Registry) Has(id string) bool {
	_, ok := r.Find(id)
	return ok
}
