import { Command } from 'commander';
import { handleError } from '../utils/errors';

export function registerScheduleCommands(program: Command): void {
  const schedule = program
    .command('schedule')
    .description('Schedule prompts to run on a cron-like schedule via launchd');

  schedule.command('add').description('Add or update a schedule (writes frontmatter + installs plist)')
    .argument('<file>', 'Path to the .run.md file (must end in .run.md)')
    .option('--folder <path>', 'Folder containing the file (default: CWD)')
    .option('--schedule <type>', 'manual | daily | weekly | monthly | interval')
    .option('--at <HH:MM>', 'Time of day shortcut for --hour/--minute')
    .option('--hour <n>', 'Hour 0-23')
    .option('--minute <n>', 'Minute 0-59')
    .option('--weekdays <list>', 'Weekly: mon,wed,fri or 1,3,5')
    .option('--day <n>', 'Monthly: day of month 1-31')
    .option('--interval <dur>', 'Interval: 30m, 2h, 1h30m')
    .option('--model <m>', 'opus | sonnet | haiku')
    .option('--permission-mode <m>', 'default | bypass | plan | accept-edits')
    .option('--session-mode <m>', 'new | resume | fork')
    .option('--command <cmd>', 'Command override (ignores model/permissionMode/sessionMode)')
    .option('--disabled', 'Create with enabled: false')
    .option('-y, --yes', 'Non-interactive; error if required flags missing')
    .action(async () => { try { throw new Error('not implemented'); } catch (e) { handleError(e); } });

  schedule.command('list').description('List installed schedules')
    .option('--folder <path>', 'Filter to one folder')
    .action(async () => { try { throw new Error('not implemented'); } catch (e) { handleError(e); } });

  schedule.command('sync').description('Reconcile launchd plists with *.run.md files')
    .option('--folder <path>', 'Folder to sync (default: CWD)')
    .option('-y, --yes', 'Non-interactive')
    .action(async () => { try { throw new Error('not implemented'); } catch (e) { handleError(e); } });

  schedule.command('remove').description('Delete a schedule and uninstall its plist')
    .argument('<id>', 'Schedule id')
    .option('--folder <path>', 'Folder (default: CWD)')
    .action(async () => { try { throw new Error('not implemented'); } catch (e) { handleError(e); } });

  schedule.command('run').description('Run a schedule immediately')
    .argument('<id>', 'Schedule id')
    .option('--folder <path>', 'Folder (default: CWD)')
    .option('--from-launchd', 'Internal: flag set by launchd-triggered invocations')
    .action(async () => { try { throw new Error('not implemented'); } catch (e) { handleError(e); } });

  schedule.command('show').description('Show a schedule and next run times')
    .argument('<id>', 'Schedule id')
    .option('--folder <path>', 'Folder (default: CWD)')
    .action(async () => { try { throw new Error('not implemented'); } catch (e) { handleError(e); } });

  schedule.command('runs').description('List past runs for a schedule')
    .argument('<id>', 'Schedule id')
    .option('--folder <path>', 'Folder (default: CWD)')
    .action(async () => { try { throw new Error('not implemented'); } catch (e) { handleError(e); } });
}
