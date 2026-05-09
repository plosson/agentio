import type { Command } from 'commander';

import { registerConfluenceCommands } from '../../src/commands/confluence';
import { registerDiscourseCommands } from '../../src/commands/discourse';
import { registerGCalCommands } from '../../src/commands/gcal';
import { registerGChatCommands } from '../../src/commands/gchat';
import { registerGDocsCommands } from '../../src/commands/gdocs';
import { registerGDriveCommands } from '../../src/commands/gdrive';
import { registerGitHubCommands } from '../../src/commands/github';
import { registerGmailCommands } from '../../src/commands/gmail';
import { registerGScriptCommands } from '../../src/commands/gscript';
import { registerGSheetsCommands } from '../../src/commands/gsheets';
import { registerGSlidesCommands } from '../../src/commands/gslides';
import { registerGTasksCommands } from '../../src/commands/gtasks';
import { registerJiraCommands } from '../../src/commands/jira';
import { registerRssCommands } from '../../src/commands/rss';
import { registerSlackCommands } from '../../src/commands/slack';
import { registerSqlCommands } from '../../src/commands/sql';
import { registerTelegramCommands } from '../../src/commands/telegram';
import { registerWhatsAppCommands } from '../../src/commands/whatsapp';

export const SERVICE_SLUGS = [
  'confluence',
  'discourse',
  'gcal',
  'gchat',
  'gdocs',
  'gdrive',
  'github',
  'gmail',
  'gscript',
  'gsheets',
  'gslides',
  'gtasks',
  'jira',
  'rss',
  'slack',
  'sql',
  'telegram',
  'whatsapp',
] as const;

export function registerAllCommands(program: Command): void {
  registerConfluenceCommands(program);
  registerDiscourseCommands(program);
  registerGCalCommands(program);
  registerGChatCommands(program);
  registerGDocsCommands(program);
  registerGDriveCommands(program);
  registerGitHubCommands(program);
  registerGmailCommands(program);
  registerGScriptCommands(program);
  registerGSheetsCommands(program);
  registerGSlidesCommands(program);
  registerGTasksCommands(program);
  registerJiraCommands(program);
  registerRssCommands(program);
  registerSlackCommands(program);
  registerSqlCommands(program);
  registerTelegramCommands(program);
  registerWhatsAppCommands(program);
}
