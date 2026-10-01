export interface NotesCredentials {
  /** The apple-notes-api server, such as https://mac-mini.example.ts.net. */
  baseUrl: string;
  /** The server's NOTES_API_KEY, sent as a Bearer token. */
  apiKey: string;
}

export interface NotesFolder {
  id: string;
  name: string;
  account: string | null;
}

export interface NoteSummary {
  id: string;
  name: string;
  folder: string | null;
  created: string | null;
  modified: string | null;
}

export interface Note extends NoteSummary {
  /** Plain text, HTML stripped by the server. */
  body: string;
  bodyHtml: string;
  /** The server's best-effort conversion of the HTML. */
  bodyMarkdown: string;
}

export interface NotesListOptions {
  folder?: string;
  query?: string;
  limit?: number;
}

export interface NoteInput {
  name?: string;
  /** HTML; the client converts Markdown and text before sending. */
  body?: string;
  folder?: string;
}

/** What the server says about itself on `GET /health`. */
export interface NotesHealth {
  ok: boolean;
  version: string;
  platform: string;
}

/** How a body given to `create` or `update` is written. */
export type NoteBodyFormat = 'markdown' | 'html' | 'text';

/** How `get` shows a note's body. */
export type NoteOutputFormat = 'markdown' | 'text' | 'html';
