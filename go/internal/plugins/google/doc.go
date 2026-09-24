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
//   - Commands: Stdin and OptionOrStdin read piped input as Bun readStdin does.
//     RequireOptions is Commander's requiredOption. An input check written as
//     a FailFunc check becomes an AccessFor with WriteUnlessInvalid, so on a
//     read-only profile the input error wins as in Bun. Result, BatchRequests
//     and the Drive helpers (ListDriveFiles, ExportDriveFile, CopyDriveFile,
//     ValidateDriveFiles) cover what several products share.
//
// Nothing here writes the vault; the host persists what these functions
// return. The product tests share googletest.
package google
