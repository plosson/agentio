package jsvalue

import (
	"strings"
	"testing"
)

// Member reads and TypeErrors as JavaScriptCore reports them (probed with
// Bun: `null.x` → "null is not an object (evaluating 'a.b.x')").
func TestPathThrowsWhereJavaScriptDoes(t *testing.T) {
	root := mustObject(t, `{"a":{"b":null,"c":{"d":1},"e":[1,2]}}`)
	cases := []struct {
		keys []string
		want any
		err  string
	}{
		{[]string{"a", "c", "d"}, "1", ""},
		{[]string{"a", "x"}, Undefined, ""},
		{[]string{"a", "x", "y"}, nil, "undefined is not an object (evaluating 'data.a.x.y')"},
		{[]string{"a", "b", "y"}, nil, "null is not an object (evaluating 'data.a.b.y')"},
		{[]string{"a", "b"}, nil, ""},
		{[]string{"a", "c", "d", "z"}, Undefined, ""}, // a number's member
		{[]string{"a", "e", "length"}, "2", ""},
	}
	for _, c := range cases {
		got, err := Path(root, "data", c.keys...)
		if c.err != "" {
			if err == nil || err.Error() != c.err {
				t.Errorf("%v: err %v, want %q", c.keys, err, c.err)
			}
			continue
		}
		if err != nil {
			t.Errorf("%v: %v", c.keys, err)
			continue
		}
		if s, ok := c.want.(string); ok {
			if String(got) != s {
				t.Errorf("%v: %v", c.keys, got)
			}
		} else if got != c.want {
			t.Errorf("%v: %#v, want %#v", c.keys, got, c.want)
		}
	}
	if _, err := Path(nil, "(await this.request())", "values"); err == nil || err.Error() != "null is not an object (evaluating '(await this.request()).values')" {
		t.Error(err)
	}
}

func TestItemsIsTheReceiverOfMap(t *testing.T) {
	if _, err := Items(Undefined, "data.list"); err == nil || err.Error() != "undefined is not an object (evaluating 'data.list.map')" {
		t.Error(err)
	}
	if _, err := Items(nil, "data.list"); err == nil || err.Error() != "null is not an object (evaluating 'data.list.map')" {
		t.Error(err)
	}
	items, err := Items([]any{nil, "x"}, "l")
	if err != nil || len(items) != 2 {
		t.Error(items, err)
	}
}

// undefined interpolates as "undefined", is left out of an object by
// JSON.stringify and is null in an array.
func TestUndefinedIsJavaScripts(t *testing.T) {
	if String(Undefined) != "undefined" || Truthy(Undefined) || !Nullish(Undefined) || !Nullish(nil) || Nullish("") {
		t.Fatal("undefined")
	}
	o := NewObject()
	o.Set("a", Undefined)
	o.Set("b", nil)
	o.Set("c", []any{Undefined, 1})
	if got := string(Stringify(o)); got != `{"b":null,"c":[null,1]}` {
		t.Fatal(got)
	}
}

// StrictEqual is ===: same type and value; numbers by value.
func TestStrictEqual(t *testing.T) {
	one, _ := Parse([]byte("1.0"))
	obj := NewObject()
	for _, c := range []struct {
		a, b any
		want bool
	}{
		{"x", "x", true}, {"1", one, false}, {one, 1.0, true}, {nil, Undefined, false},
		{Undefined, Undefined, true}, {nil, nil, true}, {true, true, true}, {obj, obj, true}, {obj, NewObject(), false},
	} {
		if StrictEqual(c.a, c.b) != c.want {
			t.Errorf("%#v === %#v", c.a, c.b)
		}
	}
}

func TestOptionalIsOptionalChaining(t *testing.T) {
	o := mustObject(t, `{"a":{"b":0}}`)
	if Optional(nil, "x") != Undefined || Optional(Undefined, "x") != Undefined || String(Optional(Member(o, "a"), "b")) != "0" || Optional(o, "z") != Undefined {
		t.Fatal("optional")
	}
}

func TestSpreadIsObjectSpread(t *testing.T) {
	for raw, want := range map[string]string{
		`{"b":1,"a":[2]}`: `{"b":1,"a":[2]}`,
		`[1,"x"]`:         `{"0":1,"1":"x"}`,
		`"ab"`:            `{"0":"a","1":"b"}`,
		`null`:            `{}`,
		`5`:               `{}`,
	} {
		v, _ := Parse([]byte(raw))
		if got := string(Stringify(Spread(v))); got != want {
			t.Errorf("%s: %s", raw, got)
		}
	}
}

// Keys and Stringify follow JavaScript's own-property order: array-index
// keys (canonical integers below 2^32-1) first, ascending, then the others in
// insertion order. Probed with Bun: JSON.stringify(JSON.parse(raw)).
func TestObjectKeysFollowJavaScriptOrder(t *testing.T) {
	o := mustObject(t, `{"b":1,"2":1,"a":1,"1":1,"01":1,"4294967295":1,"4294967294":1,"-1":1,"1.5":1}`)
	want := `{"1":1,"2":1,"4294967294":1,"b":1,"a":1,"01":1,"4294967295":1,"-1":1,"1.5":1}`
	if got := string(Stringify(o)); got != want {
		t.Fatalf("%s", got)
	}
	if got := strings.Join(o.Keys(), ","); got != "1,2,4294967294,b,a,01,4294967295,-1,1.5" {
		t.Fatalf("%s", got)
	}
}

func TestInsertionOrderObjectKeepsIntegerKeysInPlace(t *testing.T) {
	o := NewInsertionOrderObject()
	for _, k := range []string{"8", "2", "b", "3", ""} {
		o.Set(k, 1)
	}
	if got := string(Stringify(o)); got != `{"8":1,"2":1,"b":1,"3":1,"":1}` {
		t.Fatal(got)
	}
}
