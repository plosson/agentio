package daemon

import (
	"context"
	"strings"
	"testing"

	"github.com/plosson/agentio/go/internal/plugins"
)

// AGENTIO_KEEPALIVE_HOURS is read with Bun's Number(raw): fractions,
// exponents, hex and padding are hours; the clamp and the lines are Bun's.
func TestKeepaliveHoursAreReadLikeBun(t *testing.T) {
	isolate(t)
	logs := &lockedLog{}
	restoreLog := SetOutput(logs)
	t.Cleanup(restoreLog)
	cases := []struct {
		raw   string
		hours float64
		line  string
	}{
		{"", DefaultIntervalHours, ""},
		{"   ", DefaultIntervalHours, ""},
		{"1.5", 1.5, ""},
		{" 24 ", 24, ""},
		{"0x10", 16, ""},
		{"1e2", 100, ""},
		{"-0", 0, ""},
		{"1e-400", 0, ""},
		{"0.5", 1, "AGENTIO_KEEPALIVE_HOURS=0.5 is outside 1-336, using 1"},
		{"400.25", 336, "AGENTIO_KEEPALIVE_HOURS=400.25 is outside 1-336, using 336"},
		{"1e3", 336, "AGENTIO_KEEPALIVE_HOURS=1000 is outside 1-336, using 336"},
		{"Infinity", DefaultIntervalHours, `Ignoring AGENTIO_KEEPALIVE_HOURS="Infinity": not a number of hours`},
		{"-1", DefaultIntervalHours, `Ignoring AGENTIO_KEEPALIVE_HOURS="-1": not a number of hours`},
		{`2"h`, DefaultIntervalHours, `Ignoring AGENTIO_KEEPALIVE_HOURS="2"h": not a number of hours`},
	}
	for _, c := range cases {
		logs.take()
		if got := IntervalHours(c.raw); got != c.hours {
			t.Errorf("%q: %v, want %v", c.raw, got, c.hours)
		}
		got := strings.TrimSpace(logs.take())
		if got != c.line {
			t.Errorf("%q: logged %q, want %q", c.raw, got, c.line)
		}
	}
	reg, err := plugins.NewRegistry()
	if err != nil {
		t.Fatal(err)
	}
	logs.take()
	StartKeepalive(context.Background(), reg, 1.5)
	StopKeepalive()
	if got := logs.take(); got != "Token keepalive every 1.5h\n" {
		t.Fatalf("start line %q", got)
	}
}
