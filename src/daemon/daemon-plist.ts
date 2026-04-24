import { DAEMON_LAUNCHD_LABEL } from './labels';

export interface DaemonPlistInput {
  binaryPath: string;
  logPath: string;
  home: string;
  /** Extra PATH entries to prepend (e.g. /opt/homebrew/bin). Optional. */
  extraPath?: string;
}

const DEFAULT_PATH = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

export function buildDaemonPlist(input: DaemonPlistInput): Record<string, unknown> {
  const path = input.extraPath
    ? `${input.extraPath}:${DEFAULT_PATH}`
    : DEFAULT_PATH;

  return {
    Label: DAEMON_LAUNCHD_LABEL,
    ProgramArguments: [input.binaryPath, 'daemon', 'start', '--foreground'],
    RunAtLoad: true,
    KeepAlive: true,
    StandardOutPath: input.logPath,
    StandardErrorPath: input.logPath,
    WorkingDirectory: input.home,
    EnvironmentVariables: {
      HOME: input.home,
      PATH: path,
    },
  };
}
