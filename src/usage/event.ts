/**
 * One credential use: a command (or a remote agent's request) read one
 * profile's credentials. Every value is checked here, whether it came from
 * this machine or from a client's header: the store and the reports trust
 * nothing else.
 */

export const UNKNOWN = 'unknown';
export const INVALID = 'invalid';
/** Key id and name of an event recorded by a local CLI, which has no key. */
export const LOCAL_KEY = 'local';

/** Headers a remote CLI sends with its credential request; lowercase, as `Headers.get` matches. */
export const USAGE_HEADERS = {
  command: 'x-agentio-command',
  host: 'x-agentio-host',
  version: 'x-agentio-version',
} as const;

export interface UsageEvent {
  ts: number;
  service: string;
  profile: string;
  command: string;
  host: string;
  keyId: string;
  keyName: string;
  outcome: string;
  refreshed: boolean | null;
  version: string;
}

export interface UsageInput {
  ts?: number;
  service: string;
  profile: string;
  command?: string | null;
  host?: string | null;
  keyId: string;
  keyName: string;
  outcome: string;
  refreshed?: boolean | null;
  version?: string | null;
}

const COMMAND = /^[a-z0-9 -]{1,100}$/;
const HOST = /^[A-Za-z0-9.-]{1,64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
// Profile and key names are the owner's: anything printable, bounded.
const LABEL = /^[\x20-\x7e]{1,128}$/;
const OUTCOME = /^[a-z_]{1,40}$/;

function field(value: string | null | undefined, valid: (v: string) => boolean, otherwise: string): string {
  if (value === null || value === undefined || value === '') return UNKNOWN;
  return valid(value) ? value : otherwise;
}

const matches = (pattern: RegExp) => (v: string) => pattern.test(v);

export function normalizeEvent(input: UsageInput): UsageEvent {
  return {
    ts: input.ts ?? Date.now(),
    service: field(input.service, matches(LABEL), INVALID),
    profile: field(input.profile, matches(LABEL), INVALID),
    command: field(input.command, matches(COMMAND), INVALID),
    host: field(input.host, matches(HOST), INVALID),
    keyId: field(input.keyId, matches(LABEL), INVALID),
    keyName: field(input.keyName, matches(LABEL), INVALID),
    outcome: OUTCOME.test(input.outcome) ? input.outcome : 'error',
    refreshed: input.refreshed ?? null,
    version: field(input.version, (v) => v.length <= 64 && VERSION.test(v), UNKNOWN),
  };
}
