// Package google is the layer every Google product plugin (gcal, gchat, gdocs,
// gdrive, gmail, gscript, gsheets, gslides, gtasks) builds on. Each product is
// its own plugins.Plugin under google/<id>/, and gets its OAuth setup, its
// reauthentication, its refresh (RefreshSpec), its validate result and its
// google.golang.org/api client from this package: choose the product's
// credential Keys (Snake or Camel) and scope set, then call NewService.
// Nothing here writes the vault; the host persists what these functions return.
package google
