// Polyfills for native binary compilation
// This must be imported BEFORE any code that uses protobufjs (e.g., Baileys)

import Long from 'long';

// Fix for protobufjs Long support in Bun native binaries.
// protobufjs/minimal uses inquire("long") with eval-based require that fails in Bun bundles.
// It falls back to checking global.Long (util/minimal.js:181), so we set it on globalThis
// BEFORE any protobufjs code initializes (WAProto evaluates $util.Long at module load time).
(globalThis as any).Long = Long;
