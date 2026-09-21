# External service plugins

Status: proposal  
Target: post-3.1  
Scope: public plugin contract, host integration, distribution, trust, and migration  

## Summary

Agentio already models its bundled services as plugins, but the current plugin
layer is an in-tree organization boundary. Every service is statically imported
by `src/plugins/registry.ts`, profile-backed service IDs are enumerated in
`src/types/config.ts`, and command implementations import host internals such as
the vault-backed profile store, error mapper, profile resolver, and read-only
guard.

The goal is to let another developer implement and distribute a service without
editing the Agentio repository, while retaining the capabilities that make an
Agentio integration valuable:

- encrypted, multi-profile credential storage;
- remote credential brokering through the hub;
- refresh-token rotation and redaction;
- profile-level read-only enforcement;
- status validation and reauthentication;
- generated CLI help, command documentation, and agent skills;
- deterministic bundled and native builds.

The recommended product model is a stable, declarative plugin SDK combined with
compile-time composition for production. Trusted runtime loading should exist as
a development and private-plugin workflow. A no-code manifest format can cover
simple HTTP services safely. Subprocess or WASM plugins should be deferred until
there is demonstrated demand for untrusted or non-TypeScript extensions.

## Goals

1. A third party can author a service in a separate repository and test it
   without importing private Agentio modules.
2. One plugin declaration drives CLI registration, profile management, status,
   credential refresh, remote redaction, help, docs, skills, and UI metadata.
3. The host, not plugin handlers, enforces vault ownership, profile selection,
   remote-mode rules, and read-only access.
4. Existing built-in services continue to work while they migrate incrementally.
5. Production plugin sets are versioned, reproducible, and inspectable.
6. Vaults preserve profiles belonging to plugins that are temporarily absent.
7. The hub never exposes credentials for an unknown plugin when it cannot prove
   that refresh material will be redacted.

## Non-goals

- Running arbitrary third-party JavaScript safely in-process.
- Migrating every existing service to declarative commands in one change.
- Supporting every language in the first release.
- Designing a general package marketplace before the contract is proven.
- Providing binary compatibility between arbitrary Agentio and plugin versions.
- Making Commander.js itself part of the public plugin API.

## Current state

### What is already in place

`ServicePlugin` provides a useful internal service boundary:

- stable metadata (`apiVersion`, `id`, `displayName`, and `description`);
- command registration;
- profile creation and client validation hooks;
- optional reauthentication;
- optional credential refresh and secret-field declarations.

`SERVICE_REGISTRY` is the ordered command catalog. The CLI, global profile
command, status command, and skill generator already consult the registry. This
means much of the host-side projection work has already been consolidated.

The vault credential store is already indexed by arbitrary strings at runtime,
even though the public TypeScript APIs narrow those strings to `ServiceName`.
Vault writes clone and rewrite the complete payload, so unknown keys can be
preserved if code avoids reconstructing `profiles` from a closed service list.

### Remaining closed-world assumptions

1. `src/plugins/registry.ts` directly imports every plugin.
2. `Config.profiles`, `ServiceName`, and `ALL_SERVICES` enumerate profile-backed
   services manually.
3. `src/daemon/http.ts` rejects profile routes for IDs outside `ALL_SERVICES`.
4. `src/plugins/credential-lifecycles.ts` is a second hard-coded registry.
5. Admin UI names and icons are maintained in a JavaScript table.
6. `ProfilePlugin.add()` returns `void`, so implementations write profiles and
   credentials themselves.
7. `registerCommands(Command)` exposes Commander and lets handlers bypass host
   policy accidentally.
8. Most commands print directly and manually implement JSON/stdin/error behavior,
   so the host cannot project them consistently onto other interfaces.
9. The npm package has no documented, versioned plugin export surface.

## Design principles

### Separate the contract from the loader

The shape of a plugin should not depend on whether it is:

- bundled in the Agentio repository;
- selected by a custom-build recipe;
- loaded from a trusted local directory;
- constructed from a declarative manifest; or
- represented by a subprocess adapter.

All loaders must produce the same validated plugin descriptor. Host features
then operate on the descriptor rather than on loader-specific state.

### The host owns policy and persistence

A plugin may authenticate against its service and return credentials, but it
must not receive a vault handle or write credentials directly. The host owns:

- choosing and validating the profile name;
- storing and updating credentials atomically;
- resolving local or remote profiles;
- refreshing credentials under the per-profile mutex;
- stripping secret fields before remote delivery;
- enforcing effective read-only state;
- mapping failures to stable CLI/API error codes.

### Commands return data

Plugin handlers should return structured values. Human formatting is optional
plugin presentation logic; JSON output is a host capability. This makes a single
command definition reusable for CLI help, `agentio docs`, generated skills, and
potential future HTTP or tool projections.

### Same-process code is trusted code

A types-only SDK and injected context provide compatibility and reduce accidental
coupling, but they are not a sandbox. A JavaScript plugin running in the Agentio
process can import filesystem and network APIs, inspect environment variables,
and act with the user's permissions. Compile-time and runtime in-process plugins
must therefore be documented as fully trusted.

Declarative manifests avoid arbitrary code execution. Subprocesses reduce access
to in-process memory but are not a strong security boundary by themselves when
they run as the same OS user. Truly untrusted plugins require an OS sandbox,
container, or capability-constrained runtime such as WASI.

## Proposed public contract

Publish a types-only package such as `@agentio/plugin-sdk`. It must have no
runtime dependency on Agentio or Commander. Plugin packages may use their own
runtime dependencies normally.

The following is illustrative rather than a final API:

```ts
export interface AgentioPlugin<Credentials extends object = Record<string, unknown>> {
  readonly apiVersion: 1;
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly brand?: {
    color?: string;
    iconPath?: string;
  };
  readonly profile?: ProfileSpec<Credentials>;
  readonly commands: readonly CommandSpec<Credentials>[];
}

export interface ProfileSpec<Credentials extends object> {
  setup(ctx: SetupContext): Promise<{
    credentials: Credentials;
    suggestedProfileName: string;
  }>;
  validate(ctx: RunContext<Credentials>): Promise<ValidationResult>;
  reauthenticate?(
    existing: Credentials | null,
    ctx: SetupContext,
  ): Promise<Credentials>;
  refresh?: {
    readonly secretFields: readonly Extract<keyof Credentials, string>[];
    applies(credentials: unknown): credentials is Credentials;
    isStale(credentials: Credentials, now: number, bufferMs: number): boolean;
    run(credentials: Credentials): Promise<Credentials>;
  };
}

export interface CommandSpec<Credentials extends object> {
  readonly path: string;
  readonly description: string;
  readonly arguments?: readonly ArgumentSpec[];
  readonly options?: readonly OptionSpec[];
  readonly input?: 'none' | 'text' | 'json';
  readonly access?: 'read' | 'write';
  readonly examples: readonly string[];
  run(input: CommandInput, ctx: RunContext<Credentials>): Promise<unknown>;
  format?(value: unknown, output: OutputWriter): void;
}
```

`RunContext` should expose only stable host capabilities:

- the selected profile name;
- that profile's fresh credentials;
- an abort signal;
- a host HTTP helper with common error mapping and rate-limit behavior;
- stderr logging/progress helpers;
- typed failure construction;
- output helpers for tables, records, text, and binary files where appropriate.

`SetupContext` should provide prompting, browser opening, OAuth callback support,
HTTP, and typed failures. Setup returns credentials; it never persists them.

### Compatibility escape hatch

Keep the current `registerCommands(program)` mechanism as a legacy adapter for
built-in services. It allows gradual migration and accommodates unusually complex
commands. It is not part of the default third-party contract because it:

- couples plugins to Commander;
- exposes mutable command-tree internals;
- cannot guarantee uniform JSON/stdin behavior;
- cannot centrally enforce write access;
- is harder to project onto future interfaces.

If a trusted external plugin escape hatch is eventually necessary, it should be
named and documented explicitly, for example `unsafeRegisterCommands`.

## Registry model

Introduce a registry instance rather than importing global arrays throughout the
host. Conceptually:

```ts
const registry = createPluginRegistry([
  ...builtInPlugins,
  ...loadedPlugins,
]);
```

The registry is responsible for:

- validating API versions and service IDs;
- rejecting duplicate plugin and command IDs;
- exposing ordered plugins;
- finding profile-capable plugins;
- finding credential lifecycles;
- exposing UI and documentation metadata;
- recording plugin source, package version, and integrity information;
- lazily activating command code where useful.

The CLI should receive the registry explicitly. This will likely make program
creation asynchronous once runtime loaders are introduced. Compile-time builds
can still construct the same registry from a generated static import list.

To keep the daemon from importing the full command graph, plugin packages may
separate a lightweight descriptor/auth entry point from command activation, or
the contract can support lazy command loading. There must still be one logical
registry rather than a manually synchronized refresh map.

## Service IDs and persistence

Dynamic plugin IDs cannot participate in a compile-time union. Use a validated
string or branded `ServiceId` at persistence and protocol boundaries. A separate
`BuiltInServiceId` union may still be derived from built-in descriptors for code
that specifically needs it.

Change profile storage conceptually to:

```ts
interface Config {
  profiles: Record<string, ProfileValue[] | undefined>;
  apiKeys?: ApiKey[];
}
```

Do not assume that every CLI plugin has profiles. Global profile commands should
enumerate `registry.profilePlugins()`, while help/docs may enumerate every plugin.

Third-party package names should be namespaced. Preserve CLI-safe IDs by using a
form such as `acme-linear`, while reserving bare IDs for Agentio-maintained
services. The registry must reject collisions before any commands or profiles are
used. IDs must remain safe as CLI commands, URL path segments, and the left side
of `service/profile` API-key scopes.

Every vault operation must preserve unknown service entries. Tests must cover a
vault containing a plugin profile, opening it with a build that lacks that
plugin, performing an unrelated write, and later reopening it with the plugin
without data loss.

## Hub behavior and plugin skew

The hub and remote CLI may have different plugin sets. Define the behavior
explicitly:

- Profile listings may include an unknown plugin ID so data remains visible.
- A client without that plugin ignores it for command registration and status
  validation, but may show it as unsupported.
- A client plugin cannot use a profile that the hub does not store.
- The hub must not return credentials for a plugin it does not recognize.
- Refreshable plugins must be installed on the hub so the hub can refresh and
  redact their credentials.
- Unknown plugin data remains preserved in the vault even when it cannot be
  served.

Failing closed is necessary because an unknown credential shape may contain a
refresh token. Treating all unknown plugins as static credentials would risk
returning refresh material to a remote agent.

Contract and protocol errors should identify the missing plugin or unsupported
API version and distinguish them from a missing profile.

## Distribution options

### Option A: in-tree contributions

Developers add a plugin folder and submit a pull request. This is already close
to the current model.

Pros:

- smallest implementation and operational cost;
- deterministic native binaries;
- code is reviewed with Agentio;
- one dependency graph and test matrix;
- simplest security and support story.

Cons:

- no independent release cadence;
- Agentio maintainers become the integration gatekeepers;
- every service increases the default binary and dependency graph;
- not truly third-party installation.

Use this as the first supported authoring path and as the proving ground for the
public contract.

### Option B: compile-time composition

A recipe selects versioned plugin packages. A build command resolves and locks
them, validates their descriptors, generates a static registry, and invokes the
normal Bun native build.

Example:

```json
{
  "agentio": "3.1.0",
  "plugins": {
    "@acme/agentio-linear": "1.2.0"
  }
}
```

Pros:

- deterministic startup and command surface;
- compatible with Agentio's single-file binary distribution;
- dependency versions can be pinned and integrity-checked;
- no runtime discovery or missing-package failures;
- the resulting artifact can report exactly what it contains.

Cons:

- adding or updating a plugin requires rebuilding;
- users need Bun, a template repository, or a hosted builder;
- third-party code remains trusted and runs in-process;
- build caching, signing, and provenance require product work.

This is the recommended production distribution model.

Possible delivery shapes, in increasing operational complexity:

1. Local `agentio build --with <package>` for developers with Bun.
2. A template repository whose CI publishes platform binaries.
3. A hosted builder keyed by the hash of the resolved recipe and lockfile.

`agentio doctor` should print the recipe hash, plugin IDs, package versions, and
integrity information.

### Option C: trusted runtime loading

Load explicit package paths or plugin directories during startup. Do not scan
global package directories implicitly. Plugin locations and expected versions
should live in an inspectable config or lockfile.

Pros:

- fastest plugin-development loop;
- private plugins can be updated without rebuilding Agentio;
- familiar install/remove experience;
- can load TypeScript directly under Bun.

Cons:

- plugins have the user's full in-process privileges;
- startup becomes asynchronous and can fail because of plugin code;
- dependency resolution and version skew become runtime concerns;
- native executable behavior needs a supported compatibility matrix;
- a broken plugin can prevent CLI startup unless loading is isolated carefully.

Position this as a trusted development/private-plugin feature. A safe-mode flag
must allow Agentio to start without external plugins so users can diagnose or
remove a broken plugin.

### Option D: declarative HTTP manifests

Represent common services as validated JSON or YAML: authentication scheme,
probe request, commands, request templates, pagination, response extraction, and
table columns. The host interprets the manifest as a normal plugin descriptor.

Pros:

- no arbitrary plugin code;
- simple to author and review;
- portable across build and runtime loaders;
- automatically receives host policy, JSON output, docs, and skills;
- good fit for bearer-token, API-key, webhook, and straightforward OAuth APIs.

Cons:

- requires a carefully versioned schema and interpreter;
- request templating can become an accidental programming language;
- complex signing, SDK-only APIs, custom pagination, streaming, and file workflows
  will exceed the format;
- debugging declarative transformations can be less direct than code.

Keep the first manifest version deliberately narrow. Prefer rejecting an
unsupported integration over growing an unsafe general-purpose expression
language.

### Option E: subprocess or WASM plugins

Invoke an executable through a versioned JSON protocol, or host a
capability-constrained WASM component. Send only one selected profile's
credentials for the requested operation, never credentials through command-line
arguments or ambient environment variables.

Pros:

- supports languages other than TypeScript;
- plugin crashes do not corrupt the Agentio process;
- narrows access to in-process memory;
- can become a real security boundary when paired with OS sandboxing or WASI
  capabilities.

Cons:

- highest protocol and lifecycle complexity;
- process startup overhead;
- interactive setup, browser OAuth, streaming, progress, binary files, and
  cancellation all need protocol definitions;
- same-user subprocesses remain capable of filesystem and network access unless
  explicitly sandboxed;
- packaging becomes platform-specific.

Defer this option until a real integration requires either an untrusted execution
model or a non-JavaScript language.

### Option F: companion tools using the hub

An external program can already consume scoped credentials from Agentio's hub
HTTP API. This is not a full plugin system, but it is a useful low-cost extension
path for Python, Go, shell, and private automation.

Pros:

- little or no Agentio loader work;
- language-neutral;
- reuses refresh, redaction, API-key scopes, and vault encryption;
- clean process boundary.

Cons:

- commands do not appear under `agentio`;
- no automatic help, docs, or skill generation;
- profile setup still needs Agentio or an additional generic auth flow;
- the hub must know the service lifecycle to redact refresh material safely.

Document this as an integration escape hatch rather than calling it a plugin.

## Recommended rollout

Each phase should leave typechecking, tests, bundled builds, and native builds
green. Existing command behavior should remain unchanged unless a phase explicitly
introduces a new external-plugin feature.

### Phase 0: open the service identity boundary

1. Introduce validated `ServiceId` handling at storage and protocol boundaries.
2. Change profile configuration to a string-keyed record.
3. Replace `ALL_SERVICES` consumers with either registry enumeration or stored
   profile enumeration, depending on intent.
4. Make profile-route parsing validate syntax first and registry support at the
   operation layer.
5. Add unknown-plugin vault preservation tests.
6. Define hub errors for unsupported plugins and plugin API versions.

Acceptance criteria:

- no central source type must change when a profile-capable service is added;
- unknown plugin profiles survive unrelated vault writes and import/export;
- existing service IDs and vault format remain compatible;
- the hub refuses credential delivery for unknown plugins.

### Phase 1: create one capability registry

1. Introduce `PluginRegistry` with lookup and filtered capability views.
2. Move credential lifecycle discovery behind the registry.
3. Make CLI creation accept a registry explicitly.
4. Project display name and branding into the admin UI rather than maintaining a
   second service table.
5. Validate plugin IDs, duplicate IDs, API versions, required metadata, refresh
   secret fields, and duplicate command paths.
6. Retain the existing static import list as the built-in loader.

Acceptance criteria:

- adding a built-in plugin requires one descriptor/registry entry, not edits to
  profile, refresh, status, skills, and UI catalogs;
- the daemon can access lifecycle capabilities without eagerly constructing the
  Commander command tree;
- invalid plugins fail at registry creation with actionable errors.

### Phase 2: move policy into the host

1. Add the public `SetupContext` and change new setup hooks to return credentials
   and a suggested profile name.
2. Make the host persist setup and reauthentication results.
3. Add declarative command specs and a Commander renderer.
4. Add host-level profile resolution and fresh-credential injection.
5. Enforce `access: 'write'` centrally before running the handler.
6. Standardize returned values, `--json`, stdin parsing, and error mapping.
7. Preserve legacy `registerCommands` through an internal adapter.

Migrate a small static-token service first, followed by a simple OAuth service.
Do not begin with Gmail, SQL, Revolut, or Falco because their command or auth
surfaces are atypically complex.

Acceptance criteria:

- a declarative plugin imports no Agentio implementation module;
- its setup flow cannot write the vault directly;
- write commands are refused for read-only profiles without handler cooperation;
- its commands appear correctly in help, docs, and generated skills;
- JSON output works without plugin-specific JSON printing.

### Phase 3: publish the authoring kit

1. Publish the types-only SDK.
2. Provide a starter repository and one complete example plugin.
3. Add `agentio plugin verify <path-or-package>` or an equivalent standalone
   verifier.
4. Provide test helpers with fake setup/run contexts and credential fixtures.
5. Document compatibility guarantees, package naming, ID reservation, security,
   error handling, output conventions, and release expectations.
6. Establish a support window for plugin API versions.

The verifier should check at least:

- API version and ID syntax;
- package-to-plugin namespace policy;
- duplicate command paths;
- descriptions and examples;
- option and argument consistency;
- refresh lifecycle completeness and non-empty `secretFields`;
- setup and validation return shapes;
- no runtime dependency on the types-only SDK;
- compatibility with the requested Agentio version.

Acceptance criteria:

- a separate repository can typecheck and test a plugin without cloning Agentio;
- conformance failures are actionable in plugin CI;
- the example plugin can be included by the static test loader.

### Phase 4: compile-time composition

1. Define and version the recipe schema.
2. Resolve plugins with a lockfile and integrity hashes.
3. Generate a static registry module from the resolved recipe.
4. Build normal bundled and native artifacts.
5. Record recipe and plugin provenance in the binary.
6. Report provenance through `agentio doctor` and a machine-readable command.
7. Publish a CI template before considering a hosted builder.

Acceptance criteria:

- the same recipe and lockfile produce the same plugin catalog;
- missing, incompatible, or invalid plugins fail before compilation;
- the resulting binary needs no plugin files at runtime;
- users can inspect plugin IDs, versions, sources, and integrity information.

### Phase 5: trusted runtime development loader

1. Load only explicitly configured paths or packages.
2. Validate all descriptors before mutating the command tree.
3. Add safe mode to disable external plugins.
4. Define precedence and collision rules between built-in, compiled, and runtime
   plugins.
5. Cache discovery metadata only if invalidation remains reliable.
6. Test source-mode and native-binary loading on every supported platform.

Acceptance criteria:

- a developer can iterate on a local plugin without rebuilding Agentio;
- one broken plugin produces an actionable diagnostic and can be bypassed with
  safe mode;
- runtime loading is clearly labeled as fully trusted;
- plugin dependencies resolve from the plugin package rather than relying on
  Agentio's embedded dependencies.

### Phase 6: declarative manifests

1. Define a small JSON schema for header-token authentication and basic HTTP
   commands.
2. Support request construction, response-path extraction, pagination primitives,
   and declarative table output.
3. Reuse the normal registry and command renderer.
4. Add schema validation and redacted diagnostic output.
5. Expand auth types only when concrete services require them.

Acceptance criteria:

- a simple REST service can be added without executable plugin code;
- invalid manifests fail before any credential or network access;
- the format cannot read arbitrary files or execute expressions;
- manifests receive the same read-only, profile, docs, skill, and JSON behavior
  as code plugins.

## Testing strategy

### Contract tests

- descriptor and API-version validation;
- duplicate IDs and command paths;
- namespace rules;
- required examples and descriptions;
- refresh lifecycle and secret-field requirements;
- setup, validation, reauthentication, and command return shapes.

### Host integration tests

- command registration order;
- profile auto-resolution and multiple-profile errors;
- local and remote credential retrieval;
- centralized read-only enforcement;
- setup and reauthentication persistence;
- refresh serialization and rotated-token persistence;
- help, docs, skill, JSON, and human rendering.

### Compatibility tests

- legacy built-in plugins through the adapter;
- vault round-trip with unknown plugin keys;
- plugin present, absent, then present again;
- hub/client plugin skew;
- unsupported plugin API versions;
- old Agentio with a newer plugin and newer Agentio with an older plugin.

### Distribution tests

- generated static registry typechecks;
- bundled and native builds include the selected catalog only;
- runtime loader works in source and native modes;
- plugin-local dependencies resolve correctly;
- safe mode starts when a plugin throws during import;
- recipe provenance matches the resolved lockfile.

### Security tests

- remote credentials never contain declared secret fields;
- unknown plugins fail closed at the credential endpoint;
- write handlers are never invoked for read-only profiles;
- credentials never appear in argv, logs, errors, or provenance data;
- manifest templates cannot read local files or inject arbitrary headers outside
  their declared request;
- malformed plugin output cannot corrupt the vault.

## Compatibility and versioning

`apiVersion` versions the host/plugin contract, not the plugin package. Agentio
should support a documented range and reject unsupported versions before
activation. Errors must state the plugin, its API version, the supported range,
and the minimum or maximum Agentio version when known.

Prefer additive changes within an API version. New optional context capabilities
may be added behind feature detection. Removing or changing behavior requires a
new API version and a migration guide.

The vault format should not need to change merely because plugin IDs become
open-ended; its profile and credential maps are already representable as string
keys. If plugin-specific state beyond credentials is later required, give each
plugin a namespaced state object rather than letting it add arbitrary top-level
vault fields.

## Operational and security policy

- Built-in and compile-time code plugins are trusted as part of the binary.
- Runtime code plugins are fully trusted and explicitly enabled.
- Manifest plugins are non-executable but still require URL, header, and secret
  handling validation.
- The hub runs refresh code, so every refreshable code plugin installed there is
  trusted server-side code.
- Plugin provenance must never imply sandboxing.
- Agentio should reserve the right to deny known-malicious package versions in a
  hosted builder, without making network access mandatory for local builds.
- Plugin removal never deletes its vault data automatically.

## Risks and mitigations

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Refresh tokens leak through the hub | High | Require `secretFields`; validate lifecycle; fail closed for unknown plugins |
| A runtime plugin steals credentials or files | High | Document full trust; explicit installs; safe mode; use manifests or sandboxed execution for untrusted code |
| Opening service IDs weakens type safety | Medium | Use validated/branded IDs at boundaries and derive built-in unions where useful |
| A missing plugin causes vault data loss | High | Preserve unknown map entries and add round-trip regression tests |
| Plugin import failure prevents CLI startup | Medium | Validate before registration; safe mode; isolate diagnostics by plugin |
| Commander changes break external plugins | Medium | Keep Commander out of the public SDK |
| Declarative manifests become a programming language | Medium | Keep schema narrow; reject unsupported cases; no general expression evaluator |
| Hub/client plugin sets diverge | Medium | Explicit unsupported-plugin responses and fail-closed credential delivery |
| Custom binaries are difficult to audit | Medium | Lockfile, integrity hashes, recipe hash, and `doctor` provenance output |
| API evolution strands plugins | Medium | Versioned contract, support window, conformance CI, migration guides |

## Open questions

1. Should `format` remain executable code, or should code plugins also use a
   declarative result schema whenever possible?
2. Should Google services remain separate plugins backed by a shared provider
   package, or should the contract support one package exporting multiple plugin
   descriptors?
3. What minimum API-version support window is sustainable for one maintainer?
4. Should profile setup be permitted on remote clients for all plugins, or only
   when the hub advertises the same plugin and contract version?
5. Which OAuth building blocks belong in `SetupContext` without turning Agentio
   into a generic identity framework?
6. Is runtime loading needed for end users, or is a development-only environment
   variable sufficient once compile-time recipes exist?
7. Does binary/file output need a first-class result type in API version 1?
8. Should package identity be required to match the plugin ID namespace, and how
   are organizations verified outside a hosted marketplace?

## Decision recommendation

Adopt the following sequence:

1. Finish the open service-ID and single-registry refactor.
2. Publish a declarative, types-only contract while retaining a built-in legacy
   adapter.
3. Prove the contract with in-tree contributions and an external example repo.
4. Make recipe-based compile-time composition the supported production path.
5. Add trusted runtime loading for development and private plugins.
6. Add a narrow manifest interpreter for simple HTTP services.
7. Build sandboxed subprocess or WASM support only in response to concrete user
   demand.

This path preserves Agentio's strongest properties—one inspectable binary, an
encrypted credential plane, deterministic behavior, and centralized policy—while
allowing other developers to build services on top of them without coupling to
the repository's internal modules.
