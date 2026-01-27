// Polyfills for native binary compilation
// This must be imported BEFORE any code that uses protobufjs (e.g., Baileys)

import Long from 'long';
import protobuf from 'protobufjs';

// Fix for protobufjs Long support in Bun native binaries
// Without this, $util.Long.fromBits is undefined at runtime
protobuf.util.Long = Long;
protobuf.configure();
