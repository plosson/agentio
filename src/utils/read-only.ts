import { CliError } from './errors';
import { isProfileReadOnly } from '../config/config-manager';
import type { ServiceName } from '../types/config';

/**
 * Enforce that a profile has write access for a given operation.
 * Throws a CliError if the profile is read-only.
 */
export async function enforceWriteAccess(
  service: ServiceName,
  profile: string,
  operation: string
): Promise<void> {
  const readOnly = await isProfileReadOnly(service, profile);
  if (readOnly) {
    throw new CliError(
      'PERMISSION_DENIED',
      `Cannot ${operation}: profile "${profile}" is read-only`,
      `To modify this profile's access: agentio ${service} profile update --profile ${profile} --no-read-only`
    );
  }
}
