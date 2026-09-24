package slack

// formatSendResult is Bun printSlackSendResult.
func formatSendResult(v any) string {
	r, _ := v.(*sendResult)
	if r == nil {
		return ""
	}
	if r.IsJSONPayload {
		return "Message sent\nType: Block Kit payload"
	}
	return "Message sent"
}
