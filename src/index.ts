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
import { registerGSheetsCommands } from './commands/gsheets';
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
import { registerMcpCommands } from './commands/mcp';
import { registerDocsCommand } from './commands/docs';
import { registerDaemonCommands } from './commands/daemon';
import { registerDoctorCommand } from './commands/doctor';
import { registerProfileCommands } from './commands/profile';
import { registerReauthCommand } from './commands/reauth';
import { registerScheduleCommands } from './commands/schedule';
import { registerServerCommands } from './commands/server';
import { registerSetupCommand } from './commands/setup';
import { registerStatusCommand } from './commands/status';
import { registerUpdateCommand } from './commands/update';
import { vaultExists } from './vault/vault';
import { applyGroupedHelp } from './utils/help-formatter';

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
registerGSheetsCommands(program);
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
registerMcpCommands(program);
registerDocsCommand(program);
registerDaemonCommands(program);
registerDaemonCommands(program, { base: 'gateway', deprecated: true });
registerDoctorCommand(program);
registerProfileCommands(program);
registerReauthCommand(program);
registerScheduleCommands(program);
registerServerCommands(program);
registerSetupCommand(program);
registerStatusCommand(program);
registerUpdateCommand(program);

const BYPASS_COMMANDS = new Set(['setup', 'docs', 'update', 'doctor']);

program.hook('preAction', async (_thisCommand, actionCommand) => {
  const name = actionCommand.name();
  const parent = actionCommand.parent?.name();
  // Top-level bypass commands OR any subcommand of a bypass command.
  if (BYPASS_COMMANDS.has(name) || (parent && BYPASS_COMMANDS.has(parent))) {
    return;
  }

  if (!(await vaultExists())) {
    console.error('Error [VAULT_NOT_CONFIGURED]: No vault configured');
    console.error('Suggestion: Run: agentio setup');
    process.exit(2);
  }
});

applyGroupedHelp(program, {
  'Setup': ['setup', 'status', 'doctor', 'update'],
  'Services': [
    'gmail', 'gdocs', 'gdrive', 'gcal', 'gchat', 'gtasks', 'gsheets',
    'github', 'jira', 'slack', 'telegram', 'whatsapp', 'discourse', 'rss', 'sql',
  ],
  'Automation': ['schedule', 'daemon'],
  'Advanced': ['config', 'mcp', 'server', 'profile'],
});

// Show help (exit 0) when no command is provided
program.action(() => {
  program.help();
});

program.parse();
