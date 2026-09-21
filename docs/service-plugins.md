# In-tree service plugins

Agentio services live in self-contained folders under `src/plugins/` instead
of parallel `commands/`, `services/`, and `types/` trees. This is a code
organization boundary for services shipped with Agentio. It does not load
third-party code itself. Developers building a plugin outside this repository
should use the stable declarative contract in [Writing an Agentio plugin](plugin-sdk.md),
not the private in-tree adapter described here.

Every service implements the same contract. OAuth services own their refresh,
redaction, and reauthentication policy. Google services use a provider group so
their OAuth and credential-shape behavior is shared without hiding the
individual CLI plugins:

```text
src/plugins/
├── types.ts             # host/plugin contract
├── registry.ts          # complete ordered plugin catalog
├── credential-lifecycles.ts # lightweight refresh capability lookup
├── google/
│   ├── gcal/              # one self-contained folder per Google service
│   │   ├── index.ts       # ServicePlugin export
│   │   ├── commands.ts
│   │   ├── client.ts
│   │   ├── output.ts
│   │   └── types.ts
│   ├── gchat/             # same layout; may add service-only helpers
│   ├── gdocs/
│   ├── gdrive/
│   ├── gmail/
│   ├── gsheets/
│   ├── gslides/
│   ├── gscript/
│   ├── gtasks/
│   ├── shared.ts          # shared profile lifecycle and reauthentication
│   ├── oauth.ts           # Google scopes and OAuth exchange
│   ├── token-manager.ts   # Google auth client, refresh, and user identity
│   ├── profile-tokens.ts  # profile resolution for snake-case clients
│   ├── tokens.ts          # provider-wide credential shapes
│   └── format.ts          # small presentation helpers shared by services
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
├── confluence/          # OAuth lifecycle owned by the service folder
├── discourse/
├── dropbox/
├── falco/            # password + 2FA login, owned by the service folder
├── github/
├── revolut/
├── sql/
├── telegram/
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

`SERVICE_REGISTRY` is also the canonical command order. Every entry is a
`ServicePlugin`; there are no service-specific registration adapters in the
host. CLI help and generated documentation therefore share the same order.

```ts
const example = defineServicePlugin<Credentials>()({
  apiVersion: 1,
  id: 'example',
  displayName: 'Example',
  description: 'Work with Example resources',
  registerCommands,
  profile: {
    add: exampleProfileAdd,
    createClient: (credentials) => new ExampleClient(credentials),
    reauthenticate: (credentials, profileName) => reauthenticate(credentials, profileName),
  },
  credentialLifecycle: {
    secretFields: ['refreshToken'],
    applies: (credentials): credentials is Credentials => hasRefreshToken(credentials),
    isStale: (credentials, now, bufferMs) => expiresSoon(credentials, now, bufferMs),
    refresh: (credentials) => refresh(credentials),
  },
});
```

The credential type is checked inside the plugin, including client creation,
reauthentication results, refresh inputs and outputs, and secret field names.
The host registry erases it only after the plugin definition has passed those
checks. A plugin without `profile.reauthenticate` receives the generic profile
setup instruction; reauthentication policy is not maintained in a central
service-name list.

`profile` is omitted for services such as RSS that need no stored credentials.
All hooks are optional, so static-token services can adopt the folder layout
without implementing OAuth behavior.

Google plugins are grouped under `plugins/google` rather than nine parallel
top-level folders. Each Google service has its own folder and `ServicePlugin`
entry point. Only provider-wide OAuth, token, lifecycle, profile, and small
formatting helpers remain at the `google/` level. The legacy `commands/`,
`services/`, `types/`, and Google auth paths no longer contain Google service
implementations.

## Adding a service

1. Create `src/plugins/<id>/` and keep its commands, API client, types, output,
   and service-specific setup there.
   Google services instead add `src/plugins/google/<id>/` and reuse only the
   provider-wide helpers from the parent directory.
2. Export a `ServicePlugin` as the folder's default export from `index.ts`.
3. Add one import and one entry to the compile-time list in `registry.ts`.
4. If the service supports refresh, add its lifecycle object to the lightweight
   lookup in `credential-lifecycles.ts`. This lookup is separate from the
   command registry so credential refresh does not import the Commander graph.
5. A new profile-backed service must also be added to `ServiceName` and the
   config profile type until those legacy types are derived from the registry.
6. Run `bun run typecheck`, `bun test`, and `bun run build`.

The explicit registry is deliberate. It makes the bundled and native binaries
include each service through normal static imports, while keeping runtime plugin
loading outside the scope of this architecture.
