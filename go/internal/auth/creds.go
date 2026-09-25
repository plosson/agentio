package auth

import (
	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/vault"
)

// GetCredentials returns a copy of the stored object, or (nil, nil) when
// nothing is stored. In remote mode the hub has already refreshed and
// stripped secret fields.
func GetCredentials(service, profile string) (*jsvalue.Object, error) {
	if IsRemote() {
		return RemoteCredentials(service, profile)
	}
	c, err := vault.Load()
	if err != nil {
		return nil, err
	}
	return c.Credentials.Get(service, profile).Clone(), nil
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
	return store.Has(service, profile), nil
}

// AllCredentials is Bun's getAllCredentials: every stored credential object in
// one read. Local vault only.
func AllCredentials() (vault.Credentials, error) {
	c, err := vault.Load()
	if err != nil {
		return vault.Credentials{}, err
	}
	return c.Credentials, nil
}

// SetCredentials replaces one profile's credential object, as Bun's
// setCredentials: a replaced profile keeps its place. Local vault only.
func SetCredentials(service, profile string, data *jsvalue.Object) error {
	if err := AssertLocal("Changing credentials"); err != nil {
		return err
	}
	return vault.Update(func(c *vault.Contents) error {
		c.Credentials.Put(service, profile, data)
		return nil
	})
}
