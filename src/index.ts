#!/usr/bin/env bun
// Polyfills must be imported first (before any code that uses protobufjs)
import './polyfills';
import { Command } from 'commander';
// Services (alphabetical)
import { registerDiscourseCommands } from './commands/discourse';
import { registerGCalCommands } from './commands/gcal';
import { registerGChatCommands } from './commands/gchat';
import { registerGDocsCommands } from './commands/gdocs';
import { registerGDriveCommands } from './commands/gdrive';
import { registerGitHubCommands } from './commands/github';
import { registerGmailCommands } from './commands/gmail';
import { registerGTasksCommands } from './commands/gtasks';
import { registerJiraCommands } from './commands/jira';
import { registerRssCommands } from './commands/rss';
import { registerSlackCommands } from './commands/slack';
import { registerSqlCommands } from './commands/sql';
import { registerTelegramCommands } from './commands/telegram';
import { registerWhatsAppCommands } from './commands/whatsapp';

// Agentio utilities
import { registerClaudeCommands } from './commands/claude';
import { registerConfigCommands } from './commands/config';
import { registerDocsCommand } from './commands/docs';
import { registerGatewayCommands } from './commands/gateway';
import { registerStatusCommand } from './commands/status';
import { registerUpdateCommand } from './commands/update';

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

// Services (alphabetical)
registerDiscourseCommands(program);
registerGCalCommands(program);
registerGChatCommands(program);
registerGDocsCommands(program);
registerGDriveCommands(program);
registerGitHubCommands(program);
registerGmailCommands(program);
registerGTasksCommands(program);
registerJiraCommands(program);
registerRssCommands(program);
registerSlackCommands(program);
registerSqlCommands(program);
registerTelegramCommands(program);
registerWhatsAppCommands(program);

// Agentio utilities
registerClaudeCommands(program);
registerConfigCommands(program);
registerDocsCommand(program);
registerGatewayCommands(program);
registerStatusCommand(program);
registerUpdateCommand(program);

program.parse();
