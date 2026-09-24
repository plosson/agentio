package google

import (
	"math"
	"strconv"
	"time"

	"github.com/plosson/agentio/go/internal/jsvalue"
)

// FormatBytes is Bun format.ts formatBytes: one decimal, trailing ".0"
// dropped, units up to GB (a larger value prints "undefined" as Bun does).
func FormatBytes(bytes int64) string {
	if bytes == 0 {
		return "0 B"
	}
	sizes := []string{"B", "KB", "MB", "GB"}
	i := int(math.Floor(math.Log(float64(bytes)) / math.Log(1024)))
	unit := "undefined"
	if i >= 0 && i < len(sizes) {
		unit = sizes[i]
	}
	value := float64(bytes) / math.Pow(1024, float64(i))
	// parseFloat(value.toFixed(1)) + " " + unit
	fixed, _ := strconv.ParseFloat(jsvalue.ToFixed(value, 1), 64)
	return jsvalue.NumberString(fixed) + " " + unit
}

// ISOString is Date.toISOString: UTC, milliseconds, truncated.
func ISOString(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}
