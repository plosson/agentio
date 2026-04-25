import type { Config, WatchedFolder } from '../types/config';

export function addWatchedFolder(
  config: Config,
  path: string,
  host: string | undefined,
  addedAt: number,
): Config {
  const daemon = config.daemon ?? {};
  const scheduler = daemon.scheduler;
  const folders: WatchedFolder[] = scheduler?.watchedFolders ?? [];
  if (folders.find((f) => f.path === path)) return config;
  const newFolder: WatchedFolder = { path, addedAt, ...(host ? { host } : {}) };
  return {
    ...config,
    daemon: {
      ...daemon,
      scheduler: { ...scheduler, watchedFolders: [...folders, newFolder] },
    },
  };
}

export function removeWatchedFolder(config: Config, path: string): Config {
  const daemon = config.daemon ?? {};
  const scheduler = daemon.scheduler;
  const folders: WatchedFolder[] = scheduler?.watchedFolders ?? [];
  const next = folders.filter((f) => f.path !== path);
  return {
    ...config,
    daemon: {
      ...daemon,
      scheduler: { ...scheduler, watchedFolders: next },
    },
  };
}
