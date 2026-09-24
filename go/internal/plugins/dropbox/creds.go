package dropbox

import (
	"encoding/json"
	"strconv"
)

// jsonNum is a credential expiry written as a JSON number. A plain string
// would change the vault wire format the Bun CLI reads back.
type jsonNum int64

func (n jsonNum) MarshalJSON() ([]byte, error) {
	return []byte(strconv.FormatInt(int64(n), 10)), nil
}

func copyMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

func str(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}

// asInt64 reads an expiry after a vault round trip (json.Number) or from a
// map that has not been serialized yet.
func asInt64(v any) (int64, bool) {
	switch n := v.(type) {
	case json.Number:
		i, err := n.Int64()
		if err != nil {
			f, ferr := n.Float64()
			if ferr != nil {
				return 0, false
			}
			return int64(f), true
		}
		return i, true
	case jsonNum:
		return int64(n), true
	case float64:
		return int64(n), true
	case int64:
		return n, true
	case int:
		return int64(n), true
	default:
		return 0, false
	}
}

// truthy is JavaScript's `!!value` for a decoded JSON value.
func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case json.Number:
		f, err := x.Float64()
		return err == nil && f != 0
	case float64:
		return x != 0
	case int64:
		return x != 0
	case int:
		return x != 0
	default:
		return true
	}
}
