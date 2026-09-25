package daemon

import (
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
)

// Health is what the CLI reads from a local daemon's /health.
type Health struct {
	Locked bool
}

// ProbeHealth is Bun's getDaemonHealth: GET /health on 127.0.0.1 with a
// 1.5 s timeout. It is nil when the daemon does not answer, answers outside
// 2xx, or with a body that is not JSON or is falsy. Reads nothing from the
// vault, so it works locked or unlocked.
func ProbeHealth() *Health {
	req, err := http.NewRequest(http.MethodGet, "http://127.0.0.1:"+strconv.Itoa(Port)+"/health", nil)
	if err != nil {
		return nil
	}
	res, err := plugins.NewHTTPClient(1500 * time.Millisecond).Do(req)
	if err != nil {
		return nil
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil
	}
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return nil
	}
	body, err := jsvalue.Parse(raw)
	if err != nil || !jsvalue.Truthy(body) {
		return nil
	}
	// `health.locked` of a body that is not an object is undefined.
	health := &Health{}
	if obj, ok := body.(*jsvalue.Object); ok {
		locked, _ := obj.Get("locked")
		health.Locked = jsvalue.Truthy(locked)
	}
	return health
}
