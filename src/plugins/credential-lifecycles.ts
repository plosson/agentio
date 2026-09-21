import type { ServiceName } from '../types/config';
import type { RegisteredCredentialLifecycle } from './types';
import { getPluginRegistry } from './registry';
import { isDeclarativePlugin } from './types';

/** Lightweight lookup kept separate from the command registry to avoid import cycles. */
export function findCredentialLifecycle(service: ServiceName): RegisteredCredentialLifecycle | undefined {
  const plugin = getPluginRegistry().find(service);
  if (!plugin) return undefined;
  if (!isDeclarativePlugin(plugin)) return plugin.credentialLifecycle;
  if (!plugin.profile?.refresh) return undefined;
  return { ...plugin.profile.refresh, refresh: plugin.profile.refresh.run };
}
