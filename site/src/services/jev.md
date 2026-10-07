---
name: Jev
slug: jev
auth: API Key
tagline: Get a typed decision about some text, as yes or no, one option from a set, or a score.
icon: ⚖️
order: 50
---

## What you can do

- Ask a yes/no question and get the answer with its probability, and an exit code for scripts
- Pick one option from a set you describe
- Place the input on a scale you describe, such as how severe a bug is

## Setup

Create a key at console.typesafe.ai, under Settings, then Keys. Then:

```sh
agentio jev profile add
```

agentio asks for the key and checks it with one short question.

## Good to know

- The input to evaluate comes from stdin, or from `--state`. Input that is JSON is sent as JSON.
- `yesno` exits with 0 for yes, 1 for no, and 2 or more for an error. `--threshold` sets the probability of yes at which the answer is yes (default 0.5).
- `--json` prints the answer with the model and usage.
