// Package lines reads answers from stdin one line at a time, for every prompt
// in the process. A reader per question would buffer past its own line, and
// piped answers meant for the next questions would be lost with it.
package lines

import (
	"bufio"
	"context"
	"io"
	"os"
	"sync"
)

type result struct {
	line string
	err  error
}

// Reader hands out lines to one caller at a time. A read that its caller gave
// up on (see ReadLine) is not lost: its line goes to the next caller.
type Reader struct {
	br      *bufio.Reader
	mu      sync.Mutex
	pending chan result
}

var (
	filesMu sync.Mutex
	files   = map[*os.File]*Reader{}
)

// For returns the Reader for r. A file, os.Stdin above all, gets one Reader
// for the life of the process, whoever asks.
func For(r io.Reader) *Reader {
	f, ok := r.(*os.File)
	if !ok {
		return &Reader{br: bufio.NewReader(r)}
	}
	filesMu.Lock()
	defer filesMu.Unlock()
	if files[f] == nil {
		files[f] = &Reader{br: bufio.NewReader(f)}
	}
	return files[f]
}

// ReadLine returns the next line, with its newline, as bufio.Reader.ReadString
// does. When ctx ends first it returns ctx.Err() and leaves the line, once it
// arrives, to the next ReadLine.
func (r *Reader) ReadLine(ctx context.Context) (string, error) {
	r.mu.Lock()
	ch := r.pending
	if ch == nil {
		ch = make(chan result, 1)
		r.pending = ch
		go func() {
			line, err := r.br.ReadString('\n')
			ch <- result{line, err}
		}()
	}
	r.mu.Unlock()
	select {
	case res := <-ch:
		if ctx.Err() != nil {
			ch <- res // given up already: the line is the next caller's
			return "", ctx.Err()
		}
		r.mu.Lock()
		if r.pending == ch {
			r.pending = nil
		}
		r.mu.Unlock()
		return res.line, res.err
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

// Waiting reports whether a read is already in flight, so a caller that would
// read the terminal directly (a hidden password) takes that line instead.
func (r *Reader) Waiting() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.pending != nil
}
