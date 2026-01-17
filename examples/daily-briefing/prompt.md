# Daily Email Briefing

Generate a morning briefing from my unread emails and post it to Slack.

## Instructions

1. **Fetch unread emails** from the last 24 hours using the agentio-gmail skill
   - Use query: `is:unread newer_than:1d`
   - Limit to 50 emails

2. **Analyze and categorize** each email:
   - **Urgent**: Requires action today
   - **Important**: Should read, but not time-sensitive
   - **FYI**: Informational, can skim or skip

3. **Generate a briefing** with this structure:
   ```
   Morning Briefing - [Date]

   URGENT (X emails)
   - [Sender]: [Subject] - [One-line summary]

   IMPORTANT (X emails)
   - [Sender]: [Subject] - [One-line summary]

   FYI (X emails)
   - [Sender]: [Subject] - [One-line summary]

   Total: X unread emails
   ```

4. **Send to Slack** using the agentio-slack skill

## Constraints

- Keep summaries to one line each
- No emojis
- If no unread emails, send "No unread emails in the last 24 hours"
