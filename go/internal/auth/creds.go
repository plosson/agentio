package auth

import (
	"github.com/plosson/agentio/go/internal/vault"
)

// GetCredentials returns the stored object, or (nil, nil) when nothing is stored.
// In remote mode the hub has already refreshed and stripped secret fields.
func GetCredentials(service, profile string) (map[string]any, error) {
	if IsRemote() {
		return RemoteCredentials(service, profile)
	}
	c, err := vault.Load()
	if err != nil {
		return nil, err
	}
	svc := c.Credentials[service]
	if svc == nil {
		return nil, nil
	}
	creds, ok := svc[profile]
	if !ok {
		return nil, nil
	}
	return vault.CloneMap(creds)
}

func HasCredentials(service, profile string) (bool, error) {
	if IsRemote() {
		profiles, err := RemoteProfiles()
		if err != nil {
			return false, err
		}
		for _, p := range profiles {
			if p.Service == service && p.Name == profile {
				return p.HasCredentials, nil
			}
		}
		return false, nil
	}
	store, err := AllCredentials()
	if err != nil {
		return false, err
	}
	return HasStored(store, service, profile), nil
}

// AllCredentials is Bun's getAllCredentials: every stored credential object in
// one read. Local vault only.
func AllCredentials() (vault.Credentials, error) {
	c, err := vault.Load()
	if err != nil {
		return nil, err
	}
	return c.Credentials, nil
}

// HasStored is Bun's hasStored, `!!store[service]?.[profile]`: a stored null
// is nothing stored.
func HasStored(store vault.Credentials, service, profile string) bool {
	return store[service][profile] != nil
}

// SetCredentials replaces one profile's credential object. Local vault only.
func SetCredentials(service, profile string, data map[string]any) error {
	if err := AssertLocal("Changing credentials"); err != nil {
		return err
	}
	cloned, err := vault.CloneMap(data)
	if err != nil {
		return err
	}
	return vault.Update(func(c *vault.Contents) error {
		if c.Credentials[service] == nil {
			c.Credentials[service] = map[string]map[string]any{}
		}
		c.Credentials[service][profile] = cloned
		return nil
	})
}
