package google

import (
	"context"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
	drive "google.golang.org/api/drive/v3"
	"google.golang.org/api/googleapi"
)

// DriveService is the drive/v3 client the Drive-backed products (gdocs,
// gdrive, gsheets, gslides, gscript) build. They all store Camel credentials.
func DriveService(ctx context.Context, run *plugins.RunContext) (*drive.Service, error) {
	return NewService(ctx, run, Camel, drive.NewService)
}

// PageSize is Bun `pageSize: Math.min(limit, 100)` on a Drive list call: NaN
// (a --limit that parseInt rejects) is sent as "NaN", as gaxios does.
func PageSize(limit float64) googleapi.CallOption {
	if limit > 100 {
		limit = 100
	}
	return googleapi.QueryParameter("pageSize", jsvalue.NumberString(limit))
}
