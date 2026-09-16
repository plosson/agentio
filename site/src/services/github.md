---
name: GitHub
slug: github
auth: OAuth / PAT
tagline: Install agentio secrets to a repo for GitHub Actions runs.
icon: 🐙
order: 70
---

## What you can do

- Install `AGENTIO_KEY` and `AGENTIO_CONFIG` as repo secrets in one command
- Give GitHub Actions workflows a copy of your vault

## Setup

```sh
agentio github profile add
agentio github install <owner/repo>
```
