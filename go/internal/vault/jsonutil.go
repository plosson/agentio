package vault

import (
	"bytes"
	"encoding/json"
)

func jsonMarshal(v any) ([]byte, error) { return json.Marshal(v) }

func jsonUnmarshal(b []byte, v any) error { return json.Unmarshal(b, v) }

// decodeNumbers unmarshals b keeping numbers as json.Number, so credential
// values round-trip without float rounding.
func decodeNumbers(b []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	return dec.Decode(v)
}

// unknownMembers returns the members of the JSON object b whose keys are not
// in known. Bun keeps the whole document, so Go must carry what it does not
// model through a load and save.
func unknownMembers(b []byte, known ...string) (map[string]json.RawMessage, error) {
	var all map[string]json.RawMessage
	if err := json.Unmarshal(b, &all); err != nil {
		return nil, err
	}
	for _, k := range known {
		delete(all, k)
	}
	if len(all) == 0 {
		return nil, nil
	}
	return all, nil
}

// withUnknown adds the members of extra to the JSON object obj.
func withUnknown(obj []byte, extra map[string]json.RawMessage) ([]byte, error) {
	if len(extra) == 0 {
		return obj, nil
	}
	var all map[string]json.RawMessage
	if err := json.Unmarshal(obj, &all); err != nil {
		return nil, err
	}
	for k, v := range extra {
		if _, ok := all[k]; !ok {
			all[k] = v
		}
	}
	return json.Marshal(all)
}
