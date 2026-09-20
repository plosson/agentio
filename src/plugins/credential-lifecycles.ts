import type { ServiceName } from '../types/config';
import { confluenceCredentialLifecycle } from './confluence/lifecycle';
import { dropboxCredentialLifecycle } from './dropbox/lifecycle';
import { googleCamelCredentialLifecycle, googleSnakeCredentialLifecycle } from './google/shared';
import { jiraCredentialLifecycle } from './jira/lifecycle';
import { revolutCredentialLifecycle } from './revolut/lifecycle';
import type { RegisteredCredentialLifecycle } from './types';

const PLUGIN_CREDENTIAL_LIFECYCLES: Partial<Record<ServiceName, RegisteredCredentialLifecycle>> = {
  confluence: confluenceCredentialLifecycle,
  dropbox: dropboxCredentialLifecycle,
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
  revolut: revolutCredentialLifecycle,
};

/** Lightweight lookup kept separate from the command registry to avoid import cycles. */
export function findCredentialLifecycle(service: ServiceName): RegisteredCredentialLifecycle | undefined {
  return PLUGIN_CREDENTIAL_LIFECYCLES[service];
}
