package gchat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugincache"
	"github.com/plosson/agentio/go/internal/plugins/google"
	"google.golang.org/api/googleapi"
	people "google.golang.org/api/people/v1"
)

// The directory is Bun directory.ts: the workspace's user id to name and
// email map, cached for a day in the host plugin cache.
const (
	directoryTTL      = 24 * time.Hour
	directoryReadMask = "names,emailAddresses"
	directorySource   = "DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE"
)

type directoryEntry struct {
	DisplayName string `json:"displayName"`
	Email       string `json:"email,omitempty"`
}

// directoryFile is the cache file, shared with the Bun CLI.
type directoryFile struct {
	FetchedAt string          `json:"fetchedAt"`
	SyncToken string          `json:"syncToken,omitempty"`
	Users     *directoryUsers `json:"users"`
}

// directoryUsers is Bun's users object: entries by user id, in the order
// they were first set, which is the order a lookup by email walks.
type directoryUsers struct {
	ids  []string
	byID map[string]directoryEntry
}

func newDirectoryUsers() *directoryUsers {
	return &directoryUsers{byID: map[string]directoryEntry{}}
}

func (u *directoryUsers) get(id string) (directoryEntry, bool) {
	e, ok := u.byID[id]
	return e, ok
}

// set is users[id] = entry: a new id goes last, a known one keeps its place.
func (u *directoryUsers) set(id string, e directoryEntry) {
	if _, ok := u.byID[id]; !ok {
		u.ids = append(u.ids, id)
	}
	u.byID[id] = e
}

// remove is `delete users[id]`.
func (u *directoryUsers) remove(id string) {
	if _, ok := u.byID[id]; !ok {
		return
	}
	delete(u.byID, id)
	for i, x := range u.ids {
		if x == id {
			u.ids = append(u.ids[:i:i], u.ids[i+1:]...)
			break
		}
	}
}

// clone is `{ ...users }`.
func (u *directoryUsers) clone() *directoryUsers {
	out := newDirectoryUsers()
	for _, id := range u.ids {
		out.set(id, u.byID[id])
	}
	return out
}

func (u *directoryUsers) MarshalJSON() ([]byte, error) {
	o := jsvalue.NewObject()
	for _, id := range u.ids {
		o.Set(id, u.byID[id])
	}
	return jsvalue.Stringify(o), nil
}

func (u *directoryUsers) UnmarshalJSON(raw []byte) error {
	v, err := jsvalue.Parse(raw)
	if err != nil {
		return err
	}
	obj, ok := v.(*jsvalue.Object)
	if !ok {
		return errors.New("users is not an object")
	}
	*u = *newDirectoryUsers()
	for _, id := range obj.Keys() {
		val, _ := obj.Get(id)
		var e directoryEntry
		if err := json.Unmarshal(jsvalue.Stringify(val), &e); err != nil {
			return err
		}
		u.set(id, e)
	}
	return nil
}

type directory struct {
	ctx    context.Context
	people *people.Service
	scope  string
	data   *directoryFile
	loaded bool
}

func newDirectory(ctx context.Context, svc *people.Service, email string) *directory {
	return &directory{ctx: ctx, people: svc, scope: strings.ToLower(email)}
}

func (d *directory) lookup(userID string) *directoryEntry {
	if d.data == nil {
		return nil
	}
	if entry, ok := d.data.Users.get(userID); ok {
		return &entry
	}
	return nil
}

func (d *directory) lookupByEmail(email string) (string, *directoryEntry) {
	if d.data == nil {
		return "", nil
	}
	target := strings.ToLower(email)
	for _, id := range d.data.Users.ids { // Object.entries order
		entry := d.data.Users.byID[id]
		if entry.Email != "" && strings.ToLower(entry.Email) == target {
			return id, &entry
		}
	}
	return "", nil
}

func (d *directory) size() int {
	if d.data == nil {
		return 0
	}
	return len(d.data.Users.ids)
}

func (d *directory) fetchedAt() string {
	if d.data == nil {
		return ""
	}
	return d.data.FetchedAt
}

func (d *directory) filePath() (string, error) {
	return plugincache.Path("gchat", d.scope, "directory")
}

// ensureFresh loads the cache, then refetches it when forced, missing, or
// older than a day (incrementally when a sync token is kept).
func (d *directory) ensureFresh(force bool) error {
	d.load()
	if force || d.data == nil {
		return d.fetchFull()
	}
	fetched, err := time.Parse(time.RFC3339, d.data.FetchedAt)
	if err == nil && now().Sub(fetched) < directoryTTL {
		return nil
	}
	if d.data.SyncToken != "" {
		if err := d.fetchIncremental(d.data.SyncToken); err == nil {
			return nil
		}
		// The sync token expired or was rejected: fetch everything.
	}
	return d.fetchFull()
}

func (d *directory) load() {
	if d.loaded {
		return
	}
	d.loaded = true
	var file directoryFile
	// Caches are disposable: absence and corruption both mean a fresh fetch.
	if ok, _ := plugincache.Read("gchat", d.scope, "directory", &file); ok {
		if file.Users == nil {
			file.Users = newDirectoryUsers()
		}
		d.data = &file
	}
}

func (d *directory) save() error {
	if d.data == nil {
		return nil
	}
	return plugincache.Write("gchat", d.scope, "directory", d.data)
}

// page is one listDirectoryPeople page, read as JavaScript reads it.
func (d *directory) page(syncToken, pageToken string) (any, error) {
	call := d.people.People.ListDirectoryPeople().ReadMask(directoryReadMask).Sources(directorySource).
		PageSize(1000).RequestSyncToken(true)
	if syncToken != "" {
		call.SyncToken(syncToken)
	}
	if pageToken != "" {
		call.PageToken(pageToken)
	}
	_, data, err := google.Answer(d.ctx, call)
	return data, err
}

// persons is `(data.people || [])` of a page, and the page's
// nextPageToken and nextSyncToken.
func persons(data any) (people []any, pageToken, syncToken string, err error) {
	v, err := jsvalue.Path(data, "data", "people")
	if err != nil {
		return nil, "", "", err
	}
	if people, err = jsvalue.Items(jsvalue.Or(v, []any{}), "(data.people || [])"); err != nil {
		return nil, "", "", err
	}
	for _, p := range people {
		if jsvalue.Nullish(p) {
			return nil, "", "", jsvalue.TypeError(p, "person.resourceName")
		}
	}
	if next := jsvalue.Member(data, "nextPageToken"); jsvalue.Truthy(next) {
		pageToken = jsvalue.String(next)
	}
	if next := jsvalue.Member(data, "nextSyncToken"); jsvalue.Truthy(next) {
		syncToken = jsvalue.String(next)
	}
	return people, pageToken, syncToken, nil
}

func (d *directory) fetchFull() error {
	users := newDirectoryUsers()
	syncToken, pageToken := "", ""
	for {
		data, err := d.page("", pageToken)
		if err != nil {
			var ge *googleapi.Error
			if errors.As(err, &ge) {
				return fmt.Errorf("listDirectoryPeople failed: %d %s", ge.Code, ge.Body)
			}
			return err
		}
		people, next, sync, err := persons(data)
		if err != nil {
			return err
		}
		for _, p := range people {
			ingest(users, p)
		}
		if sync != "" {
			syncToken = sync
		}
		if pageToken = next; pageToken == "" {
			break
		}
	}
	d.data = &directoryFile{FetchedAt: jsvalue.ISOString(now()), SyncToken: syncToken, Users: users}
	return d.save()
}

func (d *directory) fetchIncremental(syncToken string) error {
	users := d.data.Users.clone()
	next, pageToken := "", ""
	for {
		data, err := d.page(syncToken, pageToken)
		if err != nil {
			var ge *googleapi.Error
			if errors.As(err, &ge) {
				return fmt.Errorf("incremental sync failed: %d", ge.Code)
			}
			return err
		}
		people, nextPage, sync, err := persons(data)
		if err != nil {
			return err
		}
		for _, p := range people {
			id := personToUserID(jsvalue.Member(p, "resourceName"))
			if id == "" {
				continue
			}
			if jsvalue.Truthy(jsvalue.Optional(jsvalue.Member(p, "metadata"), "deleted")) {
				users.remove(id)
			} else {
				ingest(users, p)
			}
		}
		if sync != "" {
			next = sync
		}
		if pageToken = nextPage; pageToken == "" {
			break
		}
	}
	if next == "" {
		next = syncToken
	}
	d.data = &directoryFile{FetchedAt: jsvalue.ISOString(now()), SyncToken: next, Users: users}
	return d.save()
}

func personToUserID(resourceName any) string {
	if !jsvalue.Truthy(resourceName) {
		return ""
	}
	id := strings.TrimPrefix(jsvalue.String(resourceName), "people/")
	if id == "" {
		return ""
	}
	return "users/" + id
}

// ingest is Bun ingest: a person with neither a name nor an email is left out.
func ingest(users *directoryUsers, p any) {
	id := personToUserID(jsvalue.Member(p, "resourceName"))
	if id == "" {
		return
	}
	name, email := first(p, "names", "displayName"), first(p, "emailAddresses", "value")
	if !jsvalue.Truthy(name) && !jsvalue.Truthy(email) {
		return
	}
	entry := directoryEntry{DisplayName: jsvalue.String(jsvalue.Or(jsvalue.Or(name, email), id))}
	if jsvalue.Truthy(email) {
		entry.Email = jsvalue.String(email)
	}
	users.set(id, entry)
}
