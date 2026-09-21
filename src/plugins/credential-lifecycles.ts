import type { ServiceName } from '../types/config';
import type { RegisteredCredentialLifecycle } from './types';
import { DEFAULT_PLUGIN_REGISTRY } from './registry';

/** Lightweight lookup kept separate from the command registry to avoid import cycles. */
export function findCredentialLifecycle(service: ServiceName): RegisteredCredentialLifecycle | undefined {
  return DEFAULT_PLUGIN_REGISTRY.find(service)?.credentialLifecycle;
}
