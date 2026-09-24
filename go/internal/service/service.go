// Package service is the Go mirror of Bun's plugin boundary:
//
//	src/plugins/types.ts          ServicePlugin, ProfilePlugin, ProfileAddOptions
//	src/plugin-sdk/index.ts       SetupOptions, SetupResult, ProfileSpec.setup
//	src/plugins/plugin-registry.ts PluginRegistry
//	src/plugins/profile-host.ts   (host persists; plugin only returns SetupResult)
//
// A ServicePlugin owns authentication (Setup ≡ profile.setup) and service API work.
// AgentIO core owns vault, daemon, profile CRUD, and `agentio profile …` CLI wiring.
// Plugins never touch vault crypto — they return credentials; the host calls
// profile.AddProfileFromPlugin → SaveProfile.
package service

import "context"

// APIVersion is Bun ServicePlugin.apiVersion (only 1 is supported).
const APIVersion = 1

// SetupOptions mirrors Bun ProfileAddOptions / plugin-sdk SetupOptions.
// The host passes these into Setup; the plugin typically ignores Profile
// (the host still chooses the final name via profile.ChooseProfileName).
type SetupOptions struct {
	Profile  string
	ReadOnly bool
}

// SetupResult mirrors Bun plugin-sdk SetupResult<Credentials>.
// Credentials are opaque JSON-shaped maps (Bun StoredCredentials values).
type SetupResult struct {
	Credentials          map[string]any
	SuggestedProfileName string
	Info                 string
}

// ServicePlugin mirrors Bun's ServicePlugin + ProfilePlugin.setup contract.
// Nested ProfilePlugin / CredentialLifecycle / registerCommands land as more
// services are ported; Setup is the required auth hook for profile add.
type ServicePlugin interface {
	// ID is Bun ServicePlugin.id (vault service key + CLI argument).
	ID() string
	// DisplayName is Bun ServicePlugin.displayName.
	DisplayName() string
	// Description is Bun ServicePlugin.description.
	Description() string
	// Setup is Bun ProfilePlugin.setup / ProfileSpec.setup.
	// Must not write the vault — host persists via profile.AddProfileFromPlugin.
	Setup(ctx context.Context, opts SetupOptions) (*SetupResult, error)
}

// Service is an alias kept for call sites that prefer the shorter name.
type Service = ServicePlugin
