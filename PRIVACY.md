# Privacy Policy for AgentIO

**Last updated**: January 3, 2026

## Overview

AgentIO is a command-line interface (CLI) tool that enables users to interact with their email through the Gmail API. This privacy policy explains how AgentIO handles your data.

## Data Collection and Use

### What AgentIO Accesses

When you authorize AgentIO with your Google account, the application may access:

- **Email messages**: To search, read, and display your emails
- **Email sending**: To send emails on your behalf
- **Draft creation**: To create and manage email drafts

### What AgentIO Stores

AgentIO stores the following data **locally on your device only**:

- **OAuth tokens**: Encrypted authentication tokens that allow AgentIO to access your Gmail account
- **Profile configuration**: Your profile names and settings

**AgentIO does NOT:**
- Store your emails or email content
- Transmit your data to any external servers
- Share your data with third parties
- Collect analytics or usage data

### Data Storage Location

All data is stored locally in:
- `~/.config/agentio/config.json` (profile configuration)
- `~/.config/agentio/tokens.enc` (encrypted OAuth tokens)

Tokens are encrypted using AES-256-GCM with a key derived from your machine's hostname and username.

## Data Security

- OAuth tokens are encrypted at rest using AES-256-GCM encryption
- Encryption keys are derived from machine-specific identifiers
- No data is transmitted to external servers
- All API calls are made directly between your device and Google's servers

## Your Rights

You can at any time:

- **Revoke access**: Remove AgentIO's access to your Google account at [Google Security Settings](https://myaccount.google.com/permissions)
- **Delete local data**: Remove the `~/.config/agentio` directory to delete all stored configuration and tokens
- **Review permissions**: Check what permissions AgentIO has in your Google account settings

## Third-Party Services

AgentIO interacts with the following third-party services:

- **Google Gmail API**: To access your email. Google's privacy policy applies to their handling of your data: [Google Privacy Policy](https://policies.google.com/privacy)

## Open Source

AgentIO is open source software. You can review the source code to verify how your data is handled at: [https://github.com/plosson/agentio](https://github.com/plosson/agentio)

## Contact

For questions about this privacy policy or AgentIO's data practices, please open an issue on the GitHub repository: [https://github.com/plosson/agentio/issues](https://github.com/plosson/agentio/issues)

## Changes to This Policy

Any changes to this privacy policy will be reflected in this document with an updated date. As an open source project, all changes are tracked in the project's git history.
