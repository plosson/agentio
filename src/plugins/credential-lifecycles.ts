import type { ServiceName } from '../types/config';
import { googleCamelCredentialLifecycle, googleSnakeCredentialLifecycle } from './google/shared';
import { jiraCredentialLifecycle } from './jira/lifecycle';
import type { CredentialLifecycle } from './types';

const PLUGIN_CREDENTIAL_LIFECYCLES: Partial<Record<ServiceName, CredentialLifecycle>> = {
  gcal: googleSnakeCredentialLifecycle,
  gchat: googleCamelCredentialLifecycle,
  gdocs: googleCamelCredentialLifecycle,
  gdrive: googleCamelCredentialLifecycle,
  gmail: googleSnakeCredentialLifecycle,
  gsheets: googleCamelCredentialLifecycle,
  gslides: googleCamelCredentialLifecycle,
  gscript: googleCamelCredentialLifecycle,
  gtasks: googleSnakeCredentialLifecycle,
  jira: jiraCredentialLifecycle,
};

/** Lightweight lookup kept separate from the command registry to avoid import cycles. */
export function findCredentialLifecycle(service: ServiceName): CredentialLifecycle | undefined {
  return PLUGIN_CREDENTIAL_LIFECYCLES[service];
}
