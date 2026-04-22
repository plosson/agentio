import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type { ScheduleState, StateFile } from '../../types/schedule';

function stateFilePath(folder: string): string {
  return join(folder, '.agentio', 'state.json');
}

async function ensureAgentioDir(folder: string): Promise<void> {
  const dir = join(folder, '.agentio');
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

export async function readState(folder: string): Promise<StateFile> {
  const path = stateFilePath(folder);
  if (!existsSync(path)) return {};
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export async function writeState(folder: string, state: StateFile): Promise<void> {
  await ensureAgentioDir(folder);
  await writeFile(stateFilePath(folder), JSON.stringify(state, null, 2));
}

export async function updateState(
  folder: string,
  id: string,
  patch: Partial<ScheduleState>,
): Promise<void> {
  const state = await readState(folder);
  state[id] = { ...(state[id] ?? {}), ...patch };
  await writeState(folder, state);
}
