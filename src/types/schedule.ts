export type ScheduleType = 'manual' | 'daily' | 'weekly' | 'monthly' | 'interval';

export interface Schedule {
  type: ScheduleType;
  hour?: number;        // 0-23 (daily/weekly/monthly)
  minute?: number;      // 0-59 (daily/weekly/monthly)
  weekdays?: number[];  // 1=Mon..7=Sun (weekly)
  day?: number;         // 1-31 (monthly)
  intervalMinutes?: number; // interval
}

export type Model = 'opus' | 'sonnet' | 'haiku';
export type PermissionMode = 'default' | 'bypassPermissions' | 'plan' | 'acceptEdits';
export type SessionMode = 'new' | 'resume' | 'fork';

export interface FrontmatterConfig {
  schedule: Schedule;
  model: Model;
  permissionMode: PermissionMode;
  sessionMode: SessionMode;
  enabled: boolean;
  command?: string; // optional command override
}

export interface ScheduleState {
  sessionId?: string;
  lastRunAt?: string;    // ISO
  lastExitCode?: number;
}

export type StateFile = Record<string, ScheduleState>;

/** Parsed .run.md file. */
export interface ScheduleFile {
  config: FrontmatterConfig;
  body: string;
  /** absolute path to the .run.md file on disk */
  filePath: string;
  /** id derived from basename (without ".run.md") */
  id: string;
}

export const DEFAULT_MODEL: Model = 'sonnet';
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'bypassPermissions';
export const DEFAULT_SESSION_MODE: SessionMode = 'new';
