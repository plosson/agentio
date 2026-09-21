# Writing an Agentio plugin

Agentio can load trusted TypeScript or JavaScript service plugins without a
change to Agentio itself. The public plugin contract is declarative: plugins
describe commands and return data, while Agentio owns profile selection,
encrypted credential persistence, refresh, read-only enforcement, JSON output,
help, and error rendering.

> External plugins run in the Agentio process with the user's permissions.
> Install and load only code you trust. Set `AGENTIO_SAFE_MODE=1` to disable all
> external plugin loading.

## Minimal plugin

```ts
import type { AgentioPlugin } from '@plosson/agentio/plugin-sdk';

interface Credentials {
  token: string;
}

const plugin: AgentioPlugin<Credentials> = {
  apiVersion: 1,
  id: 'acme-tasks',
  displayName: 'Acme Tasks',
  description: 'Work with Acme tasks',

  profile: {
    async setup(_options, context) {
      const token = await context.prompt('API token', { secret: true });
      return {
        credentials: { token },
        suggestedProfileName: 'default',
      };
    },

    async validate(context) {
      const response = await context.fetch('https://tasks.example.test/me', {
        headers: { authorization: `Bearer ${context.credentials.token}` },
        signal: context.signal,
      });
      return response.ok
        ? { valid: true }
        : { valid: false, error: `HTTP ${response.status}` };
    },
  },

  commands: [{
    path: 'tasks list',
    description: 'List tasks',
    options: [{ flags: '--limit <number>', description: 'Maximum results', defaultValue: '20' }],
    access: 'read',
    examples: ['agentio acme-tasks tasks list --limit 10'],
    async run(input, context) {
      const response = await context.fetch(
        `https://tasks.example.test/tasks?limit=${input.options.limit}`,
        {
          headers: { authorization: `Bearer ${context.credentials.token}` },
          signal: context.signal,
        },
      );
      if (!response.ok) context.fail('API_ERROR', `Acme returned HTTP ${response.status}`);
      return response.json();
    },
  }],
};

export default plugin;
```

Load a file, or every `.ts`, `.js`, and `.mjs` file directly inside a plugin
directory, with the platform path separator (`:` on macOS/Linux, `;` on
Windows):

```sh
AGENTIO_PLUGIN_PATHS=/absolute/path/acme.ts agentio --help
AGENTIO_PLUGIN_PATHS=/absolute/path/private-plugins agentio acme-tasks tasks list
```

The module must export the plugin as `default` or as a named `plugin` export.
Plugin IDs use lowercase letters, digits, and hyphens, must begin with a letter,
and cannot collide with another loaded plugin.

## Host/plugin boundary

Plugin code should only import the types from `@plosson/agentio/plugin-sdk`.
It must not import Agentio's `src/` modules or Commander.

- `profile.setup` obtains service credentials and returns them. Agentio chooses
  the final profile name and stores the credentials in the encrypted vault.
- `profile.validate` powers `agentio status`.
- `profile.reauthenticate` may replace expired credentials; Agentio persists
  the result.
- `profile.refresh` declares refresh behavior and the secret fields the hub
  must strip before sending credentials to a remote agent.
- A command declares `access: 'write'` when it can mutate remote state. Agentio
  refuses it for read-only profiles before plugin code runs. Omitted access is
  treated as read-only behavior.
- Command handlers return structured data. Agentio prints JSON for `--json` and
  otherwise uses `format` when supplied.
- Use `context.log` for progress and `context.fail` for stable, user-facing
  errors. Do not print results or terminate the process from a plugin.

In-process plugins are a compatibility boundary, not a security sandbox. The
host API prevents accidental vault and CLI coupling, but JavaScript code can
still use normal Bun APIs.

## Input and command shape

`path` is the command path below the plugin ID. Arguments appear in
`input.args`, options in `input.options`, and declared stdin in `input.stdin`.
Agentio adds `--profile` to profile-backed commands and `--json` to all plugin
commands. Every command must include at least one complete example.

Use `input: 'text'` for raw stdin or `input: 'json'` for host-parsed JSON.
Invalid JSON is reported consistently before the handler runs.

## Refreshable credentials

When a service rotates short-lived tokens, declare all fields that must never be
sent by the hub:

```ts
refresh: {
  secretFields: ['refreshToken'],
  applies(value): value is Credentials {
    return typeof value === 'object' && value !== null && 'refreshToken' in value;
  },
  isStale(credentials, now, bufferMs) {
    return credentials.expiresAt <= now + bufferMs;
  },
  async run(credentials) {
    // Exchange refreshToken and return the complete replacement object.
    return refreshedCredentials;
  },
}
```

The host serializes concurrent refreshes per profile and persists the returned
credentials. A refreshable plugin with no `secretFields` is rejected at load
time.

## Compatibility

The current contract uses `apiVersion: 1`. Agentio rejects unsupported versions
and malformed or duplicate registrations before building the command tree.
Bundled legacy plugins may still use Agentio's internal Commander adapter while
they migrate; external plugins cannot use that private escape hatch.
