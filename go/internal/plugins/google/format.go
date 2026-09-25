package google

import (
	"math"

	"github.com/plosson/agentio/go/internal/jsvalue"
)

// FormatBytes is Bun format.ts formatBytes(bytes) for any value it is given
// (a size read from an answer may be a string, null or missing): one decimal,
// trailing ".0" dropped, units up to GB. Only a number 0 is "0 B"; a value
// whose unit index falls outside B..GB (a negative, NaN, fractional or huge
// size) prints "undefined" for the unit, as Bun does.
func FormatBytes(bytes any) string {
	if jsvalue.StrictEqual(bytes, 0) {
		return "0 B"
	}
	f := jsvalue.ToNumber(bytes)
	i := math.Floor(math.Log(f) / math.Log(1024))
	unit := "undefined"
	if sizes := []string{"B", "KB", "MB", "GB"}; i >= 0 && i < float64(len(sizes)) {
		unit = sizes[int(i)]
	}
	// parseFloat(value.toFixed(1)) + " " + unit
	return jsvalue.NumberString(jsvalue.Number(jsvalue.ToFixed(f/math.Pow(1024, i), 1))) + " " + unit
}

// AnswerItems is `(<data>.<key> || [])`, the list a Bun client maps over,
// read from an answer: data is how Bun names response.data in its TypeError
// when the answer is null.
func AnswerItems(raw any, data, key string) ([]any, error) {
	items, err := jsvalue.Path(raw, data, key)
	if err != nil {
		return nil, err
	}
	return jsvalue.Items(jsvalue.Or(items, []any{}), "("+data+"."+key+" || [])")
}

// Field is `${o.key}` in a Bun printer, for o an object built from an answer
// (google.Answer): a missing key prints "undefined", null "null".
func Field(o any, key string) string {
	return jsvalue.String(jsvalue.Member(o, key))
}

// Truthy is a Bun printer's `if (o.key)`.
func Truthy(o any, key string) bool {
	return jsvalue.Truthy(jsvalue.Member(o, key))
}
