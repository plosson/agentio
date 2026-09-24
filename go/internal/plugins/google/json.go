package google

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"unicode/utf8"

	"github.com/plosson/agentio/go/internal/plugins"
	"google.golang.org/api/googleapi"
)

// Some Bun commands print or forward the API's own objects (a raw document
// dump, a batchUpdate escape hatch). The typed google.golang.org/api structs
// reorder keys, drop false and zero values, and drop fields the pinned client
// does not know, so those commands keep the JSON as an ordered value instead.

// Object is a JSON object that remembers key order. A repeated key keeps its
// first position and its last value, as JSON.parse does.
type Object struct {
	keys []string
	vals map[string]any
}

// Get returns the value under key and whether the key is present.
func (o *Object) Get(key string) (any, bool) {
	if o == nil {
		return nil, false
	}
	v, ok := o.vals[key]
	return v, ok
}

func (o *Object) set(key string, v any) {
	if _, ok := o.vals[key]; !ok {
		o.keys = append(o.keys, key)
	}
	o.vals[key] = v
}

// MarshalJSON is JSON.stringify(o) without indentation; the host indents.
func (o *Object) MarshalJSON() ([]byte, error) {
	return Stringify(o), nil
}

// Stringify is JSON.stringify(v) for a ParseJSON value.
func Stringify(v any) []byte {
	var b bytes.Buffer
	writeValue(&b, v)
	return b.Bytes()
}

// ParseJSON is JSON.parse keeping object key order: objects are *Object,
// arrays []any, numbers json.Number.
func ParseJSON(raw []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	v, err := readValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("unexpected data after JSON value")
	}
	return v, nil
}

func readValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	d, ok := tok.(json.Delim)
	if !ok {
		return tok, nil
	}
	switch d {
	case '{':
		o := &Object{vals: map[string]any{}}
		for dec.More() {
			kt, err := dec.Token()
			if err != nil {
				return nil, err
			}
			key, _ := kt.(string)
			v, err := readValue(dec)
			if err != nil {
				return nil, err
			}
			o.set(key, v)
		}
		_, err := dec.Token()
		return o, err
	case '[':
		arr := []any{}
		for dec.More() {
			v, err := readValue(dec)
			if err != nil {
				return nil, err
			}
			arr = append(arr, v)
		}
		_, err := dec.Token()
		return arr, err
	}
	return nil, fmt.Errorf("unexpected %v", d)
}

func writeValue(b *bytes.Buffer, v any) {
	switch t := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		b.WriteString(strconv.FormatBool(t))
	case string:
		writeString(b, t)
	case json.Number:
		f, err := strconv.ParseFloat(string(t), 64)
		if (err != nil && !errors.Is(err, strconv.ErrRange)) || math.IsInf(f, 0) {
			b.WriteString("null")
			return
		}
		b.WriteString(JSNumber(f))
	case *Object:
		if t == nil {
			b.WriteString("null")
			return
		}
		b.WriteByte('{')
		for i, k := range t.keys {
			if i > 0 {
				b.WriteByte(',')
			}
			writeString(b, k)
			b.WriteByte(':')
			writeValue(b, t.vals[k])
		}
		b.WriteByte('}')
	case []any:
		b.WriteByte('[')
		for i, e := range t {
			if i > 0 {
				b.WriteByte(',')
			}
			writeValue(b, e)
		}
		b.WriteByte(']')
	default:
		raw, _ := json.Marshal(t)
		b.Write(raw)
	}
}

// writeString quotes like JSON.stringify: only quote, backslash and control
// characters are escaped; <, >, &, = and U+2028 are written as is.
func writeString(b *bytes.Buffer, s string) {
	b.WriteByte('"')
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		i += size
		switch {
		case r == '"':
			b.WriteString(`\"`)
		case r == '\\':
			b.WriteString(`\\`)
		case r == '\b':
			b.WriteString(`\b`)
		case r == '\f':
			b.WriteString(`\f`)
		case r == '\n':
			b.WriteString(`\n`)
		case r == '\r':
			b.WriteString(`\r`)
		case r == '\t':
			b.WriteString(`\t`)
		case r < 0x20:
			fmt.Fprintf(b, `\u%04x`, r)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
}

// CallJSON sends body verbatim (nil for none) to basePath+path with the
// profile's token and returns the response parsed by ParseJSON. basePath is a
// product client's BasePath, so WithEndpoints applies. A failure is a
// *googleapi.Error, so ErrorCode, Message and StatusMessage read it.
func CallJSON(ctx context.Context, run *plugins.RunContext, keys Keys, method, basePath, path string, body []byte) (any, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, basePath+path, reader)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := HTTPClient(run, keys).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if err := googleapi.CheckResponse(resp); err != nil {
		return nil, err
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	return ParseJSON(raw)
}
