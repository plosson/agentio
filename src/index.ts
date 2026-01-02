#!/usr/bin/env bun
import { Command } from 'commander';
import { registerAuthCommands } from './commands/auth';

const program = new Command();

program
  .name('allcli')
  .description('Unified communication CLI')
  .version('0.1.0');

registerAuthCommands(program);

program.parse();
