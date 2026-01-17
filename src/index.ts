#!/usr/bin/env bun
import { Command } from 'commander';
import { registerGmailCommands } from './commands/gmail';
import { registerTelegramCommands } from './commands/telegram';
import { registerGChatCommands } from './commands/gchat';
import { registerJiraCommands } from './commands/jira';
import { registerSlackCommands } from './commands/slack';
import { registerRssCommands } from './commands/rss';
import { registerDiscourseCommands } from './commands/discourse';
import { registerSqlCommands } from './commands/sql';
import { registerUpdateCommand } from './commands/update';
import { registerConfigCommands } from './commands/config';
import { registerClaudeCommands } from './commands/claude';
import { registerStatusCommand } from './commands/status';

declare const BUILD_VERSION: string | undefined;

function getVersion(): string {
  if (typeof BUILD_VERSION !== 'undefined') {
    return BUILD_VERSION;
  }
  // Fallback for development mode
  return require('../package.json').version;
}

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
registerRssCommands(program);
registerDiscourseCommands(program);
registerSqlCommands(program);
registerUpdateCommand(program);
registerConfigCommands(program);
registerClaudeCommands(program);
registerStatusCommand(program);

program.parse();
