export interface TodoCredentials {
  /** Normalised: scheme required, no trailing slash. */
  baseUrl: string;
  /** CLI bearer token from the device sign-in. */
  token: string;
  /** From /api/auth/me at setup time. */
  email: string;
  /** As returned at approval; informational, the server slides it on every use. */
  expiresAt: string;
}

export interface TodoMe {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
}

export interface TodoItem {
  id: string;
  title: string;
  notes: string | null;
  done: boolean;
  doneAt: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TodoTag {
  id: string;
  name: string;
  count: number;
}
