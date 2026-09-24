package revolut

import (
	"encoding/json"
	"math"
	"strconv"

	"github.com/plosson/agentio/go/internal/jsvalue"
)

// undefinedT is JavaScript undefined: a missing field or an optional chain
// that stopped. JSON.stringify drops it, where it keeps null.
type undefinedT struct{}

var undefined any = undefinedT{}

// field is `v?.[key]`: undefined unless v is an object with that key.
func field(v any, key string) any {
	o, _ := v.(*jsvalue.Object)
	if got, ok := o.Get(key); ok {
		return got
	}
	return undefined
}

// nullish is `v == null`.
func nullish(v any) bool { return v == nil || v == undefined }

// coalesce is `a ?? b`.
func coalesce(a, b any) any {
	if nullish(a) {
		return b
	}
	return a
}

// truthy is `!!v`.
func truthy(v any) bool { return v != undefined && jsvalue.Truthy(v) }

// or is `a || b`.
func or(a, b any) any {
	if truthy(a) {
		return a
	}
	return b
}

// put is one property of an object literal: undefined leaves the key out, as
// JSON.stringify would.
func put(o *jsvalue.Object, key string, v any) {
	if v != undefined {
		o.Set(key, v)
	}
}

// text is `${v}`.
func text(v any) string {
	if v == undefined {
		return "undefined"
	}
	return jsvalue.String(v)
}

// num is JavaScript's numeric coercion of a decoded or stored value.
func num(v any) float64 {
	switch t := v.(type) {
	case nil:
		return 0
	case bool:
		if t {
			return 1
		}
		return 0
	case string:
		return jsvalue.Number(t)
	case json.Number:
		f, err := strconv.ParseFloat(string(t), 64)
		if err != nil {
			return jsvalue.Number(string(t))
		}
		return f
	case float64:
		return t
	case int64:
		return float64(t)
	case int:
		return float64(t)
	}
	return math.NaN()
}

// isNumber is `typeof v === 'number'`.
func isNumber(v any) bool {
	switch v.(type) {
	case json.Number, float64, int64, int:
		return true
	}
	return false
}

// isObject is `typeof v === 'object' && v !== null` for a decoded value.
func isObject(v any) bool {
	switch v.(type) {
	case *jsvalue.Object, []any:
		return true
	}
	return false
}

// array is `v ?? []` for a decoded array; anything else reads as empty.
func array(v any) []any {
	arr, _ := v.([]any)
	if arr == nil {
		return []any{}
	}
	return arr
}

// jsNumber is a number written as JSON.stringify writes it: NaN and Infinity
// become null, as they do when Bun stores them.
func jsNumber(f float64) any {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return nil
	}
	return json.Number(jsvalue.NumberString(f))
}

// toFixed2 is `n.toFixed(2)` for a decoded number.
func toFixed2(v any) string { return jsvalue.ToFixed(num(v), 2) }
