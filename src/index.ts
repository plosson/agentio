#!/usr/bin/env bun
import { Command } from 'commander';
import { registerGmailCommands } from './commands/gmail';
import { registerTelegramCommands } from './commands/telegram';
import { registerGChatCommands } from './commands/gchat';
import { registerJiraCommands } from './commands/jira';
import { registerSlackCommands } from './commands/slack';
import { registerUpdateCommand } from './commands/update';
import { registerConfigCommands } from './commands/config';
import { registerSkillCommands } from './commands/skill';

declare const BUILD_VERSION: string | undefined;

const getVersion = (): string => {
  if (typeof BUILD_VERSION !== 'undefined') {
    return BUILD_VERSION;
  }
  // Fallback for development mode
  return require('../package.json').version;
};

const program = new Command();

program
  .name('agentio')
  .description('CLI for LLM agents to interact with communication and tracking services')
  .version(getVersion());

registerGmailCommands(program);
registerTelegramCommands(program);
registerGChatCommands(program);
registerJiraCommands(program);
registerSlackCommands(program);
registerUpdateCommand(program);
registerConfigCommands(program);
registerSkillCommands(program);

program.parse();
