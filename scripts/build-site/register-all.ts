import type { Command } from 'commander';
import { registerServiceCommands, SERVICE_REGISTRY } from '../../src/plugins/registry';

export const SERVICE_SLUGS = SERVICE_REGISTRY.map(({ id }) => id);

export function registerAllCommands(program: Command): void {
  registerServiceCommands(program);
}
