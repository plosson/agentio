#!/usr/bin/env bun
import { Command } from 'commander';
import { registerGmailCommands } from './commands/gmail';
import { registerTelegramCommands } from './commands/telegram';
import { registerGChatCommands } from './commands/gchat';
import { registerJiraCommands } from './commands/jira';

const program = new Command();

program
  .name('agentio')
  .description('CLI for LLM agents to interact with communication and tracking services')
  .version('0.1.0');

registerGmailCommands(program);
registerTelegramCommands(program);
registerGChatCommands(program);
registerJiraCommands(program);

program.parse();
