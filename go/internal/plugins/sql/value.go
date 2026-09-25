package sql

import (
	"bytes"
	"math"
	"sort"
	"strconv"
	"time"

	"github.com/plosson/agentio/go/internal/jsvalue"
)

// The values below are what Bun.SQL hands to JSON.stringify for a column. A
// plain cell is nil, bool, float64 (NaN and ±Infinity print as null) or
// string; the types here are the JavaScript objects whose JSON differs.

// jsDate is a Date holding epoch milliseconds: JSON.stringify writes
// toISOString(), and null for an Invalid Date.
type jsDate float64

func (d jsDate) MarshalJSON() ([]byte, error) {
	ms := float64(d)
	// TimeClip: beyond ±8.64e15 ms, or NaN, is an Invalid Date.
	if math.IsNaN(ms) || math.Abs(ms) > 8.64e15 {
		return []byte("null"), nil
	}
	ms = math.Trunc(ms)
	return []byte(jsvalue.Quote(jsvalue.ISOString(time.UnixMilli(int64(ms))))), nil
}

// jsBuffer is a Node Buffer (Bun.SQL bytea and binary MySQL columns):
// JSON.stringify calls Buffer#toJSON.
type jsBuffer []byte

func (b jsBuffer) MarshalJSON() ([]byte, error) {
	var out bytes.Buffer
	out.WriteString(`{"type":"Buffer","data":[`)
	for i, c := range b {
		if i > 0 {
			out.WriteByte(',')
		}
		out.WriteString(strconv.Itoa(int(c)))
	}
	out.WriteString("]}")
	return out.Bytes(), nil
}

// jsUint8Array is a plain Uint8Array (a bun:sqlite BLOB): JSON.stringify
// writes it as an object keyed by index.
type jsUint8Array []byte

func (b jsUint8Array) MarshalJSON() ([]byte, error) {
	var out bytes.Buffer
	out.WriteByte('{')
	for i, c := range b {
		if i > 0 {
			out.WriteByte(',')
		}
		out.WriteString(`"` + strconv.Itoa(i) + `":` + strconv.Itoa(int(c)))
	}
	out.WriteByte('}')
	return out.Bytes(), nil
}

// column is one result column. index is set when Bun.SQL's server adapters
// make the name an array index property: all ASCII digits and below 2^32-1.
type column struct {
	name    string
	index   uint32
	indexed bool
}

// serverColumn is ColumnIdentifier.init for PostgreSQL and MySQL names.
func serverColumn(name string) column {
	if len(name) >= 1 && len(name) <= 10 {
		var n uint64
		digits := true
		for i := 0; i < len(name); i++ {
			if name[i] < '0' || name[i] > '9' {
				digits = false
				break
			}
			n = n*10 + uint64(name[i]-'0')
		}
		if digits && n < math.MaxUint32 {
			// The property is the number: "007" names index 7.
			return column{name: strconv.FormatUint(n, 10), index: uint32(n), indexed: true}
		}
	}
	return column{name: jsvalue.BufferString([]byte(name))}
}

// sqliteColumn is a bun:sqlite column: every name is a plain property.
func sqliteColumn(name string) column {
	return column{name: jsvalue.BufferString([]byte(name))}
}

// buildRow is the row object: a repeated name keeps its last value at the
// position of its last occurrence, and index properties come first in
// ascending order, as JSON.stringify walks a JavaScript object.
func buildRow(columns []column, values []any) *jsvalue.Object {
	last := map[string]int{}
	for i, c := range columns {
		last[c.name] = i
	}
	var indexed []int
	var named []int
	for i, c := range columns {
		if last[c.name] != i {
			continue
		}
		if c.indexed {
			indexed = append(indexed, i)
		} else {
			named = append(named, i)
		}
	}
	sort.SliceStable(indexed, func(a, b int) bool { return columns[indexed[a]].index < columns[indexed[b]].index })
	row := jsvalue.NewInsertionOrderObject()
	for _, i := range append(indexed, named...) {
		row.Set(columns[i].name, values[i])
	}
	return row
}
