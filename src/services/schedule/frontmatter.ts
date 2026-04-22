import matter from 'gray-matter';
import type { FrontmatterConfig } from '../../types/schedule';
import {
  DEFAULT_MODEL,
  DEFAULT_PERMISSION_MODE,
  DEFAULT_SESSION_MODE,
} from '../../types/schedule';

export interface ParsedFrontmatter {
  config: Partial<FrontmatterConfig>;
  body: string;
}

/** Parse a raw .run.md string into {config, body}. Does not validate. */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const parsed = matter(raw);
  const data = (parsed.data ?? {}) as Partial<FrontmatterConfig>;
  return { config: data, body: parsed.content };
}

/**
 * Merge two partial configs (override wins), then fill in defaults for optional
 * fields. The schedule object is replaced wholesale (not deep-merged) because
 * changing the schedule type may invalidate previous keys.
 */
export function mergeConfig(
  base: Partial<FrontmatterConfig>,
  override: Partial<FrontmatterConfig>
): FrontmatterConfig {
  const schedule = override.schedule ?? base.schedule;
  if (!schedule) {
    throw new Error('mergeConfig: schedule is required on base or override');
  }
  return {
    schedule,
    model: override.model ?? base.model ?? DEFAULT_MODEL,
    permissionMode: override.permissionMode ?? base.permissionMode ?? DEFAULT_PERMISSION_MODE,
    sessionMode: override.sessionMode ?? base.sessionMode ?? DEFAULT_SESSION_MODE,
    enabled: override.enabled ?? base.enabled ?? true,
    ...(override.command !== undefined
      ? { command: override.command }
      : base.command !== undefined
      ? { command: base.command }
      : {}),
    ...(override.host !== undefined
      ? { host: override.host }
      : base.host !== undefined
      ? { host: base.host }
      : {}),
  };
}

/** Serialize a complete config + body back to a .run.md string. */
export function serializeFrontmatter(config: FrontmatterConfig, body: string): string {
  const data: Record<string, unknown> = {
    schedule: config.schedule,
    model: config.model,
    permissionMode: config.permissionMode,
    sessionMode: config.sessionMode,
    enabled: config.enabled,
  };
  if (config.command !== undefined) {
    data.command = config.command;
  }
  if (config.host !== undefined) {
    data.host = config.host;
  }
  return matter.stringify(body, data);
}
