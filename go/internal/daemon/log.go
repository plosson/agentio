package daemon

import (
	"io"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/plosson/agentio/go/internal/jsvalue"
)

// The daemon's operator output is Bun's console.log: stdout, one whole line
// per call, whichever goroutine (a request, a keepalive timer) writes it.
var (
	outMu sync.Mutex
	out   io.Writer = os.Stdout
)

// SetOutput sends the daemon's lines to w and returns the undo.
func SetOutput(w io.Writer) (restore func()) {
	outMu.Lock()
	defer outMu.Unlock()
	saved := out
	out = w
	return func() {
		outMu.Lock()
		defer outMu.Unlock()
		out = saved
	}
}

// say is console.log(line).
func say(line string) {
	outMu.Lock()
	defer outMu.Unlock()
	_, _ = io.WriteString(out, line+"\n")
}

// daemonLog is Bun's daemonLog: `<ISO-8601> <subsystem> k=v …`, values as
// `${value}` renders them, and a field whose value is nil dropped, as Bun
// drops an undefined one. The runbook promises this shape for `docker logs`.
func daemonLog(subsystem string, fields ...field) {
	pairs := make([]string, 0, len(fields))
	for _, f := range fields {
		if f.value != nil {
			pairs = append(pairs, f.key+"="+jsvalue.String(f.value))
		}
	}
	say(jsvalue.ISOString(time.Now()) + " " + subsystem + " " + strings.Join(pairs, " "))
}
