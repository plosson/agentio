// Package google is the layer every Google product plugin (gcal, gchat, gdocs,
// gdrive, gmail, gscript, gsheets, gslides, gtasks) builds on. Each product is
// its own plugins.Plugin under google/<id>/, built the same way from this
// package:
//
//   - Credentials: the product's Keys (Snake for gmail, gcal and gtasks, Camel
//     for the others) give its refresh (Keys.RefreshSpec) and its scope set
//     (Scopes). Setup, SnakeSetup and Reauthenticate are its profile flows, and
//     EmailFailure is the error of those that compose their own.
//   - Client: the product's api struct embeds API (context, RunContext and the
//     Bun clients' error shapes: APIError, NotFoundOr, StatusError, Failed)
//     beside the google.golang.org/api services it builds with NewService or
//     DriveService. CallJSON serves the calls those services cannot make.
//   - Commands: the generic input helpers (Stdin, OptionOrStdin,
//     RequireOptions, Result, and the Prepare adapters Parse, Check,
//     Required) live in package plugins. BatchRequests (a batch command's
//     Prepare, through Parse) and the Drive helpers
//     (ListDriveFiles, ExportDriveFile, CopyDriveFile, ValidateDriveFiles)
//     cover what several products share.
//
// Nothing here writes the vault; the host persists what these functions
// return. The product tests share googletest.
package google
