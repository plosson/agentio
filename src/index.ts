#!/usr/bin/env bun
import { createProgram } from './cli';
import { loadExternalPlugins } from './plugins/external-loader';
import { DEFAULT_PLUGIN_REGISTRY } from './plugins/registry';
import { PluginRegistry } from './plugins/plugin-registry';

async function main(): Promise<void> {
  const external = await loadExternalPlugins();
  const registry = external.length === 0
    ? DEFAULT_PLUGIN_REGISTRY
    : new PluginRegistry([...DEFAULT_PLUGIN_REGISTRY.plugins, ...external]);
  const program = createProgram(registry);
  await program.parseAsync();
}

void main();
