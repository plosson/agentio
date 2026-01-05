#!/usr/bin/env bun
import { Command } from 'commander';
import { registerGmailCommands } from './commands/gmail';
import { registerTelegramCommands } from './commands/telegram';
import { registerGChatCommands } from './commands/gchat';
import { registerJiraCommands } from './commands/jira';
import { registerSlackCommands } from './commands/slack';
import { registerUpdateCommand } from './commands/update';
import pkg from '../package.json';

const program = new Command();

program
  .name('agentio')
  .description('CLI for LLM agents to interact with communication and tracking services')
  .version(pkg.version);

registerGmailCommands(program);
registerTelegramCommands(program);
registerGChatCommands(program);
registerJiraCommands(program);
registerSlackCommands(program);
registerUpdateCommand(program);

program.parse();
