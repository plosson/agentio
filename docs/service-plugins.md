# In-tree service plugins

Agentio services are moving from parallel `commands/`, `services/`, and
`types/` trees to self-contained folders under `src/plugins/`. This is a code
organization boundary for services shipped with Agentio. It does not load
third-party code or discover plugins at runtime.

RSS and Slack are the first layout examples. Jira validates the lifecycle
boundary needed by an OAuth service. Google services use a provider group so
their OAuth and credential-shape behavior is shared without hiding the
individual CLI plugins:

```text
src/plugins/
├── types.ts             # host/plugin contract
├── registry.ts          # ordered catalog for migrated and legacy services
├── credential-lifecycles.ts # lightweight refresh capability lookup
├── google/
│   ├── shared.ts          # shared profile lifecycle and reauthentication
│   ├── oauth.ts           # Google scopes and OAuth exchange
│   ├── token-manager.ts   # Google auth client, refresh, and user identity
│   ├── profile-tokens.ts  # profile resolution for snake-case clients
│   ├── gcal.ts            # one ServicePlugin per top-level command
│   ├── gchat.ts
│   ├── gdocs.ts
│   ├── gdrive.ts
│   ├── gmail.ts
│   ├── gsheets.ts
│   ├── gslides.ts
│   ├── gscript.ts
│   └── gtasks.ts
├── jira/
│   ├── index.ts
│   ├── commands.ts
│   ├── client.ts
│   ├── lifecycle.ts     # refresh, expiry, redaction, and reauthentication
│   ├── oauth.ts
│   ├── output.ts
│   └── types.ts
├── rss/
│   ├── index.ts         # one ServicePlugin export
│   ├── commands.ts
│   ├── client.ts
│   ├── output.ts
│   └── types.ts
└── slack/
    ├── index.ts
    ├── commands.ts
    ├── client.ts
    ├── output.ts
    └── types.ts
```

## Contract

Every plugin exports one object created with `defineServicePlugin`. The object
provides stable metadata and a Commander registration function. A service that
stores profiles also provides `profile.add` and `profile.createClient`; the host
uses these hooks for the global `profile add` and `status` commands.

An OAuth plugin can also expose `profile.reauthenticate` and
`credentialLifecycle`. The plugin owns its credential shape, expiry rule,
refresh exchange, and list of fields that remote agents must not receive. The
host still owns vault reads and writes, refresh serialization, and consistent
CLI error mapping. A reauthentication hook therefore receives the current
credentials and returns their replacement instead of writing the vault itself.

`SERVICE_REGISTRY` is also the canonical command order. Unmigrated services
occupy their eventual position through lightweight adapters. Migrating one
replaces its adapter in place, so CLI help and generated documentation do not
move merely because implementation files moved.

```ts
const example = defineServicePlugin({
  apiVersion: 1,
  id: 'example',
  displayName: 'Example',
  description: 'Work with Example resources',
  registerCommands,
  profile: {
    add: exampleProfileAdd,
    createClient: (credentials) => new ExampleClient(credentials as Credentials),
    reauthenticate: (credentials, profileName) => reauthenticate(credentials, profileName),
  },
  credentialLifecycle: {
    secretFields: ['refreshToken'],
    applies: (credentials) => hasRefreshToken(credentials),
    isStale: (credentials, now, bufferMs) => expiresSoon(credentials, now, bufferMs),
    refresh: (credentials) => refresh(credentials),
  },
});
```

`profile` is omitted for services such as RSS that need no stored credentials.
All hooks are optional, so static-token services can adopt the folder layout
without implementing OAuth behavior.

Google plugins are grouped under `plugins/google` rather than nine parallel
top-level folders. Each file represents one top-level CLI command and reuses
the shared snake-case or camel-case credential lifecycle. Compatibility
facades keep the former `auth/oauth` and `auth/token-manager` imports valid.
The large command implementations can move behind these plugin files
incrementally without changing registration or profile behavior again.

## Adding or migrating a service

1. Create `src/plugins/<id>/` and keep its commands, API client, types, output,
   and service-specific setup there.
   Google services instead add one `src/plugins/google/<id>.ts` entry and reuse
   the provider helpers in that directory.
2. Export a `ServicePlugin` as the folder's default export from `index.ts`.
3. Add one import and one entry to the compile-time list in `registry.ts`.
4. If the service supports refresh, add its lifecycle object to the lightweight
   lookup in `credential-lifecycles.ts`. This lookup is separate from the
   command registry so credential refresh does not import the Commander graph.
5. A new profile-backed service must also be added to `ServiceName` and the
   config profile type until those legacy types are derived from the registry.
6. For a migration, leave re-export files at old import paths until all callers
   have moved. This keeps each service migration independent and reversible.
7. Run `bun run typecheck`, `bun test`, and `bun run build`.

The explicit registry is deliberate. It makes the bundled and native binaries
include each service through normal static imports, while keeping runtime plugin
loading outside the scope of this architecture.
