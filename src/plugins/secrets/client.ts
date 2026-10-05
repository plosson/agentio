import type { ServiceClient, ValidationResult } from '../../types/service';
import { valuesOf } from './store';
import type { SecretsCredentials } from './types';

/** What `agentio status` checks: there is no remote service, so a profile is valid when its map can be read. */
export class SecretsClient implements ServiceClient {
  constructor(private readonly credentials: SecretsCredentials) {}

  async validate(): Promise<ValidationResult> {
    return { valid: true, info: secretCount(valuesOf(this.credentials).size) };
  }
}

export function secretCount(count: number): string {
  return `${count} secret${count === 1 ? '' : 's'}`;
}
