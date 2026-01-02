import type { ServiceName } from '../types/config';

export interface SuccessResponse<T = unknown> {
  success: true;
  service: ServiceName;
  command: string;
  profile: string;
  data: T;
  timestamp: string;
}

export function success<T>(
  service: ServiceName,
  command: string,
  profile: string,
  data: T
): void {
  const response: SuccessResponse<T> = {
    success: true,
    service,
    command,
    profile,
    data,
    timestamp: new Date().toISOString(),
  };

  console.log(JSON.stringify(response, null, 2));
}
