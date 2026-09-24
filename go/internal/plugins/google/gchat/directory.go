package gchat

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

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
	FetchedAt string                    `json:"fetchedAt"`
	SyncToken string                    `json:"syncToken,omitempty"`
	Users     map[string]directoryEntry `json:"users"`
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
	if entry, ok := d.data.Users[userID]; ok {
		return &entry
	}
	return nil
}

func (d *directory) lookupByEmail(email string) (string, *directoryEntry) {
	if d.data == nil {
		return "", nil
	}
	target := strings.ToLower(email)
	ids := make([]string, 0, len(d.data.Users))
	for id := range d.data.Users {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		entry := d.data.Users[id]
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
	return len(d.data.Users)
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
			file.Users = map[string]directoryEntry{}
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

func (d *directory) page(syncToken, pageToken string) (*people.ListDirectoryPeopleResponse, error) {
	call := d.people.People.ListDirectoryPeople().ReadMask(directoryReadMask).Sources(directorySource).
		PageSize(1000).RequestSyncToken(true).Context(d.ctx)
	if syncToken != "" {
		call.SyncToken(syncToken)
	}
	if pageToken != "" {
		call.PageToken(pageToken)
	}
	return call.Do()
}

func (d *directory) fetchFull() error {
	users := map[string]directoryEntry{}
	syncToken, pageToken := "", ""
	for {
		resp, err := d.page("", pageToken)
		if err != nil {
			var ge *googleapi.Error
			if errors.As(err, &ge) {
				return fmt.Errorf("listDirectoryPeople failed: %d %s", ge.Code, ge.Body)
			}
			return err
		}
		for _, p := range resp.People {
			ingest(users, p)
		}
		if resp.NextSyncToken != "" {
			syncToken = resp.NextSyncToken
		}
		if pageToken = resp.NextPageToken; pageToken == "" {
			break
		}
	}
	d.data = &directoryFile{FetchedAt: google.ISOString(now()), SyncToken: syncToken, Users: users}
	return d.save()
}

func (d *directory) fetchIncremental(syncToken string) error {
	users := make(map[string]directoryEntry, len(d.data.Users))
	for id, entry := range d.data.Users {
		users[id] = entry
	}
	next, pageToken := "", ""
	for {
		resp, err := d.page(syncToken, pageToken)
		if err != nil {
			var ge *googleapi.Error
			if errors.As(err, &ge) {
				return fmt.Errorf("incremental sync failed: %d", ge.Code)
			}
			return err
		}
		for _, p := range resp.People {
			id := personToUserID(p.ResourceName)
			if id == "" {
				continue
			}
			if p.Metadata != nil && p.Metadata.Deleted {
				delete(users, id)
			} else {
				ingest(users, p)
			}
		}
		if resp.NextSyncToken != "" {
			next = resp.NextSyncToken
		}
		if pageToken = resp.NextPageToken; pageToken == "" {
			break
		}
	}
	if next == "" {
		next = syncToken
	}
	d.data = &directoryFile{FetchedAt: google.ISOString(now()), SyncToken: next, Users: users}
	return d.save()
}

func personToUserID(resourceName string) string {
	id := strings.TrimPrefix(resourceName, "people/")
	if id == "" {
		return ""
	}
	return "users/" + id
}

func ingest(users map[string]directoryEntry, p *people.Person) {
	id := personToUserID(p.ResourceName)
	if id == "" {
		return
	}
	name, email := personName(p), personEmail(p)
	if name == "" && email == "" {
		return
	}
	display := name
	if display == "" {
		display = email
	}
	users[id] = directoryEntry{DisplayName: display, Email: email}
}
