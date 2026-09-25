package vault

import (
	"bytes"
	"encoding/json"
	"fmt"

	"github.com/plosson/agentio/go/internal/jsvalue"
)

// Bun holds the vault as the object JSON.parse gives and writes it back with
// JSON.stringify, so every level keeps its key order: services and profiles
// as they were added, each credential object as its producer built it. The
// two maps of the document are kept as ordered objects for that reason.

// Credentials is the vault's credentials member: service, then profile, then
// the credential object, each level in Bun's order.
type Credentials struct {
	obj *jsvalue.Object
}

func (c *Credentials) init() {
	if c.obj == nil {
		c.obj = jsvalue.NewObject()
	}
}

// NewCredentials is an empty credentials member, `{}`.
func NewCredentials() Credentials { return Credentials{obj: jsvalue.NewObject()} }

// Services are the services with a credentials entry, in stored order.
func (c Credentials) Services() []string { return c.obj.Keys() }

// Profiles are a service's profile names with credentials, in stored order.
func (c Credentials) Profiles(service string) []string {
	svc, _ := c.obj.Value(service).(*jsvalue.Object)
	return svc.Keys()
}

// Get is `store[service]?.[profile]` when that is an object; nil otherwise.
// The object is the stored one: Clone it before changing it.
func (c Credentials) Get(service, profile string) *jsvalue.Object {
	svc, _ := c.obj.Value(service).(*jsvalue.Object)
	cred, _ := svc.Value(profile).(*jsvalue.Object)
	return cred
}

// Has is Bun's hasStored, `!!store[service]?.[profile]`.
func (c Credentials) Has(service, profile string) bool {
	svc, _ := c.obj.Value(service).(*jsvalue.Object)
	return jsvalue.Truthy(svc.Value(profile))
}

// Put is Bun's putCredentials, `(store[service] ??= {})[profile] = data`: a
// replaced profile keeps its place, a new one goes last. data is copied.
func (c *Credentials) Put(service, profile string, data *jsvalue.Object) {
	c.init()
	svc, ok := c.obj.Value(service).(*jsvalue.Object)
	if !ok {
		svc = jsvalue.NewObject()
		c.obj.Set(service, svc)
	}
	svc.Set(profile, data.Clone())
}

// Delete is `delete store[service]?.[profile]`. The service entry stays,
// empty or not, as in Bun.
func (c Credentials) Delete(service, profile string) {
	if svc, ok := c.obj.Value(service).(*jsvalue.Object); ok {
		svc.Delete(profile)
	}
}

// AddMissing is `(store[service] ??= {})[profile] ??= data`, Bun's merge of
// an import: an existing entry is left as it is.
func (c *Credentials) AddMissing(service, profile string, data any) {
	c.init()
	svc, ok := c.obj.Value(service).(*jsvalue.Object)
	if !ok {
		svc = jsvalue.NewObject()
		c.obj.Set(service, svc)
	}
	if jsvalue.Nullish(svc.Value(profile)) {
		svc.Set(profile, jsvalue.CloneValue(data))
	}
}

// Raw is `store[service]?.[profile]` as stored, whatever it is, and whether
// it is there.
func (c Credentials) Raw(service, profile string) (any, bool) {
	svc, ok := c.obj.Value(service).(*jsvalue.Object)
	if !ok {
		return nil, false
	}
	return svc.Get(profile)
}

// SetRaw stores a value as the service's entry for a profile, as it came
// (an export's selection, a merge).
func (c *Credentials) SetRaw(service, profile string, v any) {
	c.init()
	svc, ok := c.obj.Value(service).(*jsvalue.Object)
	if !ok {
		svc = jsvalue.NewObject()
		c.obj.Set(service, svc)
	}
	svc.Set(profile, jsvalue.CloneValue(v))
}

func (c Credentials) MarshalJSON() ([]byte, error) {
	if c.obj == nil {
		return []byte("null"), nil
	}
	return jsvalue.Stringify(c.obj), nil
}

func (c *Credentials) UnmarshalJSON(b []byte) error {
	v, err := jsvalue.Parse(b)
	if err != nil {
		return err
	}
	switch x := v.(type) {
	case nil:
		c.obj = nil
	case *jsvalue.Object:
		c.obj = x
	default:
		return fmt.Errorf("vault credentials are not an object")
	}
	return nil
}

// Profiles is config.profiles: each service's profile entries, services in
// Bun's order (Object.keys), a new one last.
type Profiles struct {
	obj *jsvalue.Object // service -> []ProfileValue
}

func (p *Profiles) init() {
	if p.obj == nil {
		p.obj = jsvalue.NewObject()
	}
}

// NewProfiles is an empty profiles member, `{}`.
func NewProfiles() Profiles { return Profiles{obj: jsvalue.NewObject()} }

// Services are the services with a profiles entry, in Bun's order.
func (p Profiles) Services() []string { return p.obj.Keys() }

// Has is whether the service has an entry, even an empty one.
func (p Profiles) Has(service string) bool { return p.obj.Has(service) }

// Get is the service's entries, nil when it has none. The slice is the stored
// one: change an element in place, and Set after an append.
func (p Profiles) Get(service string) []ProfileValue {
	list, _ := p.obj.Value(service).([]ProfileValue)
	return list
}

// Set replaces the service's entries: an existing service keeps its place,
// a new one goes last.
func (p *Profiles) Set(service string, list []ProfileValue) {
	p.init()
	p.obj.Set(service, list)
}

// Len is the number of services.
func (p Profiles) Len() int { return p.obj.Len() }

func (p Profiles) MarshalJSON() ([]byte, error) {
	if p.obj == nil {
		return []byte("null"), nil
	}
	var b bytes.Buffer
	b.WriteByte('{')
	for i, service := range p.obj.Keys() {
		if i > 0 {
			b.WriteByte(',')
		}
		b.Write(jsvalue.Stringify(service))
		b.WriteByte(':')
		raw, err := json.Marshal(p.Get(service))
		if err != nil {
			return nil, err
		}
		b.Write(raw)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

func (p *Profiles) UnmarshalJSON(b []byte) error {
	if string(bytes.TrimSpace(b)) == "null" {
		p.obj = nil
		return nil
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	obj := jsvalue.NewObject()
	for _, service := range memberOrder(b) {
		var list []ProfileValue
		if err := json.Unmarshal(raw[service], &list); err != nil {
			return err
		}
		obj.Set(service, list)
	}
	p.obj = obj
	return nil
}
