#!/usr/bin/env bun
import { Command } from 'commander';
import { registerAuthCommands } from './commands/auth';
import { registerGmailCommands } from './commands/gmail';

const program = new Command();

program
  .name('allcli')
  .description('Unified communication CLI')
  .version('0.1.0');

registerAuthCommands(program);
registerGmailCommands(program);

program.parse();
