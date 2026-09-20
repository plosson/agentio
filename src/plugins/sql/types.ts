export interface SqlCredentials {
  url: string;
  displayName?: string;
}

export interface SqlQueryOptions {
  query: string;
  limit?: number;
}

export interface SqlQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}
