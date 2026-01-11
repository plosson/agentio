---
description: Update the README.md with recent changes
---

Review the current README.md and update it to reflect recent changes to the codebase.

Guidelines:
- Make minimal changes to the existing structure
- Extend existing sections rather than rewriting them
- Match the existing tone and formatting style
- Only add documentation for features that are actually implemented
- Update the Services table if new services were added
- Add usage examples for new commands following the existing example patterns
- Do not remove or significantly restructure existing content

To understand recent changes, check:
1. git log --oneline -20 for recent commits
2. src/commands/*.ts for available commands
3. src/index.ts for registered services

Command discovery (IMPORTANT - do not skip):
- Run `agentio --help` to list all top-level commands
- For each service command, run `agentio <service> --help` to list all subcommands
- Compare the --help output against what's documented in README.md
- This ensures no commands are missed

Focus on documenting what exists, not aspirational features.
