package gmail

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strings"

	"github.com/plosson/agentio/go/internal/jsvalue"
	"github.com/plosson/agentio/go/internal/plugins"
)

// subjectMaxLength is Bun SUBJECT_MAX_LENGTH: longer subjects almost always
// mean shell-quoting garbage.
const subjectMaxLength = 500

// composeSpec is Bun ComposeSpec. A nil field is undefined.
type composeSpec struct {
	to, cc, bcc, attachments []string
	subject, body            *string
	html                     *bool
	replyTo                  *string
}

var (
	crlf     = regexp.MustCompile(`[\r\n]`)
	eofCrumb = regexp.MustCompile(`\bEOF\b`)
	// agentioCrumb spells out JavaScript's \s, which RE2's \s narrows to ASCII.
	agentioCrumb = regexp.MustCompile(`(?i)agentio[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+gmail`)
)

// assertSubjectSane is Bun assertSubjectSane: refuse subjects that look like
// mangled shell, heredoc or CLI crumbs.
func assertSubjectSane(subject string, fail plugins.FailFunc) error {
	if n := jsvalue.Length(subject); n > subjectMaxLength {
		return fail("INVALID_PARAMS",
			fmt.Sprintf("Subject is absurdly long (%d chars; max %d).", n, subjectMaxLength),
			"Pass a short --subject, or use --subject-file / --spec with a UTF-8 file instead of shell-quoting a long string.")
	}
	if crlf.MatchString(subject) {
		return fail("INVALID_PARAMS", "Subject contains newlines (likely shell/heredoc quoting garbage).",
			"Use --subject-file <path> or --spec <path.json> so agents do not shell-quote the subject.")
	}
	if strings.Contains(subject, "<<") {
		return fail("INVALID_PARAMS", "Subject contains a heredoc marker (<<). Refusing to create a garbage draft.",
			"Use --subject-file or --spec instead of heredoc/shell quoting for --subject.")
	}
	if eofCrumb.MatchString(subject) {
		return fail("INVALID_PARAMS", `Subject contains shell crumb "EOF". Refusing to create a garbage draft.`,
			"Use --subject-file or --spec instead of heredoc/shell quoting for --subject.")
	}
	if agentioCrumb.MatchString(subject) {
		return fail("INVALID_PARAMS", `Subject contains shell crumb "agentio gmail". Refusing to create a garbage draft.`,
			"Use --subject-file or --spec instead of embedding CLI text in --subject.")
	}
	return nil
}

// readUTF8TextFile is Bun readUtf8TextFile (readFile(path, 'utf-8')).
func readUTF8TextFile(path, label string, fail plugins.FailFunc) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", fail("INVALID_PARAMS", fmt.Sprintf("Failed to read %s: %s", label, path),
			"Check that the file exists and is readable UTF-8 text")
	}
	return jsvalue.BufferString(raw), nil
}

// asStringArray is Bun asStringArray: a string is one trimmed recipient (none
// when blank), an array must hold strings only.
func asStringArray(value any, present bool, field string, fail plugins.FailFunc) ([]string, error) {
	if !present || value == nil {
		return nil, nil
	}
	switch v := value.(type) {
	case string:
		if trimmed := jsvalue.Trim(v); trimmed != "" {
			return []string{trimmed}, nil
		}
		return []string{}, nil
	case []any:
		out := []string{}
		for _, item := range v {
			s, ok := item.(string)
			if !ok {
				return nil, fail("INVALID_PARAMS", fmt.Sprintf(`Spec field "%s" must be a string or array of strings`, field), "")
			}
			out = append(out, s)
		}
		return out, nil
	}
	return nil, fail("INVALID_PARAMS", fmt.Sprintf(`Spec field "%s" must be a string or array of strings`, field), "")
}

// loadComposeSpec is Bun loadComposeSpec, with its checks in Bun's order.
func loadComposeSpec(path string, fail plugins.FailFunc) (*composeSpec, error) {
	raw, err := readUTF8TextFile(path, "spec file", fail)
	if err != nil {
		return nil, err
	}
	var parsed any
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return nil, fail("INVALID_PARAMS", "Invalid JSON in spec file: "+jsvalue.ParseErrorMessage([]byte(raw)),
			"Provide a JSON object with fields like {to, cc, bcc, subject, body, attachments}")
	}
	obj, ok := parsed.(map[string]any)
	if !ok {
		return nil, fail("INVALID_PARAMS", "Spec file must contain a JSON object",
			`Example: {"to":["a@b.com"],"subject":"Hi","body":"Hello"}`)
	}
	field := func(name string) (any, bool) {
		v, ok := obj[name]
		return v, ok
	}
	spec := &composeSpec{}
	v, ok := field("attachments")
	if spec.attachments, err = asStringArray(v, ok, "attachments", fail); err != nil {
		return nil, err
	}
	if spec.attachments == nil {
		v, ok = field("attachment")
		if spec.attachments, err = asStringArray(v, ok, "attachment", fail); err != nil {
			return nil, err
		}
	}
	if s, ok := obj["replyTo"].(string); ok {
		spec.replyTo = &s
	} else if s, ok := obj["reply_to"].(string); ok {
		spec.replyTo = &s
	}
	if v, ok := field("subject"); ok {
		s, isString := v.(string)
		if !isString {
			return nil, fail("INVALID_PARAMS", `Spec field "subject" must be a string`, "")
		}
		spec.subject = &s
	}
	if v, ok := field("body"); ok {
		s, isString := v.(string)
		if !isString {
			return nil, fail("INVALID_PARAMS", `Spec field "body" must be a string`, "")
		}
		spec.body = &s
	}
	if v, ok := field("html"); ok {
		b, isBool := v.(bool)
		if !isBool {
			return nil, fail("INVALID_PARAMS", `Spec field "html" must be a boolean`, "")
		}
		spec.html = &b
	}
	for _, f := range []struct {
		name string
		dst  *[]string
	}{{"to", &spec.to}, {"cc", &spec.cc}, {"bcc", &spec.bcc}} {
		v, ok := field(f.name)
		if *f.dst, err = asStringArray(v, ok, f.name, fail); err != nil {
			return nil, err
		}
	}
	return spec, nil
}

// resolvedText is Bun ResolvedComposeText. An empty subject or body is
// undefined: every later Bun check on them is a falsy one.
type resolvedText struct {
	subject, body string
	// bodyFromFileOrSpec skips the stdin fallback.
	bodyFromFileOrSpec bool
}

// resolveComposeText is Bun resolveComposeText. A nil subject or body is an
// absent flag; a given "" is kept, as Bun checks `!== undefined`.
func resolveComposeText(subject *string, subjectFile string, body *string, bodyFile string, spec *composeSpec, fail plugins.FailFunc) (resolvedText, error) {
	if spec == nil {
		spec = &composeSpec{}
	}
	if subject != nil && subjectFile != "" {
		return resolvedText{}, fail("INVALID_PARAMS", "Cannot use both --subject and --subject-file",
			"Prefer --subject-file for agent-written subjects to avoid shell quoting bugs.")
	}
	if body != nil && bodyFile != "" {
		return resolvedText{}, fail("INVALID_PARAMS", "Cannot use both --body and --body-file",
			"Prefer --body-file (or --body - for stdin) instead of shell-quoting the body.")
	}
	var out resolvedText
	if subject != nil {
		out.subject = *subject
	}
	if body != nil {
		out.body = *body
	}
	if subjectFile != "" {
		text, err := readUTF8TextFile(subjectFile, "subject file", fail)
		if err != nil {
			return resolvedText{}, err
		}
		out.subject = jsvalue.Trim(text)
	} else if subject == nil && spec.subject != nil {
		out.subject = *spec.subject
	}
	if bodyFile != "" {
		text, err := readUTF8TextFile(bodyFile, "body file", fail)
		if err != nil {
			return resolvedText{}, err
		}
		// Drop a single trailing newline that editors commonly append.
		if strings.HasSuffix(text, "\r\n") {
			text = strings.TrimSuffix(text, "\r\n")
		} else {
			text = strings.TrimSuffix(text, "\n")
		}
		out.body = text
		out.bodyFromFileOrSpec = true
	} else if body == nil && spec.body != nil {
		out.body = *spec.body
		out.bodyFromFileOrSpec = true
	}
	if err := assertSubjectSane(out.subject, fail); err != nil {
		return resolvedText{}, err
	}
	return out, nil
}

// sendOptions is Bun GmailSendOptions.
type sendOptions struct {
	to, cc, bcc []string
	subject     string
	body        string
	isHTML      bool
	attachments []attachmentFile
	replyTo     string
}

// attachmentFile is Bun GmailAttachment; a contentID makes it inline.
type attachmentFile struct {
	path, filename, contentID string
}

// parseSendOptions is Bun parseSendOptions: the compose flags, the spec file
// and the stdin fallback for the body, checked in Bun's order.
func parseSendOptions(in plugins.CommandInput, fail plugins.FailFunc) (*sendOptions, error) {
	var spec *composeSpec
	if path := in.Option("spec"); path != "" {
		var err error
		if spec, err = loadComposeSpec(path, fail); err != nil {
			return nil, err
		}
	}
	given := func(name string) *string {
		if value, ok := in.LookupOption(name); ok {
			return &value
		}
		return nil
	}
	resolved, err := resolveComposeText(given("subject"), in.Option("subject-file"), given("body"), in.Option("body-file"), spec, fail)
	if err != nil {
		return nil, err
	}
	if spec == nil {
		spec = &composeSpec{}
	}
	pick := func(flag, fromSpec []string) []string {
		if len(flag) > 0 {
			return flag
		}
		if fromSpec != nil {
			return fromSpec
		}
		return []string{}
	}
	to := pick(in.List("to"), spec.to)
	cc := pick(in.List("cc"), spec.cc)
	bcc := pick(in.List("bcc"), spec.bcc)
	attachmentPaths := pick(in.List("attachment"), spec.attachments)

	replyTo := in.Option("reply-to")
	if replyTo == "" && spec.replyTo != nil {
		replyTo = *spec.replyTo
	}
	if replyTo == "" {
		if len(to) == 0 {
			return nil, fail("INVALID_PARAMS", "--to is required (unless using --reply-to)", "")
		}
		if resolved.subject == "" {
			return nil, fail("INVALID_PARAMS", "--subject is required (unless using --reply-to)", "Use --subject, --subject-file, or --spec")
		}
	}

	body := resolved.body
	if !resolved.bodyFromFileOrSpec && (body == "" || body == "-") {
		body = plugins.Stdin(in)
	}
	if body == "" {
		return nil, fail("INVALID_PARAMS", "Body is required. Use --body, --body-file, --spec, or pipe via stdin.", "")
	}

	var attachments []attachmentFile
	for _, path := range attachmentPaths {
		attachments = append(attachments, attachmentFile{path: path, filename: basename(path)})
	}
	for _, spec := range in.List("inline") {
		i := strings.Index(spec, ":")
		if i < 0 {
			return nil, fail("INVALID_PARAMS", "Invalid inline format: "+spec, "Use format: contentId:filepath (e.g., logo:./logo.png)")
		}
		path := spec[i+1:]
		attachments = append(attachments, attachmentFile{path: path, filename: basename(path), contentID: spec[:i]})
	}

	isHTML := in.Flag("html") || (spec.html != nil && *spec.html)
	return &sendOptions{
		to: to, cc: cc, bcc: bcc,
		subject:     resolved.subject,
		body:        body,
		isHTML:      isHTML,
		attachments: attachments,
		replyTo:     replyTo,
	}, nil
}

// basename is Node path.basename: trailing slashes dropped, "" for the root.
func basename(path string) string {
	path = strings.TrimRight(path, "/")
	if i := strings.LastIndex(path, "/"); i >= 0 {
		return path[i+1:]
	}
	return path
}
