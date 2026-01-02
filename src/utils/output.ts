import type { ServiceName } from '../types/config';

export interface SuccessResponse<T = unknown> {
  success: true;
  service: ServiceName;
  command: string;
  profile: string;
  data: T;
  timestamp: string;
}

// Replacer that omits empty arrays, null, undefined, and empty strings
function compactReplacer(_key: string, value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value) && value.length === 0) return undefined;
  if (value === '') return undefined;
  return value;
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

  // Compact JSON: no indentation, omit empty fields
  console.log(JSON.stringify(response, compactReplacer));
}

// Output raw text (for body-only mode)
export function raw(text: string): void {
  console.log(text);
}
